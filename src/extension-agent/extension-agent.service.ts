import { BadRequestException, Injectable, NotFoundException, Optional, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
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
import { renderForExtension, renderPostText, type PostTextInput } from '../platforms/post-text';
import { detectLanguage, platformContract, type AudienceLanguage } from '../platforms/platform-contract';
import { checkPostLength, contractFor, postLengthMessage } from '../platforms/post-length';
import { markdownToHtml } from '../platforms/markdown-html';
import { destinationTags } from '../connectors/extension/extension-tags';
import { EXTENSION_FAILED_REASONS, ExtensionDeliveryDto, ExtensionTaskResultDto } from './extension-agent.dto';
import { extensionFlowForPlatform, validateExtensionFlow } from '../connectors/extension/extension-flows';
import { deviceCanRunAccount, sessionOf } from './extension-account-session.service';
import { repairEscapedNewlines } from '../common/utils/escaped-text';
import { mergeApprovedSelectors } from './ui-recovery/selector-merge';
import { ExtensionSelectorSuggestionService } from './ui-recovery/selector-suggestion.service';
import { EXTENSION_ACCOUNT, EXTENSION_CLAIM_TIMEOUT_MS, EXTENSION_RESULT_UNKNOWN, expireStaleExtensionClaims } from './stale-claims';

export { EXTENSION_CLAIM_TIMEOUT_MS, EXTENSION_RESULT_UNKNOWN };
export const EXTENSION_TOKEN_PREFIX = 'spx_';
/** The post is longer than the destination accepts; the operator shortens it, then requeues. */
export const EXTENSION_CONTENT_TOO_LONG = 'EXTENSION_CONTENT_TOO_LONG';
const SEEN_WRITE_INTERVAL_MS = 30_000;
/** Compare-and-set losses to another Chrome before giving up for this poll. */
const MAX_CLAIM_RACES = 3;
/** Over-long posts set aside in one poll; each is parked for the operator, so the next poll moves on. */
const MAX_SET_ASIDE_PER_CLAIM = 20;
/**
 * How often a waiting post's "this Chrome's extension cannot post here" note is
 * refreshed while that Chrome keeps polling; the web shows it while recent.
 */
const UNSUPPORTED_NOTE_REFRESH_MS = 5 * 60_000;
/** Waiting posts noted per poll: the rest are noted on the next ones. */
const MAX_UNSUPPORTED_NOTES_PER_CLAIM = 50;

export interface AuthenticatedDevice {
  id: string;
  ownerId: string;
  name: string;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** Raised while preparing a task whose post the destination would refuse. */
class PostTooLongError extends Error {}

/**
 * Language the post is written in (what a language selector should show):
 * detected from the text sent, else the destination contract's language.
 */
export function taskPostLanguage(renderedBody: string, input: PostTextInput, platformSlug: string, engine: ExtensionEngine): AudienceLanguage {
  const detected = detectLanguage(renderedBody);
  return detected === 'unknown' ? contractFor({ platformSlug, engine, body: input.body }).language : detected;
}

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
  const body = repairEscapedNewlines(variant.body).trim();
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
    @Optional() private readonly suggestions?: ExtensionSelectorSuggestionService,
    @Optional() private readonly config?: ConfigService,
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
    // Accounts this Chrome should post for but whose flow its extension version does not have.
    const unsupported = new Map<string, string>();
    const excludedAccountIds = accounts.filter((account) => {
      if (!deviceCanRunAccount(account, device.id, accounts, deviceCount, authProtocol)) return true;
      try {
        const settings = parseExtensionDeliverySettings(account.settings);
        if (!supportedEngines.includes(settings.engine)) { unsupported.set(account.id, settings.engine); return true; }
        return excluded.has(new URL(settings.targetUrl).origin);
      } catch { return true; }
    }).map((account) => account.id);
    if (unsupported.size) await this.noteUnsupported(device, unsupported);
    let races = 0;
    let setAside = 0;
    while (races < MAX_CLAIM_RACES && setAside < MAX_SET_ASIDE_PER_CLAIM) {
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
      if (!claimed.count) { races += 1; continue; } // another device won the race
      try {
        return await this.task(job.id, device);
      } catch (error) {
        if (!(error instanceof PostTooLongError)) throw error;
        // The site would refuse or cut it: never hand it out. Park it for the
        // operator and release the claim, then look at the next post.
        await this.prisma.publishJob.updateMany({
          where: { id: job.id, status: PublishJobStatus.NEEDS_ACTION, extensionClaimDeviceId: device.id, lastErrorCode: null },
          data: { lockedAt: null, extensionClaimDeviceId: null, lastErrorCode: EXTENSION_CONTENT_TOO_LONG, lastErrorMessage: error.message },
        });
        setAside += 1;
      }
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
      await this.recordReportDetails(jobId, dto);
      await this.campaignStatus.refresh(job.target.campaignId);
      return { recorded: 'FAILED' };
    }
    // NEEDS_ACTION keeps the claim so the extension can still report PUBLISHED
    // once the operator solves a CAPTCHA or clicks Post in that tab.
    await this.prisma.publishJob.updateMany({
      where: { id: jobId, status: PublishJobStatus.NEEDS_ACTION },
      data: { lastErrorCode: `EXTENSION_${dto.reason ?? 'SUBMIT_UNCONFIRMED'}`, lastErrorMessage: dto.message ?? null },
    });
    await this.recordReportDetails(jobId, dto);
    return { recorded: 'NEEDS_ACTION' };
  }

  /**
   * Sign-in details the extension adds to a stop (which account Chrome is
   * signed in to, Google blocking the login) go to the attempt details for the
   * operator; they never change the job.
   */
  private async recordReportDetails(jobId: string, dto: ExtensionTaskResultDto) {
    const detectedUsername = dto.detectedUsername?.trim().slice(0, 200);
    if (!detectedUsername && dto.googleBlocked !== true) return;
    const attempt = await this.prisma.publishAttempt.findFirst({ where: { publishJobId: jobId }, orderBy: { attemptNumber: 'desc' }, select: { id: true, responseMetadata: true } });
    if (!attempt) return;
    const extensionReport = { ...(detectedUsername ? { detectedUsername } : {}), ...(dto.googleBlocked === true ? { googleBlocked: true } : {}) };
    await this.prisma.publishAttempt.update({
      where: { id: attempt.id },
      data: { responseMetadata: { ...asRecord(attempt.responseMetadata), extensionReport } },
    });
  }

  /**
   * Operator confirmed nothing was posted: put the job back in the extension
   * queue. Covers a job the extension stopped on (any EXTENSION_* code except a
   * post the site is moderating) and a claim that went silent past the claim
   * timeout before the scheduler marked it.
   */
  async requeue(ownerId: string, jobId: string) {
    const result = await this.prisma.publishJob.updateMany({
      where: {
        id: jobId,
        status: PublishJobStatus.NEEDS_ACTION,
        target: { campaign: { ownerId } },
        platformAccount: EXTENSION_ACCOUNT,
        OR: [
          { lastErrorCode: { startsWith: 'EXTENSION_', not: 'EXTENSION_MODERATION_PENDING' } },
          {
            lastErrorCode: null,
            lockedAt: { lt: new Date(Date.now() - EXTENSION_CLAIM_TIMEOUT_MS) },
            publishedPost: null,
            attempts: { some: { responseMetadata: { path: ['extensionQueued'], equals: true } } },
          },
        ],
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
   * An older extension skips posts for flows it does not know, so they stayed
   * "Chờ tiện ích" with no reason given. Note on each such waiting post which
   * Chrome cannot take it and why (the web then asks to update the extension).
   * Written at most every few minutes per post; never changes the job itself.
   */
  private async noteUnsupported(device: AuthenticatedDevice, engines: Map<string, string>) {
    const jobs = await this.prisma.publishJob.findMany({
      where: { ...this.claimableWhere(device.ownerId), platformAccountId: { in: [...engines.keys()] } },
      orderBy: [{ scheduledAt: 'asc' }, { createdAt: 'asc' }],
      take: MAX_UNSUPPORTED_NOTES_PER_CLAIM,
      select: { platformAccountId: true, attempts: { orderBy: { attemptNumber: 'desc' }, take: 1, select: { id: true, responseMetadata: true } } },
    });
    const now = Date.now();
    for (const job of jobs) {
      const attempt = job.attempts[0];
      const engine = engines.get(job.platformAccountId);
      if (!attempt || !engine) continue;
      const metadata = asRecord(attempt.responseMetadata);
      const previous = asRecord(metadata.extensionUnsupported);
      const notedAt = typeof previous.at === 'string' ? Date.parse(previous.at) : Number.NaN;
      if (previous.deviceId === device.id && previous.engine === engine && now - notedAt < UNSUPPORTED_NOTE_REFRESH_MS) continue;
      await this.prisma.publishAttempt.update({
        where: { id: attempt.id },
        data: { responseMetadata: { ...metadata, extensionUnsupported: { deviceId: device.id, deviceName: device.name, engine, at: new Date(now).toISOString() } } },
      });
    }
  }

  /** Also runs every minute from the scheduler, for a Chrome that stopped polling. */
  private async expireStaleClaims(ownerId: string) {
    await expireStaleExtensionClaims(this.prisma, ownerId);
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
    const platformSlug = job.platformAccount.platform.slug;
    const flow = validateExtensionFlow(platformSlug, settings);
    const canonicalUrl = variant.content.canonicalUrl;
    // The same count the approval and editing checks use: a post over the limit never reaches the site.
    const length = checkPostLength({ title: variant.title, body: variant.body, hashtags: variant.hashtags, platformSlug, engine: settings.engine, canonicalUrl });
    if (length.over) throw new PostTooLongError(postLengthMessage(job.platformAccount.platform.name, length));
    const post = renderForExtension(variant, platformSlug, settings.engine, canonicalUrl);
    const baseRecipe = EXTENSION_RECIPES[settings.engine];
    // Rich editors get the formatted version of the same text (Markdown kept, then turned into HTML).
    const bodyHtml = baseRecipe.inputMode === 'pasteHtml'
      ? markdownToHtml(renderPostText(variant, { ...contractFor({ platformSlug, engine: settings.engine, body: variant.body }), format: 'markdown' }, canonicalUrl).body)
      : undefined;
    // Required media (Pixelfed photo, SlideShare PDF) or one optional image the
    // composer can take; the variant's own file wins over the shared upload.
    const mediaKind = EXTENSION_RECIPES[settings.engine].requiredMedia ?? EXTENSION_RECIPES[settings.engine].optionalMedia;
    const variantMedia = (variant.media ?? []).filter(asset => asset.type.toLowerCase() === mediaKind);
    const media = mediaKind ? (variantMedia.length ? variantMedia : (variant.content.media ?? []).filter(asset => asset.type.toLowerCase() === mediaKind))
      .slice(0, EXTENSION_RECIPES[settings.engine].requiredMedia ? undefined : 1).map(asset => ({ id: asset.id, mimeType: asset.mimeType, sizeBytes: Number(asset.sizeBytes) })) : [];
    const targetOrigin = new URL(settings.targetUrl).origin;
    // Selectors an ADMIN approved for this destination after a page redesign.
    const approvedSelectors = await this.suggestions?.approvedFor(device.ownerId, settings.engine, targetOrigin) ?? [];
    return {
      jobId: job.id,
      deviceId: device.id,
      account: { id: job.platformAccount.id, name: job.platformAccount.name, platform: job.platformAccount.platform.name },
      campaign: job.target.campaign.name,
      flow: { id: flow?.id ?? job.platformAccount.platform.slug, name: flow?.name ?? job.platformAccount.platform.name, revision: flow?.revision ?? 1, engine: settings.engine },
      openUrl: extensionOpenUrl(settings),
      targetOrigin,
      autoSubmit: settings.autoSubmit,
      ...(session ? { auth: session } : {}),
      recipe: mergeApprovedSelectors(baseRecipe, approvedSelectors),
      uiRecovery: { enabled: this.config?.get<boolean>('EXTENSION_UI_RECOVERY_ENABLED') === true },
      formFill: { enabled: this.config?.get<boolean>('EXTENSION_AI_FORM_FILL_ENABLED') === true },
      options: {
        tags: settings.tags ?? [],
        // The AI's topic tags go to the tag field (not the body) on these destinations;
        // the extension uses only those the site already has.
        suggestedTags: platformContract(job.platformAccount.platform.slug, { engine: settings.engine }).hashtagMode === 'tags'
          ? destinationTags(settings.engine, variant.hashtags, settings.tags ?? []) : [],
        category: settings.category ?? '', flair: settings.flair ?? '', sendEmail: false,
      },
      media,
      post: {
        ...post,
        summary: variant.summary ?? '',
        maxChars: length.maxChars,
        length: length.length,
        language: taskPostLanguage(post.body, variant, platformSlug, settings.engine),
        ...(bodyHtml !== undefined ? { bodyHtml } : {}),
      },
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
    const recipe = EXTENSION_RECIPES[parseExtensionDeliverySettings(job.platformAccount.settings).engine];
    const required = recipe.requiredMedia ?? recipe.optionalMedia;
    if (!required) throw new BadRequestException('This flow does not upload attachments');
    const asset = await this.prisma.mediaAsset.findFirst({
      where: { id: assetId, ownerId: device.ownerId, OR: [{ variantId: variant.id }, { contentId: variant.contentId, variantId: null }] },
      select: { id: true, storageKey: true, mimeType: true, sizeBytes: true, checksum: true, metadata: true },
    });
    if (!asset) throw new NotFoundException('Attachment not found for this job');
    const formats: Record<string, string> = required === 'document' ? { 'application/pdf': 'pdf' } : { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };
    const extension = formats[asset.mimeType];
    if (!extension || asset.sizeBytes > 20n * 1024n * 1024n) throw new BadRequestException('Attachment must be a supported file of at most 20 MiB');
    const bytes = await this.storage.get(asset.storageKey, 20 * 1024 * 1024);
    if (bytes.length !== Number(asset.sizeBytes) || createHash('sha256').update(bytes).digest('hex') !== asset.checksum) throw new BadRequestException('Attachment integrity check failed');
    const altText = asset.metadata && typeof asset.metadata === 'object' && !Array.isArray(asset.metadata) && typeof (asset.metadata as Record<string, unknown>).altText === 'string'
      ? ((asset.metadata as Record<string, unknown>).altText as string).slice(0, 1_000) : undefined;
    return { name: `${asset.id}.${extension}`, mimeType: asset.mimeType, sizeBytes: bytes.length, base64: bytes.toString('base64'), ...(altText ? { altText } : {}) };
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
    // Blogger posts are written on www.blogger.com and published on <blog>.blogspot.com.
    const bloggerPost = settings.engine === 'blogger' && url.protocol === 'https:' && /^[a-z0-9-]+\.blogspot\.com$/.test(url.hostname);
    if ((url.hostname !== target.hostname && !bloggerPost) || (url.protocol !== 'https:' && target.protocol === 'https:')) {
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

