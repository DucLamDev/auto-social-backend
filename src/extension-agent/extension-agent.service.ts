import { BadRequestException, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { AccountStatus, AttemptStatus, PlatformMode, Prisma, PublishJobStatus } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import { CampaignStatusService } from '../campaigns/campaign-status.service';
import { sha256 } from '../common/utils/crypto.utils';
import {
  EXTENSION_CONNECTOR_KEY,
  EXTENSION_RECIPES,
  extensionOpenUrl,
  ExtensionDeliverySettings,
  parseExtensionDeliverySettings,
} from '../connectors/extension/extension-delivery';
import { PrismaService } from '../database/prisma.service';
import { EXTENSION_FAILED_REASONS, ExtensionDeliveryDto, ExtensionTaskResultDto } from './extension-agent.dto';

export const EXTENSION_TOKEN_PREFIX = 'spx_';
/** A claimed task without any report after this long is treated as "result unknown". */
export const EXTENSION_CLAIM_TIMEOUT_MS = 10 * 60_000;
export const EXTENSION_RESULT_UNKNOWN = 'EXTENSION_RESULT_UNKNOWN';
const SEEN_WRITE_INTERVAL_MS = 30_000;

export interface AuthenticatedDevice {
  id: string;
  ownerId: string;
  name: string;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** Prisma JSON filter: accounts switched to Chrome extension delivery. */
const EXTENSION_ACCOUNT = { settings: { path: ['delivery'], equals: EXTENSION_CONNECTOR_KEY } } satisfies Prisma.PlatformAccountWhereInput;

/** Best-effort stable id from a forum thread URL (XenForo `.123`, Discourse `/t/slug/123`, phpBB `t=123`). */
export function threadIdFromUrl(url: string): string {
  const parsed = new URL(url);
  const xenforo = /\.(\d+)\/?$/.exec(parsed.pathname);
  if (xenforo) return xenforo[1]!;
  const discourse = /\/t\/[^/]+\/(\d+)/.exec(parsed.pathname);
  if (discourse) return discourse[1]!;
  const phpbb = parsed.searchParams.get('t') ?? parsed.searchParams.get('p');
  if (phpbb && /^\d+$/.test(phpbb)) return phpbb;
  return `${parsed.origin}${parsed.pathname}`;
}

/** Turns the AI variant into what a forum composer expects: title + plain paragraphs. */
export function forumPost(variant: { title: string | null; body: string; hashtags: string[] }, canonicalUrl: string | null) {
  const body = variant.body.trim();
  const firstLine = body.split('\n').find((line) => line.trim())?.trim() ?? '';
  const title = (variant.title?.trim() || firstLine).slice(0, 150);
  const extras = [canonicalUrl ? `Nguồn: ${canonicalUrl}` : '', variant.hashtags.length ? variant.hashtags.map((tag) => `#${tag.replace(/^#/, '')}`).join(' ') : '']
    .filter(Boolean);
  return { title, body: [body, ...extras].join('\n\n') };
}

@Injectable()
export class ExtensionAgentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly campaignStatus: CampaignStatusService,
  ) {}

  // ---- Devices (operator, JWT) -------------------------------------------------

  async createDevice(ownerId: string, name: string) {
    const token = `${EXTENSION_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
    const device = await this.prisma.extensionDevice.create({
      data: { ownerId, name: name.trim(), tokenHash: sha256(token) },
      select: { id: true, name: true, createdAt: true },
    });
    // The token is returned exactly once; only its hash is stored.
    return { ...device, token };
  }

  listDevices(ownerId: string) {
    return this.prisma.extensionDevice.findMany({
      where: { ownerId, revokedAt: null },
      select: { id: true, name: true, lastSeenAt: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
    });
  }

  async revokeDevice(ownerId: string, id: string) {
    const result = await this.prisma.extensionDevice.updateMany({ where: { id, ownerId, revokedAt: null }, data: { revokedAt: new Date() } });
    if (!result.count) throw new NotFoundException('Extension device not found');
    return { revoked: true };
  }

  async authenticate(header: string | undefined): Promise<AuthenticatedDevice> {
    const token = header?.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (!token.startsWith(EXTENSION_TOKEN_PREFIX)) throw new UnauthorizedException('Extension device token is required');
    const device = await this.prisma.extensionDevice.findUnique({
      where: { tokenHash: sha256(token) },
      select: { id: true, ownerId: true, name: true, revokedAt: true, lastSeenAt: true, owner: { select: { enabled: true } } },
    });
    if (!device || device.revokedAt || !device.owner.enabled) throw new UnauthorizedException('Extension device token is invalid or revoked');
    if (!device.lastSeenAt || Date.now() - device.lastSeenAt.getTime() > SEEN_WRITE_INTERVAL_MS) {
      await this.prisma.extensionDevice.update({ where: { id: device.id }, data: { lastSeenAt: new Date() } });
    }
    return { id: device.id, ownerId: device.ownerId, name: device.name };
  }

  // ---- Account configuration (operator, JWT) -----------------------------------

  async configureAccount(ownerId: string, accountId: string, dto: ExtensionDeliveryDto) {
    const account = await this.prisma.platformAccount.findFirst({
      where: { id: accountId, ownerId },
      select: { id: true, settings: true, status: true, enabled: true, platform: { select: { mode: true } } },
    });
    if (!account) throw new NotFoundException('Platform account not found');
    // Official APIs (Instagram, Threads…) stay on their API. Discourse-compatible
    // forums are allowed: posting there needs an admin API key the operator rarely has.
    if (account.platform.mode === PlatformMode.OFFICIAL_API) {
      throw new BadRequestException('This platform publishes through its official API; Chrome extension delivery is for forums');
    }
    const current = asRecord(account.settings);
    if (!dto.enabled) {
      const { delivery: _delivery, ...rest } = current;
      void _delivery;
      await this.prisma.platformAccount.update({
        where: { id: accountId },
        data: {
          settings: rest as Prisma.InputJsonObject,
          // Playwright/API accounts must prove their own credential again; a manual handoff stays usable.
          ...(account.platform.mode !== PlatformMode.MANUAL ? { status: AccountStatus.RECONNECT_REQUIRED, lastTestedAt: null } : {}),
        },
      });
      return { enabled: false };
    }
    const parsed = parseExtensionDeliverySettings({
      extensionEngine: dto.engine,
      extensionTargetUrl: dto.targetUrl,
      extensionAutoSubmit: dto.autoSubmit ?? true,
    });
    await this.prisma.platformAccount.update({
      where: { id: accountId },
      data: {
        settings: {
          ...current,
          delivery: EXTENSION_CONNECTOR_KEY,
          extensionEngine: parsed.engine,
          extensionTargetUrl: parsed.targetUrl,
          extensionAutoSubmit: parsed.autoSubmit,
        },
        // Nothing to verify server-side: the operator's Chrome holds the login.
        status: account.enabled ? AccountStatus.CONNECTED : AccountStatus.DISABLED,
        lastTestedAt: new Date(),
      },
    });
    return { enabled: true, ...parsed };
  }

  // ---- Agent protocol (extension, device token) --------------------------------

  async heartbeat(device: AuthenticatedDevice) {
    const [accounts, waiting] = await Promise.all([
      this.prisma.platformAccount.findMany({
        where: { ownerId: device.ownerId, enabled: true, ...EXTENSION_ACCOUNT },
        select: { name: true, settings: true, platform: { select: { name: true } } },
      }),
      this.prisma.publishJob.count({ where: this.claimableWhere(device.ownerId) }),
    ]);
    const targets = accounts.flatMap((account) => {
      try {
        const settings = parseExtensionDeliverySettings(account.settings);
        return [{ account: account.name, platform: account.platform.name, origin: new URL(settings.targetUrl).origin }];
      } catch {
        return [];
      }
    });
    return {
      device: { id: device.id, name: device.name },
      waiting,
      // Origins the extension must hold host permission for.
      origins: [...new Set(targets.map((target) => target.origin))],
      targets,
      serverTime: new Date().toISOString(),
    };
  }

  /** Hands the oldest waiting post to this device; null when there is nothing to do. */
  async claim(device: AuthenticatedDevice) {
    await this.expireStaleClaims(device.ownerId);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const job = await this.prisma.publishJob.findFirst({
        where: this.claimableWhere(device.ownerId),
        orderBy: [{ scheduledAt: 'asc' }, { createdAt: 'asc' }],
        select: { id: true },
      });
      if (!job) return null;
      const claimed = await this.prisma.publishJob.updateMany({
        where: { id: job.id, status: PublishJobStatus.NEEDS_ACTION, lockedAt: null, lastErrorCode: null },
        data: { lockedAt: new Date() },
      });
      if (!claimed.count) continue; // another device won the race
      return this.task(job.id, device);
    }
    return null;
  }

  async report(device: AuthenticatedDevice, jobId: string, dto: ExtensionTaskResultDto) {
    const job = await this.prisma.publishJob.findFirst({
      where: { id: jobId, target: { campaign: { ownerId: device.ownerId } }, platformAccount: EXTENSION_ACCOUNT },
      select: {
        id: true,
        status: true,
        lockedAt: true,
        platformAccountId: true,
        target: { select: { campaignId: true } },
        platformAccount: { select: { settings: true } },
      },
    });
    if (!job) throw new NotFoundException('Extension task not found');
    if (job.status !== PublishJobStatus.NEEDS_ACTION || !job.lockedAt) {
      throw new BadRequestException('This task is not claimed by an extension; it may already be finished');
    }
    const settings = parseExtensionDeliverySettings(job.platformAccount.settings);
    if (dto.outcome === 'PUBLISHED') return this.completePublished(device, job, settings, dto);
    if (dto.outcome === 'FAILED') {
      if (!dto.reason || !(EXTENSION_FAILED_REASONS as readonly string[]).includes(dto.reason)) {
        throw new BadRequestException('FAILED is only for reasons where nothing was submitted');
      }
      await this.prisma.publishJob.updateMany({
        where: { id: jobId, status: PublishJobStatus.NEEDS_ACTION },
        data: {
          status: PublishJobStatus.FAILED,
          lockedAt: null,
          nextAttemptAt: null,
          lastErrorCode: `EXTENSION_${dto.reason}`,
          lastErrorMessage: dto.message ?? null,
        },
      });
      await this.campaignStatus.refresh(job.target.campaignId);
      return { recorded: 'FAILED' };
    }
    // NEEDS_ACTION keeps the claim so the extension can still report PUBLISHED
    // once the operator solves a CAPTCHA or clicks Post in that tab.
    await this.prisma.publishJob.updateMany({
      where: { id: jobId, status: PublishJobStatus.NEEDS_ACTION },
      data: { lastErrorCode: `EXTENSION_${dto.reason ?? 'SUBMIT_UNCONFIRMED'}`, lastErrorMessage: dto.message ?? null },
    });
    return { recorded: 'NEEDS_ACTION' };
  }

  /** Operator confirmed nothing was posted: put the job back in the extension queue. */
  async requeue(ownerId: string, jobId: string) {
    const result = await this.prisma.publishJob.updateMany({
      where: {
        id: jobId,
        status: PublishJobStatus.NEEDS_ACTION,
        lastErrorCode: { startsWith: 'EXTENSION_' },
        target: { campaign: { ownerId } },
        platformAccount: EXTENSION_ACCOUNT,
      },
      data: { lastErrorCode: null, lastErrorMessage: null, lockedAt: null },
    });
    if (!result.count) throw new BadRequestException('Only an extension task waiting for the operator can be queued again');
    return { queued: true };
  }

  private claimableWhere(ownerId: string): Prisma.PublishJobWhereInput {
    return {
      status: PublishJobStatus.NEEDS_ACTION,
      lockedAt: null,
      lastErrorCode: null,
      publishedPost: null,
      target: { campaign: { ownerId } },
      platformAccount: { enabled: true, ...EXTENSION_ACCOUNT },
      // Only jobs the ExtensionConnector parked; never a manual handoff or a reconciliation.
      attempts: { some: { responseMetadata: { path: ['extensionQueued'], equals: true } } },
    };
  }

  /**
   * A claim with no report may mean the extension posted and then crashed.
   * Never re-claim it automatically: ask the operator to check the forum.
   */
  private async expireStaleClaims(ownerId: string) {
    await this.prisma.publishJob.updateMany({
      where: {
        status: PublishJobStatus.NEEDS_ACTION,
        lastErrorCode: null,
        lockedAt: { lt: new Date(Date.now() - EXTENSION_CLAIM_TIMEOUT_MS) },
        target: { campaign: { ownerId } },
        platformAccount: EXTENSION_ACCOUNT,
      },
      data: {
        lastErrorCode: EXTENSION_RESULT_UNKNOWN,
        lastErrorMessage: 'Tiện ích không báo kết quả trong 10 phút. Kiểm tra diễn đàn: đã có bài thì bấm Đã đăng, chưa có thì Giao lại cho tiện ích.',
      },
    });
  }

  private async task(jobId: string, device: AuthenticatedDevice) {
    const job = await this.prisma.publishJob.findUniqueOrThrow({
      where: { id: jobId },
      select: {
        id: true,
        platformAccount: { select: { id: true, name: true, settings: true, platform: { select: { name: true, slug: true } } } },
        target: { select: { campaign: { select: { name: true } }, contentVariant: { select: { title: true, body: true, hashtags: true, content: { select: { canonicalUrl: true } } } } } },
      },
    });
    const settings = parseExtensionDeliverySettings(job.platformAccount.settings);
    const variant = job.target.contentVariant;
    const post = forumPost(variant, variant.content.canonicalUrl);
    return {
      jobId: job.id,
      deviceId: device.id,
      account: { id: job.platformAccount.id, name: job.platformAccount.name, platform: job.platformAccount.platform.name },
      campaign: job.target.campaign.name,
      openUrl: extensionOpenUrl(settings),
      targetOrigin: new URL(settings.targetUrl).origin,
      autoSubmit: settings.autoSubmit,
      recipe: EXTENSION_RECIPES[settings.engine],
      post,
    };
  }

  private async completePublished(
    device: AuthenticatedDevice,
    job: { id: string; platformAccountId: string; target: { campaignId: string } },
    settings: ExtensionDeliverySettings,
    dto: ExtensionTaskResultDto,
  ) {
    if (!dto.url) throw new BadRequestException('A PUBLISHED report needs the thread URL');
    const url = new URL(dto.url);
    const target = new URL(settings.targetUrl);
    // The URL must be on the configured forum; a report cannot complete a job with an arbitrary link.
    if (url.hostname !== target.hostname || (url.protocol !== 'https:' && target.protocol === 'https:')) {
      throw new BadRequestException('The reported thread URL is not on the configured forum');
    }
    if (!new RegExp(EXTENSION_RECIPES[settings.engine].successUrlPattern).test(url.href)) {
      throw new BadRequestException('The reported URL does not look like a published thread');
    }
    const externalPostId = threadIdFromUrl(url.href);
    const metadata = { extension: true, deviceId: device.id, url: url.href, externalPostId } as Prisma.InputJsonObject;
    await this.prisma.$transaction(async (transaction) => {
      const claimed = await transaction.publishJob.updateMany({
        where: { id: job.id, status: PublishJobStatus.NEEDS_ACTION },
        data: { status: PublishJobStatus.PUBLISHED, lockedAt: null, nextAttemptAt: null, lastErrorCode: null, lastErrorMessage: null },
      });
      if (!claimed.count) throw new BadRequestException('The task was finished elsewhere');
      await transaction.publishedPost.create({
        data: { publishJobId: job.id, platformAccountId: job.platformAccountId, externalPostId, url: url.href, metadata },
      });
      const attempt = await transaction.publishAttempt.findFirst({ where: { publishJobId: job.id }, orderBy: { attemptNumber: 'desc' } });
      if (attempt) {
        await transaction.publishAttempt.update({
          where: { id: attempt.id },
          data: {
            status: AttemptStatus.SUCCEEDED,
            finishedAt: new Date(),
            responseMetadata: { ...asRecord(attempt.responseMetadata), ...metadata } as Prisma.InputJsonObject,
            errorCode: null,
            errorMessage: null,
          },
        });
      }
    });
    await this.campaignStatus.refresh(job.target.campaignId);
    return { recorded: 'PUBLISHED', externalPostId, url: url.href };
  }
}

