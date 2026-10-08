import { Injectable, Logger } from '@nestjs/common';
import { AccountStatus, AttemptStatus, MediaType, Prisma, PublishJobStatus, VariantStatus } from '@prisma/client';
import { ConnectorAccountsService } from '../connectors/connector-accounts.service';
import { ConnectorError } from '../connectors/core/connector-error';
import { ConnectorRegistryService } from '../connectors/core/connector-registry.service';
import { PostMedia, PostPayload, PublishResult } from '../connectors/core/connector.types';
import { ErrorCode } from '../common/exceptions/application.exception';
import { CampaignStatusService } from '../campaigns/campaign-status.service';
import { PrismaService } from '../database/prisma.service';
import { RedisService } from '../queue/redis.service';
import { DeadLetterDeliveryError } from '../queue/queue.types';
import { sha256 } from '../common/utils/crypto.utils';
import { WORKER_CRASH_UNCERTAIN_RESULT_CODE } from './publishing.constants';

const RETRY_DELAYS_SECONDS = [30, 120, 600] as const;
const FINGERPRINT_LOCK_TTL_MS = 10 * 60_000;
const UNCERTAIN_RESULT_ERROR_CODE = 'PUBLISH_RESULT_UNCERTAIN';
const UNCERTAIN_RESULT_MESSAGE = 'A previous delivery may have reached the platform; verify it before publishing again';
const PERSISTENCE_RECOVERY_MESSAGE = 'The platform accepted the publish, but its result could not be saved normally; verify it before publishing again';
const UNRESOLVED_DUPLICATE_STATUSES: PublishJobStatus[] = [
  PublishJobStatus.PUBLISHING,
  PublishJobStatus.PROCESSING,
  PublishJobStatus.NEEDS_ACTION,
];

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
        attempts: { orderBy: { attemptNumber: 'desc' }, take: 1 },
        platformAccount: { include: { platform: true } },
        target: {
          include: {
            contentVariant: { include: { content: { include: { media: true } }, media: true } },
            campaign: true,
          },
        },
      },
    });
    if (job.publishedPost || this.isClosedDelivery(job.status)) {
      await this.campaignStatus.refresh(job.target.campaignId);
      return;
    }
    if (job.status === PublishJobStatus.PUBLISHING) {
      await this.reconcileInFlightDelivery(job.id);
      await this.campaignStatus.refresh(job.target.campaignId);
      return;
    }
    // Only a claimed QUEUED row is allowed to cross the provider boundary. A
    // stale/redelivered RabbitMQ message must never turn RETRY or SCHEDULED
    // directly into another external POST.
    if (job.status !== PublishJobStatus.QUEUED) return;
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
      const pendingDuplicate = duplicate ? null : await this.prisma.publishJob.findFirst({
        where: {
          id: { not: job.id },
          platformAccountId: job.platformAccountId,
          OR: [
            { status: { in: UNRESOLVED_DUPLICATE_STATUSES } },
            {
              status: PublishJobStatus.POSSIBLE_DUPLICATE,
              lastErrorCode: WORKER_CRASH_UNCERTAIN_RESULT_CODE,
            },
          ],
          target: { contentVariant: { content: { contentHash: job.target.contentVariant.content.contentHash } } },
        },
        select: { id: true },
      });
      if (duplicate || pendingDuplicate) {
        await this.prisma.publishJob.update({ where: { id: job.id }, data: { status: PublishJobStatus.POSSIBLE_DUPLICATE, lastErrorCode: ErrorCode.PUBLISH_DUPLICATED, lastErrorMessage: 'Matching content was already published or still needs reconciliation for this account' } });
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
    let providerAccepted = false;
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
      providerAccepted = true;
      try {
        await this.persistPublishResult(job.id, job.platformAccountId, attempt.id, result);
      } catch (persistenceError) {
        this.logger.error(JSON.stringify({
          jobId,
          attempt: attemptNumber,
          status: 'PERSISTENCE_RECOVERY',
          error: persistenceError instanceof Error ? persistenceError.message : 'Unknown persistence error',
        }));
        // The provider call returned successfully, so this path must never use
        // generic retry handling. Re-read first in case the transaction
        // committed but its response was lost, then persist a reconciliation
        // state without issuing another provider request.
        const recovered = await this.recoverAcceptedPublish(
          job.id,
          job.platformAccountId,
          attempt.id,
          result,
        );
        if (!recovered) throw persistenceError;
      }
      this.logger.log(JSON.stringify({ jobId, campaignId: job.target.campaignId, platform, platformAccountId: job.platformAccountId, attempt: attemptNumber, status: result.status }));
    } catch (error) {
      // If the provider returned and even the recovery write failed, leave the
      // row PUBLISHING. A RabbitMQ redelivery is reconciled at method entry and
      // cannot call the provider again.
      if (providerAccepted) throw error;
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

  private async persistPublishResult(
    jobId: string,
    platformAccountId: string,
    attemptId: string,
    result: PublishResult,
  ): Promise<void> {
    await this.prisma.$transaction(async (transaction) => {
      await transaction.publishAttempt.update({
        where: { id: attemptId },
        data: {
          status: AttemptStatus.SUCCEEDED,
          finishedAt: new Date(),
          responseMetadata: (result.metadata ?? {}) as Prisma.InputJsonObject,
        },
      });
      if (result.metadata?.accountReconnectRequired === true) {
        await transaction.platformAccount.update({
          where: { id: platformAccountId },
          data: { status: AccountStatus.RECONNECT_REQUIRED },
        });
      }
      if (result.status === 'NEEDS_ACTION') {
        await transaction.publishJob.update({
          where: { id: jobId },
          data: {
            status: PublishJobStatus.NEEDS_ACTION,
            nextAttemptAt: null,
            lockedAt: null,
            lastErrorCode: null,
            lastErrorMessage: null,
          },
        });
        return;
      }
      await transaction.publishedPost.create({
        data: {
          publishJobId: jobId,
          platformAccountId,
          externalPostId: result.externalId,
          url: result.url,
          metadata: (result.metadata ?? {}) as Prisma.InputJsonObject,
        },
      });
      await transaction.publishJob.update({
        where: { id: jobId },
        data: {
          status: result.status === 'PROCESSING' ? PublishJobStatus.PROCESSING : PublishJobStatus.PUBLISHED,
          nextAttemptAt: null,
          lockedAt: null,
          lastErrorCode: null,
          lastErrorMessage: null,
        },
      });
    });
  }

  private async recoverAcceptedPublish(
    jobId: string,
    platformAccountId: string,
    attemptId: string,
    result: PublishResult,
  ): Promise<boolean> {
    const current = await this.readDeliveryState(jobId);
    if (current.publishedPost || this.isSafeAfterProviderAcceptance(current.status)) return true;

    const responseMetadata = {
      ...(result.metadata ?? {}),
      externalPostId: result.externalId,
      ...(result.url ? { url: result.url } : {}),
      providerAccepted: true,
      reconciliationRequired: true,
      persistenceRecoveryRequired: true,
      originalResultStatus: result.status,
    } as Prisma.InputJsonObject;
    const recovered = await this.prisma.$transaction(async (transaction) => {
      const claimed = await transaction.publishJob.updateMany({
        where: {
          id: jobId,
          status: {
            in: [
              PublishJobStatus.SCHEDULED,
              PublishJobStatus.QUEUED,
              PublishJobStatus.PUBLISHING,
              PublishJobStatus.RETRY,
              PublishJobStatus.FAILED,
            ],
          },
        },
        data: {
          status: PublishJobStatus.NEEDS_ACTION,
          nextAttemptAt: null,
          lockedAt: null,
          lastErrorCode: ErrorCode.INTERNAL_ERROR,
          lastErrorMessage: PERSISTENCE_RECOVERY_MESSAGE,
        },
      });
      if (!claimed.count) return false;
      await transaction.publishAttempt.update({
        where: { id: attemptId },
        data: {
          status: AttemptStatus.SUCCEEDED,
          finishedAt: new Date(),
          responseMetadata,
          errorCode: null,
          errorMessage: null,
        },
      });
      if (result.metadata?.accountReconnectRequired === true) {
        await transaction.platformAccount.update({
          where: { id: platformAccountId },
          data: { status: AccountStatus.RECONNECT_REQUIRED },
        });
      }
      return true;
    });
    if (recovered) return true;

    const settled = await this.readDeliveryState(jobId);
    return Boolean(settled.publishedPost || this.isSafeAfterProviderAcceptance(settled.status));
  }

  private async reconcileInFlightDelivery(jobId: string): Promise<void> {
    // A second read closes the commit-response-loss race: a completed result
    // wins, while only a row still marked PUBLISHING is moved to reconciliation.
    const current = await this.readDeliveryState(jobId);
    if (current.publishedPost || current.status !== PublishJobStatus.PUBLISHING) return;
    const attempt = current.attempts[0];
    const responseMetadata = {
      ...this.asRecord(attempt?.responseMetadata),
      reconciliationRequired: true,
      submissionUncertain: true,
      originalErrorCode: UNCERTAIN_RESULT_ERROR_CODE,
    } as Prisma.InputJsonObject;
    const reconciled = await this.prisma.$transaction(async (transaction) => {
      const claimed = await transaction.publishJob.updateMany({
        where: { id: jobId, status: PublishJobStatus.PUBLISHING },
        data: {
          status: PublishJobStatus.NEEDS_ACTION,
          nextAttemptAt: null,
          lockedAt: null,
          lastErrorCode: UNCERTAIN_RESULT_ERROR_CODE,
          lastErrorMessage: UNCERTAIN_RESULT_MESSAGE,
        },
      });
      if (!claimed.count) return false;
      if (attempt) {
        await transaction.publishAttempt.updateMany({
          where: { id: attempt.id, status: AttemptStatus.STARTED },
          data: {
            status: AttemptStatus.PERMANENT_FAILURE,
            finishedAt: new Date(),
            responseMetadata,
            errorCode: UNCERTAIN_RESULT_ERROR_CODE,
            errorMessage: UNCERTAIN_RESULT_MESSAGE,
          },
        });
      }
      return true;
    });
    if (reconciled) {
      this.logger.warn(JSON.stringify({ jobId, status: 'NEEDS_ACTION', errorCode: UNCERTAIN_RESULT_ERROR_CODE }));
    }
  }

  private readDeliveryState(jobId: string) {
    return this.prisma.publishJob.findUniqueOrThrow({
      where: { id: jobId },
      include: {
        publishedPost: true,
        attempts: { orderBy: { attemptNumber: 'desc' }, take: 1 },
      },
    });
  }

  private isClosedDelivery(status: PublishJobStatus): boolean {
    const closedStatuses: PublishJobStatus[] = [
      PublishJobStatus.PROCESSING,
      PublishJobStatus.PUBLISHED,
      PublishJobStatus.FAILED,
      PublishJobStatus.NEEDS_ACTION,
      PublishJobStatus.POSSIBLE_DUPLICATE,
      PublishJobStatus.CANCELLED,
    ];
    return closedStatuses.includes(status);
  }

  private isSafeAfterProviderAcceptance(status: PublishJobStatus): boolean {
    const safeStatuses: PublishJobStatus[] = [
      PublishJobStatus.PROCESSING,
      PublishJobStatus.PUBLISHED,
      PublishJobStatus.NEEDS_ACTION,
      PublishJobStatus.POSSIBLE_DUPLICATE,
      PublishJobStatus.CANCELLED,
    ];
    return safeStatuses.includes(status);
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
