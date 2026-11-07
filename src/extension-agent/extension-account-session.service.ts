import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { CredentialStatus, PublishJobStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { CredentialsService } from '../credentials/credentials.service';
import { CredentialEncryptionService } from '../credentials/credential-encryption.service';
import { freshTotp, generateTotp } from '../auth/totp-provider';
import { parseExtensionDeliverySettings } from '../connectors/extension/extension-delivery';
import type { AuthenticatedDevice } from './extension-agent.service';
import { ExtensionAuthStepDto, ExtensionSessionDto } from './extension-agent.dto';

export const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
export interface ExtensionSession {
  deviceId: string;
  expectedUsername: string;
  profileUrl: string;
  identitySelector: string;
  /** 'ai' when the extension learned it from a confirmed AI sign-in hint; the operator's own selector has none. */
  identitySelectorSource?: 'ai';
  origin: string;
  provider: 'password' | 'google';
  autoLogin: boolean;
  autoTotp: boolean;
  loginUrl: string;
  loginUsername: string;
  discoverIdentity?: boolean;
  allowIdentityByEmail?: boolean;
  allowedOrigins?: string[];
}
/**
 * Sites that moved their web app to another origin. Sessions saved before the
 * move keep working: the extension is sent the new origin and login URL.
 */
export const MOVED_ORIGINS: Readonly<Record<string, string>> = { 'https://app.daily.dev': 'https://daily.dev' };

export function movedUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const target = MOVED_ORIGINS[parsed.origin];
    return target ? `${target}${parsed.pathname}${parsed.search}${parsed.hash}` : url;
  } catch { return url; }
}

/**
 * Sites whose sign-in page lives on another origin, for every account of that
 * site. Sessions saved without it (an older import, or a form save that dropped
 * it) still let the login check follow the redirect.
 */
export const SITE_LOGIN_ORIGINS: Readonly<Record<string, readonly string[]>> = {
  'https://social.vivaldi.net': ['https://login.vivaldi.net'],
  // MongoDB Community (www.mongodb.com/community/forums) signs in through MongoDB Cloud.
  'https://www.mongodb.com': ['https://account.mongodb.com'],
};

export function sessionOf(settings: unknown): ExtensionSession | undefined {
  const session = object(object(settings).extensionSession);
  if (typeof session.deviceId !== 'string' || typeof session.expectedUsername !== 'string') return undefined;
  let stored = session as unknown as ExtensionSession;
  if (MOVED_ORIGINS[stored.origin]) stored = { ...stored, origin: MOVED_ORIGINS[stored.origin]!, loginUrl: movedUrl(stored.loginUrl) };
  const siteLogin = SITE_LOGIN_ORIGINS[stored.origin] ?? [];
  const allowed = stored.allowedOrigins ?? [];
  return siteLogin.some(origin => !allowed.includes(origin)) ? { ...stored, allowedOrigins: [...new Set([...allowed, ...siteLogin])] } : stored;
}
export function sessionScope(settings: unknown): string {
  const loginTarget = object(object(settings).extensionLoginTarget);
  const url = new URL(movedUrl(typeof loginTarget.url === 'string' ? loginTarget.url : parseExtensionDeliverySettings(settings).targetUrl));
  if (url.hostname.endsWith('.quora.com')) return 'https://quora.com';
  if (url.hostname.endsWith('.substack.com')) return 'https://substack.com';
  return url.origin;
}

const REGISTRATION_SEGMENT = /^(?:sign[-_]?up|register|registration|join|create[-_]?account|new[-_]?account)(?:\.[a-z0-9]+)?$/i;

/**
 * Sign-up forms ask for the same e-mail and password as a login form; a login
 * secret must never be typed into one (it would create an account, or leak the
 * password to a registration flow). Matches a path segment such as Discourse
 * `/signup`, `/users/sign_up`, `/register`, `/join`, `/create-account`, or the
 * phpBB `ucp.php?mode=register` page.
 */
export function isRegistrationPage(page: URL): boolean {
  if (page.pathname.split('/').some((segment) => REGISTRATION_SEGMENT.test(decodeSegment(segment)))) return true;
  return /^register$/i.test(page.searchParams.get('mode') ?? '');
}

function decodeSegment(segment: string): string {
  try { return decodeURIComponent(segment); } catch { return segment; }
}

/** Legacy unbound accounts work only when there is one device and one account
 * in their cookie scope. A second account never inherits the first one's login. */
export function deviceCanRunAccount(account: { id: string; settings: unknown }, deviceId: string,
  accounts: Array<{ id: string; settings: unknown }>, deviceCount: number, authProtocol?: number): boolean {
  const session = sessionOf(account.settings);
  if (session) return authProtocol === 1 && session.deviceId === deviceId;
  if (deviceCount !== 1) return false;
  try { return accounts.filter(other => { try { return sessionScope(other.settings) === sessionScope(account.settings); } catch { return false; } }).length === 1; }
  catch { return false; }
}

@Injectable()
export class ExtensionAccountSessionService {
  constructor(private readonly prisma: PrismaService, private readonly credentials: CredentialsService,
    private readonly encryption: CredentialEncryptionService) {}

  async configure(ownerId: string, accountId: string, dto: ExtensionSessionDto) {
    return this.prisma.$transaction(async tx => {
      // Serialize profile bindings for one owner, including concurrent form saves.
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${ownerId}, 7301))::text`;
      const account = await tx.platformAccount.findFirst({ where: { id: accountId, ownerId }, include: { credential: true } });
      if (!account || (object(account.settings).delivery !== 'extension' && !object(account.settings).extensionLoginTarget)) throw new NotFoundException('Configure extension delivery for this account first');
      const settings = object(account.settings);
      if (!dto.expectedUsername.trim()) throw new BadRequestException('Platform username is required');
      const loginTarget = object(settings.extensionLoginTarget);
      const target = new URL(movedUrl(typeof loginTarget.url === 'string' ? loginTarget.url : parseExtensionDeliverySettings(settings).targetUrl));
      const device = await tx.extensionDevice.findFirst({ where: { id: dto.deviceId, ownerId, revokedAt: null }, select: { id: true } });
      if (!device) throw new BadRequestException('Choose an active paired Chrome profile owned by you');
      const busy = await tx.publishJob.count({ where: { platformAccountId: accountId, status: PublishJobStatus.NEEDS_ACTION,
        lockedAt: { not: null }, OR: [{ lastErrorCode: null }, { lastErrorCode: { not: 'EXTENSION_MODERATION_PENDING' } }] } });
      if (busy) throw new BadRequestException('This account has a claimed task; resolve or requeue it before changing its session');
      const others = await tx.platformAccount.findMany({ where: { ownerId, id: { not: accountId } }, select: { name: true, settings: true } });
      // One Chrome profile holds one signed-in account per site (its cookies). Moving an
      // account onto a profile that already holds another account of the same site is
      // refused. An account already sharing it (an older file import) can still be edited:
      // the save changes nothing about that, and the response names the other account.
      const alreadyOnProfile = sessionOf(settings)?.deviceId === dto.deviceId;
      const sharedWith: string[] = [];
      const googleIdentities = new Set<string>();
      for (const other of others) {
        const session = sessionOf(other.settings);
        if (session?.deviceId !== dto.deviceId) continue;
        if (sessionScope(other.settings) === sessionScope(settings)) {
          if (!alreadyOnProfile) {
            throw new BadRequestException(`Hồ sơ Chrome này đang giữ tài khoản ${other.name} của cùng nền tảng. Mỗi hồ sơ Chrome chỉ đăng nhập được một tài khoản trên một nền tảng: ghép thêm một hồ sơ Chrome cho tài khoản này, hoặc chuyển ${other.name} sang hồ sơ khác trước.`);
          }
          sharedWith.push(other.name);
        }
        if (session.autoLogin && session.provider === 'google' && session.loginUsername) googleIdentities.add(session.loginUsername.trim().toLowerCase());
      }
      // A Chrome profile signs in the Google accounts its platforms use. A new Google
      // identity needs its own profile, but one this profile already uses stays allowed:
      // profiles moved from another Chrome can carry several, and must stay editable.
      const googleEmail = dto.loginUsername?.trim().toLowerCase() ?? '';
      if (dto.autoLogin && dto.provider === 'google' && googleIdentities.size && !googleIdentities.has(googleEmail)) {
        throw new BadRequestException(`Hồ sơ Chrome này đang dùng Google ${[...googleIdentities].sort().join(', ')}. Chọn một trong các email đó, hoặc ghép một hồ sơ Chrome khác cho Google mới.`);
      }
      const trustedUrl = (raw: string, label: string) => {
        let url: URL;
        try { url = new URL(raw); } catch { throw new BadRequestException(`${label} must be an absolute URL`); }
        if (url.origin !== target.origin || url.username || url.password || url.hash) throw new BadRequestException(`${label} must use the destination origin without credentials or a fragment`);
        return url.href;
      };
      let profileUrl = '';
      if (dto.profileUrl?.trim()) {
        let url: URL;
        try { url = new URL(dto.profileUrl.trim()); } catch { throw new BadRequestException('Invalid profile URL'); }
        if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw new BadRequestException('Profile URL must be HTTPS without credentials or a fragment');
        profileUrl = url.href;
      }
      const loginUrl = dto.autoLogin ? trustedUrl(dto.loginUrl?.trim() ?? '', 'Login URL') : '';
      const stored = account.credential?.status === CredentialStatus.ACTIVE ? this.encryption.decrypt(account.credential.encryptedPayload) : {};
      const previous = object(stored.extensionLogin);
      // Blank means keep an existing secret only for the same login identity/provider.
      const oldSession = sessionOf(settings);
      const sameLogin = oldSession?.provider === dto.provider && oldSession.loginUsername === dto.loginUsername?.trim();
      const password = dto.password || (sameLogin ? previous.password : undefined);
      const seed = dto.totpSecret?.trim() || (sameLogin ? previous.totpSecret : undefined);
      if (dto.autoLogin && (!dto.loginUsername?.trim() || (dto.provider === 'password' && (typeof password !== 'string' || !password)))) throw new BadRequestException('Login username and password are required for password login');
      if (dto.autoLogin && dto.autoTotp) {
        if (typeof seed !== 'string' || !seed) throw new BadRequestException('Supply the TOTP setup key or otpauth URL, not a six-digit code');
        try { generateTotp(seed); } catch { throw new BadRequestException('Invalid TOTP setup key or otpauth URL'); }
      }
      // The form does not edit these: the extra sign-in origins and e-mail identity
      // matching set at import stay while the account keeps the same site.
      const previousSession = sessionOf(settings);
      const kept = previousSession?.origin === target.origin ? {
        ...(previousSession.allowedOrigins?.length ? { allowedOrigins: previousSession.allowedOrigins } : {}),
        ...(previousSession.allowIdentityByEmail ? { allowIdentityByEmail: true } : {}),
      } : {};
      const session: ExtensionSession = { deviceId: dto.deviceId, origin: target.origin, expectedUsername: dto.expectedUsername.trim(),
        profileUrl, identitySelector: dto.identitySelector?.trim() ?? '', provider: dto.provider,
        autoLogin: dto.autoLogin, autoTotp: dto.autoLogin && dto.autoTotp, loginUrl, loginUsername: dto.loginUsername?.trim() ?? '', ...kept };
      // Explicitly configuring a fresh login must clear an older token expiry.
      const secret = dto.autoLogin ? { username: session.loginUsername, ...(typeof password === 'string' ? { password } : {}), ...(session.autoTotp ? { totpSecret: seed } : {}) } : null;
      const methods = { ...object(settings.extensionLoginMethods), [dto.provider]: { available: dto.autoLogin, username: session.loginUsername, loginUrl, autoTotp: session.autoTotp } };
      await this.credentials.upsert(accountId, { ...stored, extensionLogin: secret,
        extensionLoginMethods: dto.autoLogin ? { ...object(stored.extensionLoginMethods), [dto.provider]: secret } : {},
      }, dto.autoLogin ? null : undefined, tx);
      await tx.platformAccount.update({ where: { id: accountId }, data: { settings: { ...settings, extensionSession: { ...session }, extensionLoginMethods: dto.autoLogin ? methods : {} } as Prisma.InputJsonObject } });
      return { ...session, passwordConfigured: dto.autoLogin && Boolean(password), totpConfigured: session.autoTotp,
        // Other accounts of this site on the same profile: only one of them can be signed in at a time.
        ...(sharedWith.length ? { sharedWith } : {}) };
    }, { timeout: 10_000 });
  }

  async authStep(device: AuthenticatedDevice, jobId: string, dto: ExtensionAuthStepDto) {
    const job = await this.prisma.publishJob.findFirst({ where: { id: jobId, extensionClaimDeviceId: device.id,
      status: PublishJobStatus.NEEDS_ACTION, lockedAt: { not: null }, lastErrorCode: null,
      target: { campaign: { ownerId: device.ownerId } }, platformAccount: { enabled: true, settings: { path: ['delivery'], equals: 'extension' } } },
      select: { platformAccountId: true, platformAccount: { select: { settings: true } } } });
    if (!job) throw new NotFoundException('Active task claimed by this Chrome profile not found');
    const session = sessionOf(job.platformAccount.settings);
    if (!session || session.deviceId !== device.id || !session.autoLogin) throw new ForbiddenException('Automatic login is not enabled for this account and profile');
    let page: URL;
    try { page = new URL(dto.pageUrl); } catch { throw new BadRequestException('Invalid authentication URL'); }
    const allowed = session.provider === 'google' ? page.origin === 'https://accounts.google.com' : page.origin === session.origin;
    if (!allowed || page.username || page.password || (page.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(page.hostname))) throw new ForbiddenException('Authentication origin does not match this account');
    // The extension stops the task as "sign-in required" on any refusal; nothing is released.
    if (isRegistrationPage(page)) throw new ForbiddenException('This page is a sign-up form, not a login form; sign in manually in this Chrome profile');
    if (dto.step === 'totp' && !session.autoTotp) throw new ForbiddenException('TOTP is not configured for this account');
    const secret = object((await this.credentials.resolve(job.platformAccountId)).extensionLogin);
    if (dto.step === 'identifier') return { username: secret.username };
    const field = dto.step === 'password' ? 'extensionPasswordIssuedAt' : 'extensionTotpIssuedAt';
    const reserved = await this.prisma.publishJob.updateMany({ where: { id: jobId, extensionClaimDeviceId: device.id,
      status: PublishJobStatus.NEEDS_ACTION, lastErrorCode: null, [field]: null }, data: { [field]: new Date() } });
    if (!reserved.count) throw new BadRequestException('This login step was already attempted; check the account before retrying');
    if (dto.step === 'password') return { username: secret.username, password: secret.password };
    if (typeof secret.totpSecret !== 'string') throw new BadRequestException('TOTP is not configured');
    return freshTotp(secret.totpSecret);
  }
}
