import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { CredentialStatus, PublishJobStatus } from '@prisma/client';
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
export function sessionOf(settings: unknown): ExtensionSession | undefined {
  const session = object(object(settings).extensionSession);
  return typeof session.deviceId === 'string' && typeof session.expectedUsername === 'string' ? session as unknown as ExtensionSession : undefined;
}
export function sessionScope(settings: unknown): string {
  const loginTarget = object(object(settings).extensionLoginTarget);
  const url = new URL(typeof loginTarget.url === 'string' ? loginTarget.url : parseExtensionDeliverySettings(settings).targetUrl);
  if (url.hostname.endsWith('.quora.com')) return 'https://quora.com';
  if (url.hostname.endsWith('.substack.com')) return 'https://substack.com';
  return url.origin;
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
      const target = new URL(typeof loginTarget.url === 'string' ? loginTarget.url : parseExtensionDeliverySettings(settings).targetUrl);
      const device = await tx.extensionDevice.findFirst({ where: { id: dto.deviceId, ownerId, revokedAt: null }, select: { id: true } });
      if (!device) throw new BadRequestException('Choose an active paired Chrome profile owned by you');
      const busy = await tx.publishJob.count({ where: { platformAccountId: accountId, status: PublishJobStatus.NEEDS_ACTION,
        lockedAt: { not: null }, OR: [{ lastErrorCode: null }, { lastErrorCode: { not: 'EXTENSION_MODERATION_PENDING' } }] } });
      if (busy) throw new BadRequestException('This account has a claimed task; resolve or requeue it before changing its session');
      const others = await tx.platformAccount.findMany({ where: { ownerId, id: { not: accountId } }, select: { settings: true } });
      for (const other of others) {
        const session = sessionOf(other.settings);
        if (session?.deviceId !== dto.deviceId) continue;
        if (sessionScope(other.settings) === sessionScope(settings)) throw new BadRequestException('This Chrome profile already belongs to another account on this platform. Pair a separate Chrome profile');
        if (dto.autoLogin && dto.provider === 'google' && session.autoLogin && session.provider === 'google'
          && session.loginUsername.toLowerCase() !== dto.loginUsername?.trim().toLowerCase()) {
          throw new BadRequestException('Use the same Google identity across platforms in one Chrome profile, or pair another profile');
        }
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
      if (dto.autoLogin && (!dto.loginUsername?.trim() || typeof password !== 'string' || !password)) throw new BadRequestException('Login username and password are required');
      if (dto.autoLogin && dto.autoTotp) {
        if (typeof seed !== 'string' || !seed) throw new BadRequestException('Supply the TOTP setup key or otpauth URL, not a six-digit code');
        try { generateTotp(seed); } catch { throw new BadRequestException('Invalid TOTP setup key or otpauth URL'); }
      }
      const session: ExtensionSession = { deviceId: dto.deviceId, origin: target.origin, expectedUsername: dto.expectedUsername.trim(),
        profileUrl, identitySelector: dto.identitySelector?.trim() ?? '', provider: dto.provider,
        autoLogin: dto.autoLogin, autoTotp: dto.autoLogin && dto.autoTotp, loginUrl, loginUsername: dto.loginUsername?.trim() ?? '' };
      // Explicitly configuring a fresh login must clear an older token expiry.
      await this.credentials.upsert(accountId, { ...stored, extensionLogin: dto.autoLogin ? {
        username: session.loginUsername, password, ...(session.autoTotp ? { totpSecret: seed } : {}),
      } : null }, dto.autoLogin ? null : undefined, tx);
      await tx.platformAccount.update({ where: { id: accountId }, data: { settings: { ...settings, extensionSession: { ...session } } } });
      return { ...session, passwordConfigured: dto.autoLogin, totpConfigured: session.autoTotp };
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
