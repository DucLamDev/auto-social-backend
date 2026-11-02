import { runAccountUploadParser } from '../common/utils/account-upload-parser';

/** One row of an API configuration file, as read by scripts/parse-account-upload.py (api mode). */
export interface ApiImportRow {
  source: string;
  platform: string;
  name: string;
  url: string;
  username: string;
  secret: string;
  categoryId: string;
  tags: string;
  publishNow: string;
  visibility: string;
}

export const API_IMPORT_ROW_KEYS = ['source', 'platform', 'name', 'url', 'username', 'secret', 'categoryId', 'tags', 'publishNow', 'visibility'] as const;

export async function parseApiAccountUpload(buffer: Buffer, extension: string): Promise<ApiImportRow[]> {
  const rows = await runAccountUploadParser(buffer, extension, 'api',
    'Không đọc được file. Cần cột Nền tảng và Khoá bí mật; xem file mẫu api-accounts.csv.',
    (row) => row !== null && typeof row === 'object'
      && API_IMPORT_ROW_KEYS.every((key) => typeof (row as Record<string, unknown>)[key] === 'string'));
  return rows as ApiImportRow[];
}

export const API_IMPORT_STATUSES = ['CONNECTED', 'CHECK_FAILED', 'OAUTH_REQUIRED', 'INVALID_ROW', 'NOT_SUPPORTED', 'ACCOUNT_BUSY', 'DUPLICATE_ROW'] as const;
export type ApiImportStatus = (typeof API_IMPORT_STATUSES)[number];

export interface ImportPlatform {
  id: string;
  slug: string;
  name: string;
  connectorKey: string;
  defaultSettings: Record<string, unknown>;
}

export interface MappedApiAccount {
  kind: 'ready';
  /** Stable, non-secret identity used to update the same account on a later import. */
  identity: string;
  /** Account username used to match accounts created in the form or the Chrome extension, when meaningful. */
  matchUsername?: string;
  username: string;
  name: string;
  credential: Record<string, string>;
  settings: Record<string, unknown>;
}

export interface SkippedApiRow {
  kind: 'skip';
  status: Extract<ApiImportStatus, 'OAUTH_REQUIRED' | 'NOT_SUPPORTED' | 'INVALID_ROW'>;
  message: string;
}

const OAUTH_CONNECTORS = new Set(['instagram', 'threads', 'blogger', 'linkedin', 'tumblr']);
const DISCORD_HOSTS = new Set(['discord.com', 'discordapp.com', 'canary.discord.com', 'ptb.discord.com']);
const MASTODON_VISIBILITY = new Set(['public', 'unlisted', 'private', 'direct']);
const BLUESKY_APP_PASSWORD = /^[a-z0-9]{4}(-[a-z0-9]{4}){3}$/i;

function normalizeName(value: string): string {
  return value.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/đ/g, 'd').replace(/[^a-z0-9]/g, '');
}

/** Matches a platform by slug or catalog name, ignoring case, accents and punctuation ("dev.to", "Mastodon.social"). */
export function resolveImportPlatform(label: string, platforms: ImportPlatform[]): ImportPlatform | undefined {
  const key = normalizeName(label);
  if (!key) return undefined;
  return platforms.find((platform) => normalizeName(platform.slug) === key)
    ?? platforms.find((platform) => normalizeName(platform.name) === key);
}

function skip(status: SkippedApiRow['status'], message: string): SkippedApiRow {
  return { kind: 'skip', status, message };
}

/** HTTPS origin plus optional path, without credentials, query, fragment or trailing slash. */
function httpsUrl(value: string): string | undefined {
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) return undefined;
    return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
  } catch {
    return undefined;
  }
}

function parseYesNo(value: string): boolean | undefined | 'invalid' {
  const key = normalizeName(value);
  if (!key) return undefined;
  if (['co', 'yes', 'true', '1', 'x'].includes(key)) return true;
  if (['khong', 'no', 'false', '0'].includes(key)) return false;
  return 'invalid';
}

function handle(value: string): string {
  return value.trim().replace(/^@/, '');
}

function defaultString(settings: Record<string, unknown>, key: string): string | undefined {
  const value = settings[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/**
 * Maps one row to the exact credential and setting keys the connector and the
 * web form use. Secrets are copied as-is and never appear in messages.
 */
export function mapApiImportRow(row: ApiImportRow, platform: ImportPlatform): MappedApiAccount | SkippedApiRow {
  const key = platform.connectorKey;
  if (OAUTH_CONNECTORS.has(key)) {
    return skip('OAUTH_REQUIRED', `${platform.name} cần bấm Kết nối trên trang Tài khoản và đăng nhập đồng ý quyền một lần; file không thay được bước này.`);
  }
  if (key === 'x') return skip('NOT_SUPPORTED', 'X chưa nhập được: token X hiện hết hạn sau khoảng 2 giờ và hệ thống chưa tự làm mới.');
  if (!['devto', 'mastodon', 'bluesky', 'discord', 'discourse', 'wordpress'].includes(key)) {
    return skip('NOT_SUPPORTED', `${platform.name} không có API đăng bài trong hệ thống; dùng tiện ích Chrome (Nhập file tài khoản).`);
  }
  const secret = row.secret.trim();
  if (!secret) return skip('INVALID_ROW', 'Thiếu Khoá bí mật.');
  const publishNow = parseYesNo(row.publishNow);
  if (publishNow === 'invalid') return skip('INVALID_ROW', 'Cột Đăng ngay chỉ nhận "có" hoặc "không".');
  const username = handle(row.username);
  const named = (fallback: string) => row.name.trim() || `${platform.name} · ${fallback}`;

  if (key === 'devto') {
    if (!username) return skip('INVALID_ROW', 'Thiếu Username dev.to (dùng để nhận ra tài khoản khi nhập lại).');
    const baseUrl = row.url.trim() ? httpsUrl(row.url) : defaultString(platform.defaultSettings, 'baseUrl') ?? 'https://dev.to/api';
    if (!baseUrl) return skip('INVALID_ROW', 'URL phải là địa chỉ HTTPS của Forem API, ví dụ https://dev.to/api.');
    return {
      kind: 'ready', identity: `devto:${username.toLowerCase()}`, matchUsername: username.toLowerCase(), username, name: named(username),
      credential: { apiKey: secret },
      settings: { baseUrl, ...(publishNow === undefined ? {} : { publishImmediately: publishNow }) },
    };
  }

  if (key === 'mastodon') {
    if (!username) return skip('INVALID_ROW', 'Thiếu Username Mastodon.');
    const fixedInstance = defaultString(platform.defaultSettings, 'instanceUrl');
    const instanceUrl = row.url.trim() ? httpsUrl(row.url) : fixedInstance;
    if (!instanceUrl) return skip('INVALID_ROW', 'Cần URL instance HTTPS, ví dụ https://mastodon.social.');
    if (fixedInstance && httpsUrl(fixedInstance) !== instanceUrl) {
      return skip('INVALID_ROW', `${platform.name} luôn dùng ${fixedInstance}; instance khác thì ghi nền tảng là Mastodon.`);
    }
    const visibility = row.visibility.trim().toLowerCase() || defaultString(platform.defaultSettings, 'visibility') || 'public';
    if (!MASTODON_VISIBILITY.has(visibility)) return skip('INVALID_ROW', 'Chế độ hiển thị chỉ nhận public, unlisted, private hoặc direct.');
    const host = new URL(instanceUrl).host;
    return {
      kind: 'ready', identity: `mastodon:${host}:${username.toLowerCase()}`, ...(fixedInstance ? { matchUsername: username.toLowerCase() } : {}),
      username, name: named(`@${username}`),
      credential: { instanceUrl, accessToken: secret },
      settings: { visibility },
    };
  }

  if (key === 'bluesky') {
    if (!username) return skip('INVALID_ROW', 'Thiếu Handle Bluesky, ví dụ ten.bsky.social.');
    if (!BLUESKY_APP_PASSWORD.test(secret)) {
      return skip('INVALID_ROW', 'Cần App Password dạng xxxx-xxxx-xxxx-xxxx (Settings → Privacy and security → App passwords), không dùng mật khẩu đăng nhập.');
    }
    const serviceUrl = row.url.trim() ? httpsUrl(row.url) : 'https://bsky.social';
    if (!serviceUrl) return skip('INVALID_ROW', 'URL PDS phải là HTTPS, mặc định https://bsky.social.');
    return {
      kind: 'ready', identity: `bluesky:${username.toLowerCase()}`, matchUsername: username.toLowerCase(), username, name: named(username),
      credential: { identifier: username, appPassword: secret, serviceUrl },
      settings: {},
    };
  }

  if (key === 'discord') {
    let webhookId: string | undefined;
    try {
      const url = new URL(secret);
      const match = /^\/api\/webhooks\/(\d+)\/[\w-]+\/?$/.exec(url.pathname);
      if (url.protocol === 'https:' && DISCORD_HOSTS.has(url.hostname) && !url.username && !url.password && match) webhookId = match[1];
    } catch { /* reported below */ }
    if (!webhookId) return skip('INVALID_ROW', 'Khoá bí mật của Discord phải là Webhook URL dạng https://discord.com/api/webhooks/<số>/<mã>.');
    if (username.length > 80) return skip('INVALID_ROW', 'Tên webhook khi đăng tối đa 80 ký tự.');
    return {
      kind: 'ready', identity: `discord:${webhookId}`, username: username || '', name: named(`webhook ${webhookId.slice(-4)}`),
      credential: { webhookUrl: secret },
      settings: username ? { webhookUsername: username } : {},
    };
  }

  if (key === 'discourse') {
    const baseUrl = row.url.trim() ? httpsUrl(row.url) : defaultString(platform.defaultSettings, 'baseUrl');
    if (!baseUrl) return skip('INVALID_ROW', 'Cần URL diễn đàn HTTPS, ví dụ https://community.example.com.');
    if (!username) return skip('INVALID_ROW', 'Thiếu API Username (user gắn với API key).');
    const categoryId = row.categoryId.trim();
    if (!/^[1-9]\d{0,9}$/.test(categoryId)) return skip('INVALID_ROW', 'Category ID phải là số, lấy ở cuối URL chuyên mục /c/<slug>/<số>.');
    const tags = row.tags.split(',').map((tag) => tag.trim()).filter(Boolean);
    return {
      kind: 'ready', identity: `discourse:${baseUrl}:${username.toLowerCase()}`, username, name: named(`${username} @ ${new URL(baseUrl).host}`),
      credential: { apiKey: secret },
      settings: { baseUrl, apiUsername: username, categoryId: Number(categoryId), ...(tags.length ? { defaultTags: tags.join(', ') } : {}) },
    };
  }

  const siteUrl = httpsUrl(row.url);
  if (!siteUrl) return skip('INVALID_ROW', 'Cần Site URL HTTPS của WordPress, ví dụ https://blog.example.com (không thêm /wp-json).');
  if (!username) return skip('INVALID_ROW', 'Thiếu Username WordPress.');
  return {
    kind: 'ready', identity: `wordpress:${siteUrl}:${username.toLowerCase()}`, username, name: named(`${username} @ ${new URL(siteUrl).host}`),
    credential: { siteUrl, username, applicationPassword: secret },
    settings: publishNow === undefined ? {} : { publishStatus: publishNow ? 'publish' : 'draft' },
  };
}
