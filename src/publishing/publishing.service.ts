import { Injectable, Logger } from '@nestjs/common';
import { AccountStatus, AttemptStatus, MediaType, Prisma, PublishJobStatus, VariantStatus } from '@prisma/client';
import { ConnectorAccountsService } from '../connectors/connector-accounts.service';
import { ConnectorError } from '../connectors/core/connector-error';
import { ConnectorRegistryService } from '../connectors/core/connector-registry.service';
import { PostMedia, PostPayload } from '../connectors/core/connector.types';
import { ErrorCode } from '../common/exceptions/application.exception';
import { CampaignStatusService } from '../campaigns/campaign-status.service';
import { PrismaService } from '../database/prisma.service';
import { RedisService } from '../queue/redis.service';
import { DeadLetterDeliveryError } from '../queue/queue.types';
import { sha256 } from '../common/utils/crypto.utils';

const RETRY_DELAYS_SECONDS = [30, 120, 600] as const;
const FINGERPRINT_LOCK_TTL_MS = 10 * 60_000;

export function publishFingerprintLockKey(platformAccountId: string, contentHash: string): string {
  return `lock:publish-fingerprint:${sha256(`${platformAccountId}:${contentHash}`)}`;
}

export function assertVariantApproved(status: VariantStatus): void {
  if (status !== VariantStatus.APPROVED) {
    throw new ConnectorError(
      ErrorCode.PLATFORM_CONTENT_REJECTED,
      'Content variant is no longer approved for publishing',
      false,
    );
  }
}

interface PublishMediaAsset {
  id: string;
  type: MediaType;
  publicUrl: string | null;
  mimeType: string;
}

export function collectPublishMedia(
  contentMedia: readonly PublishMediaAsset[],
  variantMedia: readonly PublishMediaAsset[],
): PostMedia[] {
  const seen = new Set<string>();
  return [...contentMedia, ...variantMedia]
    .filter((asset) => {
      if (!asset.publicUrl || seen.has(asset.id)) return false;
      seen.add(asset.id);
      return true;
    })
    .map((asset) => ({
      type: asset.type.toLowerCase() as PostMedia['type'],
      url: asset.publicUrl!,
      mimeType: asset.mimeType,
    }));
}

export function assertPublishAccountReady(account: {
  enabled: boolean;
  status: AccountStatus;
  platform: { enabled: boolean };
}): void {
  if (!account.platform.enabled) {
    throw new ConnectorError(ErrorCode.CONNECTOR_NEEDS_ACTION, 'Platform is disabled by an administrator', false);
  }
  if (!account.enabled || account.status === AccountStatus.DISABLED) {
    throw new ConnectorError(ErrorCode.CONNECTOR_NEEDS_ACTION, 'Platform account is disabled', false);
  }
  if (account.status !== AccountStatus.CONNECTED) {
    throw new ConnectorError(ErrorCode.PLATFORM_AUTH_FAILED, 'Platform account is not connected and ready to publish', false);
  }
}

@Injectable()
export class PublishingService {
  private readonly logger = new Logger(PublishingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly connectorAccounts: ConnectorAccountsService,
    private readonly registry: ConnectorRegistryService,
    private readonly campaignStatus: CampaignStatusService,
  ) {}

  async process(jobId: string): Promise<void> {
    const lockKey = `lock:publish:${jobId}`;
    const lock = await this.redis.acquireLock(lockKey, 120_000);
    if (!lock) return;
    try { await this.processLocked(jobId); }
    finally { await this.redis.releaseLock(lockKey, lock); }
  }

  private async processLocked(jobId: string): Promise<void> {
    const job = await this.prisma.publishJob.findUniqueOrThrow({
      where: { id: jobId },
      include: {
        publishedPost: true,
        platformAccount: { include: { platform: true } },
        target: {
          include: {
            contentVariant: { include: { content: { include: { media: true } }, media: true } },
            campaign: true,
          },
        },
      },
    });
    if (job.publishedPost || job.status === PublishJobStatus.PUBLISHED || job.status === PublishJobStatus.CANCELLED) {
      await this.campaignStatus.refresh(job.target.campaignId);
      return;
    }
    const overrides = this.asRecord(job.target.overrides);
    let fingerprintLock: { key: string; token: string } | undefined;
    if (overrides.allowDuplicate !== true) {
      const key = publishFingerprintLockKey(
        job.platformAccountId,
        job.target.contentVariant.content.contentHash,
      );
      const token = await this.redis.acquireLock(key, FINGERPRINT_LOCK_TTL_MS);
      if (!token) {
        await this.prisma.publishJob.update({
          where: { id: job.id },
          data: {
            status: PublishJobStatus.RETRY,
            nextAttemptAt: new Date(Date.now() + 30_000),
            lastErrorCode: ErrorCode.PUBLISH_DUPLICATED,
            lastErrorMessage: 'A matching publish is already in progress; duplicate check will retry',
          },
        });
        return;
      }
      fingerprintLock = { key, token };
    }
    try {
    if (overrides.allowDuplicate !== true) {
      const duplicate = await this.prisma.publishedPost.findFirst({
        where: {
          platformAccountId: job.platformAccountId,
          job: { target: { contentVariant: { content: { contentHash: job.target.contentVariant.content.contentHash } } } },
        },
        select: { id: true },
      });
      if (duplicate) {
        await this.prisma.publishJob.update({ where: { id: job.id }, data: { status: PublishJobStatus.POSSIBLE_DUPLICATE, lastErrorCode: ErrorCode.PUBLISH_DUPLICATED, lastErrorMessage: 'Matching content was already published to this account' } });
        await this.campaignStatus.refresh(job.target.campaignId);
        return;
      }
    }
    const platform = job.platformAccount.platform.slug;
    const rate = await this.redis.consumeRateLimit(`rate_limit:${platform}:${job.platformAccountId}`, this.numberSetting(job.platformAccount.settings, 'rateLimit', 10), this.numberSetting(job.platformAccount.settings, 'rateWindowSeconds', 60));
    if (!rate.allowed) {
      await this.prisma.publishJob.update({ where: { id: job.id }, data: { status: PublishJobStatus.RETRY, nextAttemptAt: new Date(Date.now() + 60_000), lastErrorCode: ErrorCode.PLATFORM_RATE_LIMITED, lastErrorMessage: 'Local per-account rate limit reached' } });
      return;
    }
    const attemptNumber = job.attemptCount + 1;
    const attempt = await this.prisma.$transaction(async (transaction) => {
      await transaction.publishJob.update({ where: { id: job.id }, data: { status: PublishJobStatus.PUBLISHING, lockedAt: new Date(), attemptCount: attemptNumber } });
      return transaction.publishAttempt.create({ data: { publishJobId: job.id, attemptNumber, status: AttemptStatus.STARTED, requestMetadata: { platform, idempotencyKey: job.idempotencyKey } } });
    });
    let deadLetter = false;
    try {
      assertPublishAccountReady(job.platformAccount);
      const { account } = await this.connectorAccounts.load(job.platformAccountId);
      const connector = this.registry.get(platform);
      const variant = job.target.contentVariant;
      assertVariantApproved(variant.status);
      const payload: PostPayload = {
        title: variant.title ?? undefined,
        body: variant.body,
        summary: variant.summary ?? undefined,
        hashtags: variant.hashtags,
        canonicalUrl: variant.content.canonicalUrl ?? undefined,
        media: collectPublishMedia(variant.content.media, variant.media),
        idempotencyKey: job.idempotencyKey,
      };
      await connector.validate(payload);
      const result = await connector.publish(account, payload);
      await this.prisma.$transaction(async (transaction) => {
        await transaction.publishAttempt.update({ where: { id: attempt.id }, data: { status: AttemptStatus.SUCCEEDED, finishedAt: new Date(), responseMetadata: (result.metadata ?? {}) as Prisma.InputJsonObject } });
        if (result.status === 'NEEDS_ACTION') {
          await transaction.publishJob.update({ where: { id: job.id }, data: { status: PublishJobStatus.NEEDS_ACTION, lockedAt: null } });
        } else {
          await transaction.publishedPost.create({ data: { publishJobId: job.id, platformAccountId: job.platformAccountId, externalPostId: result.externalId, url: result.url, metadata: (result.metadata ?? {}) as Prisma.InputJsonObject } });
          await transaction.publishJob.update({ where: { id: job.id }, data: { status: result.status === 'PROCESSING' ? PublishJobStatus.PROCESSING : PublishJobStatus.PUBLISHED, lockedAt: null, lastErrorCode: null, lastErrorMessage: null } });
        }
      });
      this.logger.log(JSON.stringify({ jobId, campaignId: job.target.campaignId, platform, platformAccountId: job.platformAccountId, attempt: attemptNumber, status: result.status }));
    } catch (error) {
      deadLetter = await this.handleFailure(job.id, attempt.id, attemptNumber, job.maxAttempts, job.platformAccountId, error);
    }
    await this.campaignStatus.refresh(job.target.campaignId);
    if (deadLetter) throw new DeadLetterDeliveryError(`Publish job ${job.id} failed permanently`);
    } finally {
      if (fingerprintLock) {
        await this.redis.releaseLock(fingerprintLock.key, fingerprintLock.token);
      }
    }
  }

  private async handleFailure(jobId: string, attemptId: string, attemptNumber: number, maxAttempts: number, accountId: string, error: unknown): Promise<boolean> {
    const connectorError = error instanceof ConnectorError ? error : new ConnectorError(ErrorCode.PLATFORM_API_ERROR, 'Unexpected connector failure', true);
    const canRetry = connectorError.retryable && attemptNumber < maxAttempts;
    const delay = connectorError.retryAfterSeconds ?? RETRY_DELAYS_SECONDS[Math.min(attemptNumber - 1, RETRY_DELAYS_SECONDS.length - 1)] ?? 600;
    await this.prisma.$transaction([
      this.prisma.publishAttempt.update({ where: { id: attemptId }, data: { status: canRetry ? AttemptStatus.RETRYABLE_FAILURE : AttemptStatus.PERMANENT_FAILURE, errorCode: connectorError.code, errorMessage: connectorError.message, finishedAt: new Date() } }),
      this.prisma.publishJob.update({ where: { id: jobId }, data: { status: canRetry ? PublishJobStatus.RETRY : PublishJobStatus.FAILED, nextAttemptAt: canRetry ? new Date(Date.now() + delay * 1000) : null, lockedAt: null, lastErrorCode: connectorError.code, lastErrorMessage: connectorError.message } }),
    ]);
    if ([ErrorCode.PLATFORM_TOKEN_EXPIRED, ErrorCode.PLATFORM_AUTH_FAILED].includes(connectorError.code)) {
      await this.prisma.platformAccount.update({ where: { id: accountId }, data: { status: AccountStatus.RECONNECT_REQUIRED } });
    }
    this.logger.warn(JSON.stringify({ jobId, attempt: attemptNumber, status: canRetry ? 'RETRY' : 'FAILED', errorCode: connectorError.code }));
    return !canRetry;
  }

  private asRecord(value: unknown): Record<string, unknown> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
  private numberSetting(value: unknown, key: string, fallback: number): number {
    const setting = this.asRecord(value)[key];
    return typeof setting === 'number' && Number.isFinite(setting) && setting > 0 ? Math.floor(setting) : fallback;
  }

}
