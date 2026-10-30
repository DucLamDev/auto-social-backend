import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { PrismaService } from '../database/prisma.service';
import { CredentialsService } from '../credentials/credentials.service';
import { CredentialEncryptionService } from '../credentials/credential-encryption.service';
import { generateTotp } from '../auth/totp-provider';
import { extensionFlowForPlatform, validateExtensionFlow } from '../connectors/extension/extension-flows';
import { parseExtensionDeliverySettings } from '../connectors/extension/extension-delivery';
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
  dzone: 'https://dzone.com/', 'daily-dev': 'https://app.daily.dev/', differ: 'https://differ.blog/',
  'product-hunt': 'https://www.producthunt.com/login', dailymotion: 'https://www.dailymotion.com/',
  'stack-overflow': 'https://stackoverflow.com/users/login', 'server-fault': 'https://serverfault.com/users/login',
  'hugging-face': 'https://huggingface.co/login', 'linux-foundation-forum': 'https://forum.linuxfoundation.org/',
  'warrior-forum': 'https://www.warriorforum.com/', disqus: 'https://disqus.com/profile/login/',
  'ubiquiti-community': 'https://community.ui.com/', 'unix-linux-stackexchange': 'https://unix.stackexchange.com/users/login',
  'redis-community-forum': 'https://forum.redis.io/login', tinhte: 'https://tinhte.vn/login/',
};

// The parser receives bytes through stdin, never a shell command or a temporary
// credential file. Its private stdout is decoded here and is never logged.
export function parseAccountUpload(buffer: Buffer, extension: string): Promise<AccountImportRow[]> {
  if (!['xlsx', 'csv', 'tsv'].includes(extension) || buffer.length > 2 * 1024 * 1024) throw new BadRequestException('Chọn file XLSX, CSV hoặc TSV tối đa 2 MiB.');
  return new Promise((done, reject) => {
    const child = spawn(process.platform === 'win32' ? 'python' : 'python3', [resolve('scripts/parse-account-upload.py'), extension], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '', settled = false;
    const fail = () => { if (!settled) { settled = true; clearTimeout(timer); child.kill(); reject(new BadRequestException('Không đọc được file. Cần cột Social Network, User/Email; Pass, 2FA, URL Profile và URL đăng bài là tùy chọn.')); } };
    const timer = setTimeout(fail, 10_000);
    child.on('error', fail); child.stdin.on('error', fail);
    child.stderr.on('data', () => { /* Parser errors contain no cell values. */ });
    child.stdout.on('data', (data: Buffer) => { output += data.toString(); if (output.length > 8 * 1024 * 1024) fail(); });
    child.on('close', code => {
      if (settled) return;
      if (code !== 0) return fail();
      try {
        const rows: unknown = JSON.parse(output);
        if (!Array.isArray(rows) || !rows.length || rows.length > 500 || !rows.every((row: unknown): row is AccountImportRow => {
          const values = object(row);
          return ['source', 'platform', 'label', 'loginUsername', 'password', 'totpSecret', 'profileUrl', 'expectedUsername'].every(key => typeof values[key] === 'string')
            && ['google', 'password'].includes(String(values.provider));
        })) return fail();
        settled = true; clearTimeout(timer); done(rows);
      } catch { fail(); }
    });
    child.stdin.end(buffer);
  });
}

export function importLogin(row: AccountImportRow, googleEmail?: string) {
  const provider = row.provider === 'google' || (!row.password && row.loginUsername.includes('@')) ? 'google' : 'password';
  return { provider, username: provider === 'google' ? googleEmail?.trim() || row.loginUsername.trim() : row.loginUsername.trim() } as const;
}

@Injectable()
export class AccountImportService {
  constructor(private readonly prisma: PrismaService, private readonly credentials: CredentialsService,
    private readonly encryption: CredentialEncryptionService, private readonly checks: ExtensionLoginCheckService) {}

  async import(ownerId: string, deviceId: string, rows: AccountImportRow[], googleEmail?: string) {
    const device = await this.prisma.extensionDevice.findFirst({ where: { id: deviceId, ownerId, revokedAt: null } });
    if (!device) throw new BadRequestException('Chọn Chrome đã ghép nối của bạn.');
    const platforms = new Map((await this.prisma.platform.findMany({ where: { enabled: true } })).map(p => [p.slug, p]));
    const result: Array<{ id?: string; row: string; name: string; setup?: string; issue?: string }> = [];
    const ids: string[] = [];
    await this.prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${ownerId}, 7301))::text`;
      const owned = await tx.platformAccount.findMany({ where: { ownerId }, include: { credential: true } });
      const importedKeys = new Set<string>();
      for (const row of rows) {
        const platform = platforms.get(row.platform), flow = extensionFlowForPlatform(row.platform);
        const loginUrl = LOGIN_URLS[row.platform] || (flow ? `${flow.forumUrl}/login` : '');
        if (!platform || !loginUrl) { result.push({ row: row.source, name: row.label, issue: 'PLATFORM_NOT_SUPPORTED' }); continue; }
        const login = importLogin(row, googleEmail);
        if (!login.username || (login.provider === 'google' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(login.username))) { result.push({ row: row.source, name: platform.name, issue: 'LOGIN_EMAIL_REQUIRED' }); continue; }
        const key = createHash('sha256').update([platform.slug, login.provider, login.username.toLowerCase(), row.profileUrl.trim()].join('|')).digest('hex');
        if (importedKeys.has(key)) continue;
        importedKeys.add(key);
        const old = owned.find(a => a.platformId === platform.id && (object(object(a.settings).extensionImport).uploadKey === key
          || (sessionOf(a.settings)?.loginUsername.toLowerCase() === login.username.toLowerCase() && sessionOf(a.settings)?.profileUrl === row.profileUrl.trim())));
        if (old && (await tx.extensionLoginCheck.count({ where: { platformAccountId: old.id, status: { in: ['RUNNING', 'QUEUED'] } } })
          || await tx.publishJob.count({ where: { platformAccountId: old.id, status: { in: ['PROCESSING', 'QUEUED', 'SCHEDULED'] } } }))) { result.push({ id: old.id, row: row.source, name: old.name, issue: 'ACCOUNT_BUSY' }); continue; }
        const previous = object(old?.settings), previousSession = sessionOf(previous);
        const stored = old?.credential?.status === 'ACTIVE' ? this.encryption.decrypt(old.credential.encryptedPayload) : {};
        const sameLogin = previousSession?.provider === login.provider && previousSession.loginUsername.toLowerCase() === login.username.toLowerCase();
        const priorSecret = sameLogin ? object(stored.extensionLogin) : {};
        // A social password must never be reused as the password of a different
        // Google account selected in the import dialog.
        const password = row.password && (login.provider === 'password' || row.loginUsername.toLowerCase() === login.username.toLowerCase()) ? row.password : priorSecret.password;
        const seed = row.totpSecret && (!googleEmail || row.loginUsername.toLowerCase() === login.username.toLowerCase()) ? row.totpSecret : priorSecret.totpSecret;
        if (seed) { try { if (typeof seed !== 'string') throw new Error('Invalid seed'); generateTotp(seed); } catch { result.push({ row: row.source, name: platform.name, issue: 'INVALID_TOTP' }); continue; } }
        const username = row.expectedUsername || (login.username.includes('@') ? '' : login.username);
        const session = { deviceId, provider: login.provider, origin: new URL(loginUrl).origin, loginUrl, loginUsername: login.username,
          expectedUsername: username, profileUrl: row.profileUrl.trim(), identitySelector: previousSession?.identitySelector ?? '',
          autoLogin: login.provider === 'google' || Boolean(password), autoTotp: Boolean(seed) && object(previousSession).totpNeedsReview !== true,
          totpNeedsReview: object(previousSession).totpNeedsReview === true,
          discoverIdentity: !username, allowIdentityByEmail: true, allowedOrigins: previousSession?.allowedOrigins ?? (platform.slug === 'vivaldi-social' ? ['https://login.vivaldi.net'] : []) };
        let setup = flow ? 'DESTINATION_REQUIRED' : 'FLOW_REQUIRED';
        const settings: Record<string, unknown> = { ...previous, extensionSession: session, extensionAutoConnect: true,
          extensionImport: { ...object(previous.extensionImport), selected: true, uploadKey: key, sources: [row.source], issues: [] },
          extensionLoginTarget: { url: loginUrl.replace(/\/login\/?$/, ''), engine: flow?.engine ?? 'generic' } };
        const targetUrl = row.targetUrl?.trim() || previous.extensionTargetUrl || flow?.targetUrl;
        if (flow && targetUrl) {
          try {
            const target = parseExtensionDeliverySettings({ extensionEngine: flow.engine, extensionTargetUrl: targetUrl, extensionAutoSubmit: true,
              extensionTags: row.tags ? row.tags.split(',').map(t => t.trim()).filter(Boolean) : previous.extensionTags ?? [], extensionCategory: row.category || previous.extensionCategory });
            validateExtensionFlow(platform.slug, target);
            Object.assign(settings, { delivery: 'extension', extensionEngine: target.engine, extensionTargetUrl: target.targetUrl, extensionAutoSubmit: true,
              extensionTags: target.tags ?? [], extensionCategory: target.category ?? '', extensionFlowId: flow.id, extensionFlowRevision: flow.revision });
            setup = 'READY';
          } catch { result.push({ row: row.source, name: platform.name, issue: 'INVALID_POST_DESTINATION' }); continue; }
        }
        settings.extensionSetup = { status: setup };
        const name = `${platform.name} · ${username || login.username}`;
        const account = old ? await tx.platformAccount.update({ where: { id: old.id }, data: { name, enabled: false, status: 'RECONNECT_REQUIRED', settings: settings as Prisma.InputJsonObject } })
          : await tx.platformAccount.create({ data: { ownerId, platformId: platform.id, name, username: username || null, enabled: false, status: 'RECONNECT_REQUIRED', settings: settings as Prisma.InputJsonObject } });
        await this.credentials.upsert(account.id, { ...stored, extensionLogin: { username: login.username, ...(password ? { password } : {}), ...(seed ? { totpSecret: seed } : {}) } }, null, tx);
        ids.push(account.id); result.push({ id: account.id, row: row.source, name, setup });
      }
    }, { timeout: 30_000 });
    const batch = await this.checks.queue(ownerId, ids);
    return { imported: ids.length, queued: batch.queued, batchId: batch.batchId, rows: result };
  }
}
