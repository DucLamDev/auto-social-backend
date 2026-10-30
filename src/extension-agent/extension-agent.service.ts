import { BadRequestException, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { AccountStatus, AttemptStatus, PlatformMode, Prisma, PublishJobStatus } from '@prisma/client';
import { createHash, randomBytes } from 'node:crypto';
import { StorageService } from '../storage/storage.service';
import { CampaignStatusService } from '../campaigns/campaign-status.service';
import { sha256 } from '../common/utils/crypto.utils';
import {
  EXTENSION_CONNECTOR_KEY,
  EXTENSION_RECIPES,
  extensionOpenUrl,
  ExtensionDeliverySettings,
  ExtensionEngine,
  parseExtensionDeliverySettings,
} from '../connectors/extension/extension-delivery';
import { PrismaService } from '../database/prisma.service';
import { EXTENSION_FAILED_REASONS, ExtensionDeliveryDto, ExtensionTaskResultDto } from './extension-agent.dto';
import { extensionFlowForPlatform, validateExtensionFlow } from '../connectors/extension/extension-flows';
import { deviceCanRunAccount, sessionOf } from './extension-account-session.service';

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
    private readonly storage: StorageService,
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
      select: { id: true, settings: true, status: true, enabled: true, platform: { select: { mode: true, slug: true } } },
    });
    if (!account) throw new NotFoundException('Platform account not found');
    // Official APIs (Instagram, Threads…) stay on their API. Discourse-compatible
    // forums are allowed: posting there needs an admin API key the operator rarely has.
    if (account.platform.mode === PlatformMode.OFFICIAL_API && !extensionFlowForPlatform(account.platform.slug)) {
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
      extensionTags: dto.tags ?? [],
      extensionCategory: dto.category ?? '',
      extensionFlair: dto.flair ?? '',
    });
    const flow = validateExtensionFlow(account.platform.slug, parsed);
    const bound = sessionOf(current);
    if (bound && bound.origin !== new URL(parsed.targetUrl).origin) throw new BadRequestException('Create a separate account for a different destination origin; its Chrome session is already bound');
    await this.prisma.platformAccount.update({
      where: { id: accountId },
      data: {
        settings: {
          ...current,
          delivery: EXTENSION_CONNECTOR_KEY,
          extensionEngine: parsed.engine,
          extensionTargetUrl: parsed.targetUrl,
          extensionAutoSubmit: parsed.autoSubmit,
          extensionTags: parsed.tags ?? [],
          extensionCategory: parsed.category ?? '',
          extensionFlair: parsed.flair ?? '',
          extensionSetup: { status: 'READY' },
          extensionAutoConnect: true,
          ...(flow ? { extensionFlowId: flow.id, extensionFlowRevision: flow.revision } : {}),
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
    const [accounts, deviceCount] = await Promise.all([
      this.prisma.platformAccount.findMany({
        where: { ownerId: device.ownerId, enabled: true, ...EXTENSION_ACCOUNT },
        select: { id: true, name: true, settings: true, platform: { select: { name: true } } },
      }),
      this.prisma.extensionDevice.count({ where: { ownerId: device.ownerId, revokedAt: null } }),
    ]);
    const assigned = accounts.filter(account => deviceCanRunAccount(account, device.id, accounts, deviceCount, 1));
    const waiting = await this.prisma.publishJob.count({ where: { ...this.claimableWhere(device.ownerId), platformAccountId: { in: assigned.map(account => account.id) } } });
    const targets = assigned.flatMap((account) => {
      try {
        const settings = parseExtensionDeliverySettings(account.settings);
        const session = sessionOf(account.settings);
        return [{ account: account.name, platform: account.platform.name, origin: new URL(settings.targetUrl).origin,
          ...(session?.autoLogin && session.provider === 'google' ? { loginOrigin: 'https://accounts.google.com' } : {}) }];
      } catch {
        return [];
      }
    });
    const loginAccounts = await this.prisma.platformAccount.findMany({ where: { ownerId: device.ownerId,
      settings: { path: ['extensionSession', 'deviceId'], equals: device.id } }, select: { settings: true } });
    const loginOrigins = loginAccounts.flatMap(account => {
      const session = sessionOf(account.settings);
      return session ? [session.origin, ...(session.allowedOrigins ?? []), ...(session.provider === 'google' ? ['https://accounts.google.com'] : [])] : [];
    });
    return {
      device: { id: device.id, name: device.name },
      waiting,
      // Origins the extension must hold host permission for.
      origins: [...new Set([...loginOrigins, ...targets.flatMap(target => [target.origin, ...(target.loginOrigin ? [target.loginOrigin] : [])])])],
      loginChecks: true,
      targets,
      serverTime: new Date().toISOString(),
    };
  }

  /** Hands the oldest waiting post to this device; null when there is nothing to do. */
  async claim(device: AuthenticatedDevice, excludeOrigins: string[] = [], supportedEngines: ExtensionEngine[] = ['discourse', 'xenforo', 'phpbb'], authProtocol?: number) {
    await this.expireStaleClaims(device.ownerId);
    const excluded = new Set(excludeOrigins.map((origin) => new URL(origin).origin));
    const accounts = await this.prisma.platformAccount.findMany({
      where: { ownerId: device.ownerId, enabled: true, ...EXTENSION_ACCOUNT },
      select: { id: true, settings: true },
    });
    const deviceCount = await this.prisma.extensionDevice.count({ where: { ownerId: device.ownerId, revokedAt: null } });
    const excludedAccountIds = accounts.filter((account) => {
      if (!deviceCanRunAccount(account, device.id, accounts, deviceCount, authProtocol)) return true;
      try { const settings = parseExtensionDeliverySettings(account.settings); return !supportedEngines.includes(settings.engine) || excluded.has(new URL(settings.targetUrl).origin); }
      catch { return true; }
    }).map((account) => account.id);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const job = await this.prisma.publishJob.findFirst({
        where: { ...this.claimableWhere(device.ownerId), ...(excludedAccountIds.length ? { platformAccountId: { notIn: excludedAccountIds } } : {}) },
        orderBy: [{ scheduledAt: 'asc' }, { createdAt: 'asc' }],
        select: { id: true },
      });
      if (!job) return null;
      const claimed = await this.prisma.publishJob.updateMany({
        where: { id: job.id, status: PublishJobStatus.NEEDS_ACTION, lockedAt: null, lastErrorCode: null },
        data: { lockedAt: new Date(), extensionClaimDeviceId: device.id, extensionPasswordIssuedAt: null, extensionTotpIssuedAt: null },
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
        extensionClaimDeviceId: true,
        lastErrorCode: true,
        platformAccountId: true,
        publishedPost: { select: { url: true, externalPostId: true } },
        target: { select: { campaignId: true } },
        platformAccount: { select: { settings: true } },
      },
    });
    if (!job) throw new NotFoundException('Extension task not found');
    if (job.extensionClaimDeviceId && job.extensionClaimDeviceId !== device.id) throw new UnauthorizedException('This task belongs to another Chrome profile');
    // A successful report response can be lost. Acknowledge the same verified
    // receipt without creating another PublishedPost or submitting anything.
    if (job.status === PublishJobStatus.PUBLISHED && dto.outcome === 'PUBLISHED'
      && dto.url && job.publishedPost?.url === dto.url) {
      return { recorded: 'PUBLISHED', externalPostId: job.publishedPost.externalPostId, url: dto.url };
    }
    if (job.status !== PublishJobStatus.NEEDS_ACTION || !job.lockedAt) {
      throw new BadRequestException('This task is not claimed by an extension; it may already be finished');
    }
    const settings = parseExtensionDeliverySettings(job.platformAccount.settings);
    if (dto.outcome === 'PUBLISHED') return this.completePublished(device, job, settings, dto);
    if (job.lastErrorCode === 'EXTENSION_MODERATION_PENDING') return { recorded: 'NEEDS_ACTION' };
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
        lastErrorCode: { startsWith: 'EXTENSION_', not: 'EXTENSION_MODERATION_PENDING' },
        target: { campaign: { ownerId } },
        platformAccount: EXTENSION_ACCOUNT,
      },
      data: { lastErrorCode: null, lastErrorMessage: null, lockedAt: null, extensionClaimDeviceId: null, extensionPasswordIssuedAt: null, extensionTotpIssuedAt: null },
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
        target: { select: { campaign: { select: { name: true } }, contentVariant: { select: { title: true, body: true, summary: true, hashtags: true,
          media: { select: { id: true, type: true, mimeType: true, sizeBytes: true } },
          content: { select: { canonicalUrl: true, media: { where: { variantId: null }, select: { id: true, type: true, mimeType: true, sizeBytes: true } } } } } } } },
      },
    });
    const settings = parseExtensionDeliverySettings(job.platformAccount.settings);
    const session = sessionOf(job.platformAccount.settings);
    if (session && session.deviceId !== device.id) throw new UnauthorizedException('Account was assigned to another Chrome profile');
    const variant = job.target.contentVariant;
    const flow = validateExtensionFlow(job.platformAccount.platform.slug, settings);
    const post = forumPost(variant, variant.content.canonicalUrl);
    if (EXTENSION_RECIPES[settings.engine].workflow === 'social') {
      post.title = variant.title?.trim() || variant.body.split('\n').find(line => line.trim())?.trim() || '';
    }
    const requiredMedia = EXTENSION_RECIPES[settings.engine].requiredMedia;
    const variantMedia = (variant.media ?? []).filter(asset => asset.type.toLowerCase() === requiredMedia);
    const media = requiredMedia ? (variantMedia.length ? variantMedia : (variant.content.media ?? []).filter(asset => asset.type.toLowerCase() === requiredMedia))
      .map(asset => ({ id: asset.id, mimeType: asset.mimeType, sizeBytes: Number(asset.sizeBytes) })) : [];
    return {
      jobId: job.id,
      deviceId: device.id,
      account: { id: job.platformAccount.id, name: job.platformAccount.name, platform: job.platformAccount.platform.name },
      campaign: job.target.campaign.name,
      flow: { id: flow?.id ?? job.platformAccount.platform.slug, name: flow?.name ?? job.platformAccount.platform.name, revision: flow?.revision ?? 1, engine: settings.engine },
      openUrl: extensionOpenUrl(settings),
      targetOrigin: new URL(settings.targetUrl).origin,
      autoSubmit: settings.autoSubmit,
      ...(session ? { auth: session } : {}),
      recipe: EXTENSION_RECIPES[settings.engine],
      options: { tags: settings.tags ?? [], category: settings.category ?? '', flair: settings.flair ?? '', sendEmail: false },
      media,
      post: { ...post, summary: variant.summary ?? '' },
    };
  }

  /** Fetch only a managed attachment belonging to this owner's claimed job.
   * The device token stays in the worker, never in the destination page. */
  async taskMedia(device: AuthenticatedDevice, jobId: string, assetId: string) {
    const job = await this.prisma.publishJob.findFirst({
      where: { id: jobId, status: PublishJobStatus.NEEDS_ACTION, lockedAt: { not: null }, extensionClaimDeviceId: device.id,
        target: { campaign: { ownerId: device.ownerId } }, platformAccount: EXTENSION_ACCOUNT },
      select: { target: { select: { contentVariant: { select: { id: true, contentId: true } } } }, platformAccount: { select: { settings: true } } },
    });
    if (!job) throw new NotFoundException('Claimed extension job not found');
    const variant = job.target.contentVariant;
    const required = EXTENSION_RECIPES[parseExtensionDeliverySettings(job.platformAccount.settings).engine].requiredMedia;
    if (!required) throw new BadRequestException('This flow does not upload attachments');
    const asset = await this.prisma.mediaAsset.findFirst({
      where: { id: assetId, ownerId: device.ownerId, OR: [{ variantId: variant.id }, { contentId: variant.contentId, variantId: null }] },
      select: { id: true, storageKey: true, mimeType: true, sizeBytes: true, checksum: true },
    });
    if (!asset) throw new NotFoundException('Attachment not found for this job');
    const formats: Record<string, string> = required === 'document' ? { 'application/pdf': 'pdf' } : { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };
    const extension = formats[asset.mimeType];
    if (!extension || asset.sizeBytes > 20n * 1024n * 1024n) throw new BadRequestException('Attachment must be a supported file of at most 20 MiB');
    const bytes = await this.storage.get(asset.storageKey, 20 * 1024 * 1024);
    if (bytes.length !== Number(asset.sizeBytes) || createHash('sha256').update(bytes).digest('hex') !== asset.checksum) throw new BadRequestException('Attachment integrity check failed');
    return { name: `${asset.id}.${extension}`, mimeType: asset.mimeType, sizeBytes: bytes.length, base64: bytes.toString('base64') };
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

