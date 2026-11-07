import { BadRequestException, HttpException, HttpStatus, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PublishJobStatus } from '@prisma/client';
import { AiContentService } from '../../ai/ai-content.service';
import { AiProvider } from '../../ai/ai-provider';
import { AuditService } from '../../audit/audit.service';
import { ApplicationException } from '../../common/exceptions/application.exception';
import { EXTENSION_CONNECTOR_KEY, parseExtensionDeliverySettings } from '../../connectors/extension/extension-delivery';
import { PrismaService } from '../../database/prisma.service';
import { RedisService } from '../../queue/redis.service';
import { object, sessionOf, type ExtensionSession } from '../extension-account-session.service';
import type { AuthenticatedDevice } from '../extension-agent.service';
import { loginSession } from '../extension-login-check.service';
import { AUTH_HINT, AUTH_HINT_INSTRUCTIONS, AUTH_HINT_SPEC, AuthHintField, validateAuthHint } from './auth-hint.rules';
import { AuthHintRequestDto } from './ui-hint.dto';
import { sanitizeCandidates, UiCandidate } from './ui-hint.rules';
import { HINTS_PER_DEVICE_PER_HOUR, INLINE_WAIT_MS, STALE_AFTER_MS, uiHintRateKey } from './ui-recovery.service';

/** Sign-in hints per publish job or login check, apart from the composer's own two. */
export const MAX_AUTH_HINTS = 2;

export type AuthHintScope = { kind: 'task' | 'login-check'; id: string };
export interface AuthHintView {
  hintId: string;
  status: 'RUNNING' | 'READY' | 'FAILED';
  signedIn?: 'yes' | 'no' | 'unknown';
  selectors?: Partial<Record<AuthHintField, string>>;
  confidence?: number;
  errorCode?: string;
}

interface AuthOwner {
  link: { publishJobId: string } | { loginCheckId: string };
  accountId: string;
  session: ExtensionSession;
  engine: string;
  /** Pages the hint may describe: the destination and the account's own sign-in origins (never Google's). */
  origins: string[];
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** What the AI sees of an element: never its selector or a value. */
function describe(candidate: UiCandidate): Record<string, unknown> {
  const { index, kind, tag, type, role, label, text, name, id, inDialog, inForm, disabled, region, inArticle } = candidate;
  return JSON.parse(JSON.stringify({ index, kind, tag, type, role, label, text, name, id, inDialog, inForm, disabled, region, inArticle })) as Record<string, unknown>;
}

/**
 * When the extension cannot tell whether, or as whom, a page is signed in, the
 * AI points at the account element, the account-menu button or the sign-in
 * button. The extension reads and checks the account itself; a confirmed
 * account element becomes the account's identity selector so later runs need
 * no AI.
 */
@Injectable()
export class ExtensionAuthHintService {
  private readonly logger = new Logger(ExtensionAuthHintService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly ai: AiContentService,
    @Optional() private readonly redis?: RedisService,
    @Optional() private readonly audit?: AuditService,
  ) {}

  private enabled(): boolean {
    return this.config.get<boolean>('EXTENSION_UI_RECOVERY_ENABLED') === true;
  }

  /** The publish job this Chrome is signing in for, or its running login check. */
  private async owner(device: AuthenticatedDevice, scope: AuthHintScope): Promise<AuthOwner> {
    if (scope.kind === 'task') {
      const job = await this.prisma.publishJob.findFirst({
        where: {
          id: scope.id, status: PublishJobStatus.NEEDS_ACTION, lockedAt: { not: null }, extensionClaimDeviceId: device.id, lastErrorCode: null,
          target: { campaign: { ownerId: device.ownerId } },
          platformAccount: { settings: { path: ['delivery'], equals: EXTENSION_CONNECTOR_KEY } },
        },
        select: { id: true, platformAccountId: true, platformAccount: { select: { settings: true } } },
      });
      const session = job && sessionOf(job.platformAccount.settings);
      if (!job || !session || session.deviceId !== device.id) throw new NotFoundException('Claimed extension task not found');
      const settings = parseExtensionDeliverySettings(job.platformAccount.settings);
      return { link: { publishJobId: job.id }, accountId: job.platformAccountId, session, engine: settings.engine,
        origins: [new URL(settings.targetUrl).origin, session.origin, ...(session.allowedOrigins ?? [])] };
    }
    const check = await this.prisma.extensionLoginCheck.findFirst({
      where: { id: scope.id, deviceId: device.id, status: 'RUNNING', account: { ownerId: device.ownerId } },
      select: { id: true, platformAccountId: true, method: true, account: { select: { settings: true } } },
    });
    const session = check && loginSession(check.account.settings, check.method);
    if (!check || !session || session.deviceId !== device.id) throw new NotFoundException('Active login check for this Chrome profile not found');
    const settings = object(check.account.settings);
    const engine = object(settings.extensionLoginTarget).engine ?? settings.extensionEngine;
    return { link: { loginCheckId: check.id }, accountId: check.platformAccountId, session, engine: typeof engine === 'string' ? engine.slice(0, 40) : 'generic',
      origins: [session.origin, ...(session.allowedOrigins ?? [])] };
  }

  async request(device: AuthenticatedDevice, scope: AuthHintScope, dto: AuthHintRequestDto): Promise<AuthHintView> {
    if (!this.enabled()) throw new NotFoundException('AI-assisted UI recovery is disabled');
    const owner = await this.owner(device, scope);
    const page = new URL(dto.url);
    if (!owner.origins.includes(page.origin)) throw new BadRequestException('The page is not on this account sign-in origins');
    if (await this.prisma.extensionUiHint.count({ where: { ...owner.link, missing: { has: AUTH_HINT } } }) >= MAX_AUTH_HINTS) {
      throw new HttpException('This sign-in already used its AI hints', HttpStatus.TOO_MANY_REQUESTS);
    }
    const usage = await this.redis?.consumeRateLimit(uiHintRateKey(device.id), HINTS_PER_DEVICE_PER_HOUR, 3_600);
    if (usage && !usage.allowed) throw new HttpException('Too many AI hints from this Chrome profile; try again later', HttpStatus.TOO_MANY_REQUESTS);
    let candidates: UiCandidate[];
    try { candidates = sanitizeCandidates(dto.candidates); } catch (error) { throw new BadRequestException(error instanceof Error ? error.message : 'Invalid candidates'); }
    const path = page.pathname.slice(0, 300);
    const hint = await this.prisma.extensionUiHint.create({
      data: {
        ownerId: device.ownerId, ...owner.link, deviceId: device.id, engine: owner.engine, origin: page.origin, path, missing: [AUTH_HINT],
        candidates: candidates.map((candidate) => ({ ...describe(candidate), selector: candidate.selector })), status: 'RUNNING',
      },
      select: { id: true },
    });
    const work = this.resolve(hint.id, owner, path, candidates);
    await Promise.race([work, new Promise((resolve) => { setTimeout(resolve, INLINE_WAIT_MS).unref?.(); })]);
    return this.get(device, scope, hint.id);
  }

  async get(device: AuthenticatedDevice, scope: AuthHintScope, hintId: string): Promise<AuthHintView> {
    const hint = await this.prisma.extensionUiHint.findFirst({
      where: { id: hintId, ...(scope.kind === 'task' ? { publishJobId: scope.id } : { loginCheckId: scope.id }), deviceId: device.id, ownerId: device.ownerId, missing: { has: AUTH_HINT } },
      select: { id: true, status: true, result: true, errorCode: true, createdAt: true },
    });
    if (!hint) throw new NotFoundException('AI hint not found');
    if (hint.status === 'RUNNING' && Date.now() - hint.createdAt.getTime() > STALE_AFTER_MS) {
      await this.prisma.extensionUiHint.updateMany({ where: { id: hint.id, status: 'RUNNING' }, data: { status: 'FAILED', errorCode: 'TIMEOUT', finishedAt: new Date() } });
      return { hintId: hint.id, status: 'FAILED', errorCode: 'TIMEOUT' };
    }
    if (hint.status === 'READY') {
      const result = record(hint.result);
      const signedIn = ['yes', 'no', 'unknown'].includes(String(result.signedIn)) ? result.signedIn as AuthHintView['signedIn'] : 'unknown';
      return { hintId: hint.id, status: 'READY', signedIn, selectors: record(result.selectors),
        confidence: typeof result.confidence === 'number' ? result.confidence : undefined };
    }
    return { hintId: hint.id, status: hint.status === 'FAILED' ? 'FAILED' : 'RUNNING', ...(hint.errorCode ? { errorCode: hint.errorCode } : {}) };
  }

  /**
   * The extension confirmed the AI's account element against the configured
   * username: keep it as the account's identity selector, unless the operator
   * set one by hand (theirs always wins).
   */
  async confirm(device: AuthenticatedDevice, scope: AuthHintScope, hintId: string, selector: string): Promise<{ saved: boolean }> {
    const owner = await this.owner(device, scope);
    const hint = await this.prisma.extensionUiHint.findFirst({
      where: { id: hintId, ...owner.link, deviceId: device.id, ownerId: device.ownerId, status: 'READY', missing: { has: AUTH_HINT } },
      select: { result: true },
    });
    if (!hint) throw new NotFoundException('AI hint not found');
    if (record(record(hint.result).selectors).account !== selector) throw new BadRequestException('The selector is not the account element of this hint');
    const saved = await this.prisma.$transaction(async (tx) => {
      const account = await tx.platformAccount.findUnique({ where: { id: owner.accountId }, select: { settings: true } });
      const settings = record(account?.settings);
      const session = record(settings.extensionSession);
      const current = typeof session.identitySelector === 'string' ? session.identitySelector.trim() : '';
      if (current && session.identitySelectorSource !== 'ai') return false;
      if (current === selector) return true;
      await tx.platformAccount.update({ where: { id: owner.accountId },
        data: { settings: { ...settings, extensionSession: { ...session, identitySelector: selector, identitySelectorSource: 'ai' } } } });
      return true;
    });
    if (saved) {
      await this.audit?.recordBestEffort({ actorId: device.ownerId, action: 'EXTENSION_IDENTITY_SELECTOR_LEARNED', entityType: 'platform-accounts', entityId: owner.accountId,
        after: { identitySelector: selector, hintId } });
    }
    return { saved };
  }

  /** Never throws: the outcome is stored on the hint row. */
  private async resolve(hintId: string, owner: AuthOwner, path: string, candidates: UiCandidate[]): Promise<void> {
    const provider = this.config.get<AiProvider>('EXTENSION_UI_HINT_PROVIDER');
    try {
      let profilePath: string | undefined;
      try { profilePath = owner.session.profileUrl ? new URL(owner.session.profileUrl).pathname : undefined; } catch { profilePath = undefined; }
      // Element descriptions and the expected handle only: no credentials, no values.
      const input = JSON.stringify({ engine: owner.engine, path, expectedAccount: { username: owner.session.expectedUsername || undefined, profilePath },
        candidates: candidates.map(describe) });
      const answer = await this.ai.generateStructured(AUTH_HINT_SPEC, AUTH_HINT_INSTRUCTIONS, input, provider);
      const minConfidence = Number(this.config.get<number>('EXTENSION_UI_HINT_MIN_CONFIDENCE', 0.6));
      const { signedIn, picks } = validateAuthHint(answer, candidates, minConfidence);
      const selectors = Object.fromEntries(Object.entries(picks).map(([field, candidate]) => [field, candidate.selector]));
      await this.prisma.extensionUiHint.update({
        where: { id: hintId },
        data: { status: 'READY', provider: provider ?? null, finishedAt: new Date(),
          result: { signedIn, selectors, confidence: answer.confidence, reason: answer.reason.slice(0, 300),
            picked: Object.fromEntries(Object.entries(picks).map(([field, candidate]) => [field, candidate.index])) } },
      });
    } catch (error) {
      const code = error instanceof ApplicationException ? error.code : 'AI_HINT_FAILED';
      this.logger.warn(`AI sign-in hint ${hintId} failed: ${error instanceof Error ? error.message : 'unknown error'}`);
      await this.prisma.extensionUiHint.update({ where: { id: hintId }, data: { status: 'FAILED', errorCode: String(code).slice(0, 80), finishedAt: new Date() } })
        .catch(() => undefined);
    }
  }
}
