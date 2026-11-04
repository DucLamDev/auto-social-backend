import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHash } from 'node:crypto';
import { runAccountUploadParser } from '../common/utils/account-upload-parser';
import { PrismaService } from '../database/prisma.service';
import { CredentialsService } from '../credentials/credentials.service';
import { CredentialEncryptionService } from '../credentials/credential-encryption.service';
import { generateTotp } from '../auth/totp-provider';
import { extensionFlowForPlatform } from '../connectors/extension/extension-flows';
import { defaultExtensionDelivery } from './extension-delivery-defaults';
import { ExtensionLoginCheckService } from './extension-login-check.service';
import { object, sessionOf } from './extension-account-session.service';

export interface AccountImportRow {
  source: string; platform: string; label: string; loginUsername: string; password: string;
  provider: 'google' | 'password'; totpSecret: string; profileUrl: string; expectedUsername: string;
  targetUrl?: string; tags?: string; category?: string;
}
export const LOGIN_URLS: Record<string, string> = {
  x: 'https://x.com/i/flow/login', linkedin: 'https://www.linkedin.com/login', tiktok: 'https://www.tiktok.com/login',
  wordpress: 'https://wordpress.com/log-in', medium: 'https://medium.com/m/signin', blogger: 'https://www.blogger.com/about/',
  substack: 'https://substack.com/sign-in', tumblr: 'https://www.tumblr.com/login', devto: 'https://dev.to/enter',
  quora: 'https://www.quora.com/', reddit: 'https://www.reddit.com/login/', bluesky: 'https://bsky.app/',
  mastodon: 'https://mastodon.social/auth/sign_in', 'vivaldi-social': 'https://social.vivaldi.net/auth/sign_in',
  'pixelfed-social': 'https://pixelfed.social/login', 'lemmy-world': 'https://lemmy.world/login',
  discuit: 'https://discuit.org/', minds: 'https://www.minds.com/login', mewe: 'https://mewe.com/login',
  dzone: 'https://dzone.com/', 'daily-dev': 'https://daily.dev/', differ: 'https://differ.blog/',
  'product-hunt': 'https://www.producthunt.com/login', dailymotion: 'https://www.dailymotion.com/',
  'stack-overflow': 'https://stackoverflow.com/users/login', 'server-fault': 'https://serverfault.com/users/login',
  'hugging-face': 'https://huggingface.co/login', 'linux-foundation-forum': 'https://forum.linuxfoundation.org/',
  'warrior-forum': 'https://www.warriorforum.com/', disqus: 'https://disqus.com/profile/login/',
  'ubiquiti-community': 'https://community.ui.com/', 'unix-linux-stackexchange': 'https://unix.stackexchange.com/users/login',
  'redis-community-forum': 'https://forum.redis.io/login', tinhte: 'https://tinhte.vn/login/',
};

export async function parseAccountUpload(buffer: Buffer, extension: string): Promise<AccountImportRow[]> {
  const rows = await runAccountUploadParser(buffer, extension, 'login',
    'Không đọc được file. Cần cột Social Network, User/Email; Pass, 2FA, URL Profile và URL đăng bài là tùy chọn.',
    (row) => {
      const values = object(row);
      return ['source', 'platform', 'label', 'loginUsername', 'password', 'totpSecret', 'profileUrl', 'expectedUsername'].every(key => typeof values[key] === 'string')
        && ['google', 'password'].includes(String(values.provider));
    });
  return rows as AccountImportRow[];
}

/**
 * Each row signs in with its own account: social networks in one file use many
 * different Google accounts, so no Google login is shared between rows.
 */
export function importLogin(row: AccountImportRow) {
  const provider = row.provider === 'google' || (!row.password && row.loginUsername.includes('@')) ? 'google' : 'password';
  return { provider, username: row.loginUsername.trim() } as const;
}

/** Settings that decide where and how an account posts; a change here is a real update. */
const ROUTE_KEYS = ['delivery', 'extensionEngine', 'extensionTargetUrl', 'extensionTags', 'extensionCategory', 'extensionAutoSubmit'] as const;

@Injectable()
export class AccountImportService {
  constructor(private readonly prisma: PrismaService, private readonly credentials: CredentialsService,
    private readonly encryption: CredentialEncryptionService, private readonly checks: ExtensionLoginCheckService) {}

  async import(ownerId: string, deviceId: string, rows: AccountImportRow[]) {
    const device = await this.prisma.extensionDevice.findFirst({ where: { id: deviceId, ownerId, revokedAt: null } });
    if (!device) throw new BadRequestException('Chọn Chrome đã ghép nối của bạn.');
    // Every catalog platform: adding an account turns a switched-off platform on (the
    // Platforms page with its switches is gone).
    const platforms = new Map((await this.prisma.platform.findMany()).map(p => [p.slug, p]));
    const result: Array<{ id?: string; row: string; name: string; setup?: string; issue?: string }> = [];
    // Only accounts that are new or now sign in differently get a login check; the
    // ones already in place keep their session, state and switch.
    const ids: string[] = [];
    let saved = 0;
    let skipped = 0;
    const switchedOn = new Set<string>();
    await this.prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${ownerId}, 7301))::text`;
      const owned = await tx.platformAccount.findMany({ where: { ownerId }, include: { credential: true } });
      const importedKeys = new Set<string>();
      for (const row of rows) {
        const platform = platforms.get(row.platform), flow = extensionFlowForPlatform(row.platform);
        const loginUrl = LOGIN_URLS[row.platform] || (flow ? `${flow.forumUrl}/login` : '');
        if (!platform || !loginUrl) { result.push({ row: row.source, name: row.label, issue: 'PLATFORM_NOT_SUPPORTED' }); continue; }
        const login = importLogin(row);
        if (!login.username || (login.provider === 'google' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(login.username))) { result.push({ row: row.source, name: platform.name, issue: 'LOGIN_EMAIL_REQUIRED' }); continue; }
        const key = createHash('sha256').update([platform.slug, login.provider, login.username.toLowerCase(), row.profileUrl.trim()].join('|')).digest('hex');
        if (importedKeys.has(key)) continue;
        importedKeys.add(key);
        const old = owned.find(a => a.platformId === platform.id && (object(object(a.settings).extensionImport).uploadKey === key
          || (sessionOf(a.settings)?.loginUsername.toLowerCase() === login.username.toLowerCase() && sessionOf(a.settings)?.profileUrl === row.profileUrl.trim())));
        const previous = object(old?.settings), previousSession = sessionOf(previous);
        const stored = old?.credential?.status === 'ACTIVE' ? this.encryption.decrypt(old.credential.encryptedPayload) : {};
        const sameLogin = previousSession?.provider === login.provider && previousSession.loginUsername.toLowerCase() === login.username.toLowerCase();
        const priorSecret = sameLogin ? object(stored.extensionLogin) : {};
        // For a Google row the password and 2FA key are those of that row's own
        // Google account; empty cells keep what was stored for the same login.
        const password = row.password || priorSecret.password;
        const seed = row.totpSecret || priorSecret.totpSecret;
        if (seed) { try { if (typeof seed !== 'string') throw new Error('Invalid seed'); generateTotp(seed); } catch { result.push({ row: row.source, name: platform.name, issue: 'INVALID_TOTP' }); continue; } }
        const username = row.expectedUsername || (login.username.includes('@') ? '' : login.username);
        // The parser names no account for site screens (".../register/complete",
        // "/onboarding"): such a URL is not a profile to compare against.
        const session = { deviceId, provider: login.provider, origin: new URL(loginUrl).origin, loginUrl, loginUsername: login.username,
          expectedUsername: username, profileUrl: row.expectedUsername ? row.profileUrl.trim() : '', identitySelector: previousSession?.identitySelector ?? '',
          autoLogin: login.provider === 'google' || Boolean(password), autoTotp: Boolean(seed) && object(previousSession).totpNeedsReview !== true,
          totpNeedsReview: object(previousSession).totpNeedsReview === true,
          discoverIdentity: !username, allowIdentityByEmail: true, allowedOrigins: previousSession?.allowedOrigins ?? (platform.slug === 'vivaldi-social' ? ['https://login.vivaldi.net'] : []) };
        const settings: Record<string, unknown> = { ...previous, extensionSession: session, extensionAutoConnect: true,
          extensionImport: { ...object(previous.extensionImport), selected: true, uploadKey: key, sources: [row.source], issues: [] },
          extensionLoginTarget: { url: loginUrl.replace(/\/login\/?$/, ''), engine: flow?.engine ?? 'generic' } };
        const route = defaultExtensionDelivery(platform.slug, previous, {
          targetUrl: row.targetUrl, category: row.category, ...(row.tags ? { tags: row.tags.split(',').map(t => t.trim()).filter(Boolean) } : {}),
        });
        if (route.status === 'INVALID') { result.push({ row: row.source, name: platform.name, issue: 'INVALID_POST_DESTINATION' }); continue; }
        const setup = route.status;
        Object.assign(settings, route.status === 'READY' ? route.settings : { extensionSetup: { status: route.status } });
        const name = `${platform.name} · ${username || login.username}`;
        // Same login, same Chrome: the session is still valid, so a re-uploaded file
        // must neither switch the account off nor sign it in again.
        const relogin = !old || !sameLogin || previousSession?.deviceId !== deviceId;
        const newSecret = Boolean((row.password && row.password !== priorSecret.password) || (row.totpSecret && row.totpSecret !== priorSecret.totpSecret));
        const routeChanged = ROUTE_KEYS.some(field => JSON.stringify(previous[field] ?? null) !== JSON.stringify(settings[field] ?? null));
        if (old && !relogin && !newSecret && !routeChanged) { skipped++; result.push({ id: old.id, row: row.source, name: old.name, setup: 'UNCHANGED' }); continue; }
        if (old && (await tx.extensionLoginCheck.count({ where: { platformAccountId: old.id, status: { in: ['RUNNING', 'QUEUED'] } } })
          || await tx.publishJob.count({ where: { platformAccountId: old.id, status: { in: ['PROCESSING', 'QUEUED', 'SCHEDULED'] } } }))) { result.push({ id: old.id, row: row.source, name: old.name, issue: 'ACCOUNT_BUSY' }); continue; }
        if (platform.enabled === false && !switchedOn.has(platform.id)) {
          await tx.platform.update({ where: { id: platform.id }, data: { enabled: true } });
          switchedOn.add(platform.id);
        }
        // A route just gained by an account whose last check signed in connects it now.
        const newlyRouted = old && !relogin && previous.delivery !== 'extension' && settings.delivery === 'extension'
          && (await tx.extensionLoginCheck.findFirst({ where: { platformAccountId: old.id }, orderBy: { createdAt: 'desc' }, select: { status: true } }))?.status === 'AUTHENTICATED';
        const state = relogin ? { enabled: false, status: 'RECONNECT_REQUIRED' as const } : newlyRouted ? { enabled: true, status: 'CONNECTED' as const } : {};
        const account = old ? await tx.platformAccount.update({ where: { id: old.id }, data: { name, ...state, settings: settings as Prisma.InputJsonObject } })
          : await tx.platformAccount.create({ data: { ownerId, platformId: platform.id, name, username: username || null, enabled: false, status: 'RECONNECT_REQUIRED', settings: settings as Prisma.InputJsonObject } });
        const credential = { username: login.username, ...(password ? { password } : {}), ...(seed ? { totpSecret: seed } : {}) };
        const methods = { ...object(stored.extensionLoginMethods), [login.provider]: credential };
        const methodSettings = { ...object(previous.extensionLoginMethods), [login.provider]: {
          available: session.autoLogin, username: login.username, autoTotp: session.autoTotp, loginUrl,
        } };
        await this.credentials.upsert(account.id, { ...stored, extensionLogin: credential, extensionLoginMethods: methods }, null, tx);
        await tx.platformAccount.update({ where: { id: account.id }, data: { settings: { ...settings, extensionLoginMethods: methodSettings } as Prisma.InputJsonObject } });
        saved++;
        if (relogin) ids.push(account.id);
        result.push({ id: account.id, row: row.source, name, setup });
      }
    }, { timeout: 30_000 });
    const batch = ids.length ? await this.checks.queue(ownerId, ids, false, true) : { queued: 0, batchId: null };
    return { imported: saved, skipped, queued: batch.queued, batchId: batch.batchId, rows: result };
  }
}
