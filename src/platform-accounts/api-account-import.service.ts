import { Injectable } from '@nestjs/common';
import { AccountStatus, CredentialStatus, Prisma, PublishJobStatus } from '@prisma/client';
import { ApplicationException } from '../common/exceptions/application.exception';
import { ConnectorError } from '../connectors/core/connector-error';
import { ConnectorRegistryService } from '../connectors/core/connector-registry.service';
import { isExtensionDelivery } from '../connectors/extension/extension-delivery';
import { CredentialEncryptionService } from '../credentials/credential-encryption.service';
import { CredentialsService } from '../credentials/credentials.service';
import { PrismaService } from '../database/prisma.service';
import { sessionOf } from '../extension-agent/extension-account-session.service';
import {
  ApiImportRow,
  ApiImportStatus,
  ImportPlatform,
  mapApiImportRow,
  MappedApiAccount,
  resolveImportPlatform,
} from './api-account-import';

const TEST_TIMEOUT_MS = 20_000;
const TEST_CONCURRENCY = 3;
const BUSY_JOB_STATUSES = [PublishJobStatus.SCHEDULED, PublishJobStatus.QUEUED, PublishJobStatus.PUBLISHING, PublishJobStatus.PROCESSING];

export interface ApiImportResultRow {
  row: number;
  platform: string;
  /** Catalog slug when the platform was recognised; the web uses it for the Connect button. */
  slug?: string;
  name: string;
  status: ApiImportStatus;
  message: string;
  accountId?: string;
}

interface PlannedRow {
  index: number;
  row: ApiImportRow;
  platform: ImportPlatform;
  mapped: MappedApiAccount;
}

interface SavedRow extends PlannedRow {
  accountId: string;
  credential: Record<string, unknown>;
  settings: Record<string, unknown>;
  /** The account posted through the Chrome extension; it switches to the API only after a passing test. */
  viaExtension: boolean;
}

const FAILURE_PREFIX: Record<string, string> = {
  PLATFORM_AUTH_FAILED: 'Khoá bị từ chối hoặc cấu hình sai',
  PLATFORM_TOKEN_EXPIRED: 'Khoá đã hết hạn',
  PLATFORM_PERMISSION_DENIED: 'Khoá thiếu quyền cần thiết',
  PLATFORM_RATE_LIMITED: 'Nền tảng đang giới hạn tốc độ, thử lại sau',
  CRAWLER_URL_BLOCKED: 'Địa chỉ không được phép gọi (mạng nội bộ hoặc không phân giải được)',
};

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function rowNumber(source: string): number {
  return Number(/(\d+)$/.exec(source)?.[1] ?? 0);
}

function normalizeHandle(value: unknown): string {
  return typeof value === 'string' ? value.trim().replace(/^@/, '').toLowerCase() : '';
}

function withoutDelivery(settings: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(settings).filter(([key]) => key !== 'delivery'));
}

function withTimeout<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('IMPORT_TEST_TIMEOUT')), milliseconds);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Operator-facing reason; the row secret is removed in case a provider echoed it. */
export function importFailureMessage(error: unknown, secret: string): string {
  if (error instanceof Error && error.message === 'IMPORT_TEST_TIMEOUT') return 'Nền tảng không trả lời trong 20 giây; thử nhập lại sau.';
  const code = error instanceof ConnectorError || error instanceof ApplicationException ? String(error.code) : '';
  const detail = error instanceof Error ? error.message : '';
  const safe = (secret.length >= 4 ? detail.split(secret).join('***') : detail).slice(0, 300);
  return `${FAILURE_PREFIX[code] ?? 'Kiểm tra kết nối thất bại'}${safe ? `: ${safe}` : ''}.`;
}

/**
 * Imports API credentials from a file: validates each row, stores encrypted
 * credentials on a new or matching account, then runs the connector's own
 * connection test so every row ends as connected or with a clear reason.
 */
@Injectable()
export class ApiAccountImportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly credentials: CredentialsService,
    private readonly encryption: CredentialEncryptionService,
    private readonly registry: ConnectorRegistryService,
  ) {}

  async import(ownerId: string, rows: ApiImportRow[]) {
    const platforms: ImportPlatform[] = (await this.prisma.platform.findMany({
      select: { id: true, slug: true, name: true, enabled: true, connectorKey: true, defaultSettings: true },
    })).map((platform) => ({ ...platform, defaultSettings: asRecord(platform.defaultSettings) }));
    const results: ApiImportResultRow[] = [];
    const planned: PlannedRow[] = [];
    const firstRow = new Map<string, number>();
    for (const row of rows) {
      const base = { row: rowNumber(row.source), name: row.name.trim() };
      const platform = resolveImportPlatform(row.platform, platforms);
      if (!platform) {
        results.push({ ...base, platform: row.platform.trim(), status: 'INVALID_ROW', message: row.platform.trim() ? `Không nhận ra nền tảng "${row.platform.trim()}".` : 'Thiếu tên nền tảng.' });
        continue;
      }
      const mapped = mapApiImportRow(row, platform);
      if (mapped.kind === 'skip') {
        results.push({ ...base, name: base.name || platform.name, platform: platform.name, slug: platform.slug, status: mapped.status, message: mapped.message });
        continue;
      }
      const identity = `${platform.id}|${mapped.identity}`;
      const duplicateOf = firstRow.get(identity);
      if (duplicateOf !== undefined) {
        results.push({ ...base, name: mapped.name, platform: platform.name, slug: platform.slug, status: 'DUPLICATE_ROW', message: `Trùng tài khoản ở dòng ${duplicateOf}; dòng này bị bỏ qua.` });
        continue;
      }
      firstRow.set(identity, base.row);
      results.push({ ...base, name: mapped.name, platform: platform.name, slug: platform.slug, status: 'CHECK_FAILED', message: 'Chưa kiểm tra.' });
      planned.push({ index: results.length - 1, row, platform, mapped });
    }
    // Adding an account switches its platform on (the Platforms page with its switches is gone).
    const switchOn = [...new Set(planned.filter((item) => item.platform.enabled === false).map((item) => item.platform.id))];
    if (switchOn.length) await this.prisma.platform.updateMany({ where: { id: { in: switchOn } }, data: { enabled: true } });
    const saved = planned.length ? await this.save(ownerId, planned, results) : [];
    for (let offset = 0; offset < saved.length; offset += TEST_CONCURRENCY) {
      await Promise.all(saved.slice(offset, offset + TEST_CONCURRENCY).map((item) => this.test(item, results)));
    }
    const connected = results.filter((row) => row.status === 'CONNECTED').length;
    return { total: results.length, connected, needsAttention: results.length - connected, rows: results };
  }

  private async save(ownerId: string, planned: PlannedRow[], results: ApiImportResultRow[]): Promise<SavedRow[]> {
    const saved: SavedRow[] = [];
    await this.prisma.$transaction(async (tx) => {
      // Serialises concurrent imports of the same owner (the extension import uses 7301).
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${ownerId}, 7302))::text`;
      const owned = await tx.platformAccount.findMany({
        where: { ownerId, platformId: { in: [...new Set(planned.map((item) => item.platform.id))] } },
        include: { credential: true },
      });
      for (const item of planned) {
        const result = results[item.index]!;
        const samePlatform = owned.filter((account) => account.platformId === item.platform.id);
        const byIdentity = samePlatform.find((account) => asRecord(asRecord(account.settings).apiImport).key === item.mapped.identity);
        const byUsername = item.mapped.matchUsername && !byIdentity
          ? samePlatform.filter((account) => normalizeHandle(account.username) === item.mapped.matchUsername
            || normalizeHandle(sessionOf(account.settings)?.expectedUsername) === item.mapped.matchUsername)
          : [];
        if (byUsername.length > 1) {
          Object.assign(result, { status: 'INVALID_ROW', message: `Có ${byUsername.length} tài khoản cùng username trên ${item.platform.name}; cập nhật khoá trong form của đúng tài khoản để tránh nhầm.` });
          continue;
        }
        const existing = byIdentity ?? byUsername[0];
        const previous = asRecord(existing?.settings);
        const viaExtension = isExtensionDelivery(previous);
        if (existing && await this.busy(tx, existing.id, viaExtension)) {
          Object.assign(result, { status: 'ACCOUNT_BUSY', accountId: existing.id, message: 'Tài khoản đang có bài chờ đăng hoặc đang được kiểm tra; nhập lại sau khi xong.' });
          continue;
        }
        const stored = existing?.credential?.status === CredentialStatus.ACTIVE ? this.encryption.decrypt(existing.credential.encryptedPayload) : {};
        const credential = { ...stored, ...item.mapped.credential };
        const settings = {
          ...(existing ? previous : item.platform.defaultSettings),
          ...item.mapped.settings,
          apiImport: { key: item.mapped.identity, row: rowNumber(item.row.source), importedAt: new Date().toISOString() },
        };
        let accountId: string;
        if (existing) {
          await tx.platformAccount.update({
            where: { id: existing.id },
            data: {
              settings,
              ...(existing.username ? {} : { username: item.mapped.username || null }),
              // An extension account keeps posting through Chrome until the API test passes.
              ...(viaExtension ? {} : { status: AccountStatus.RECONNECT_REQUIRED, lastTestedAt: null }),
            },
          });
          accountId = existing.id;
        } else {
          accountId = (await tx.platformAccount.create({
            data: {
              ownerId,
              platformId: item.platform.id,
              name: item.mapped.name,
              username: item.mapped.username || null,
              settings,
              enabled: true,
              status: AccountStatus.RECONNECT_REQUIRED,
            },
            select: { id: true },
          })).id;
        }
        await this.credentials.upsert(accountId, credential, null, tx);
        result.accountId = accountId;
        if (existing) result.name = existing.name;
        saved.push({ ...item, accountId, credential, settings, viaExtension });
      }
    }, { timeout: 30_000 });
    return saved;
  }

  /** Jobs the worker or the Chrome extension may still pick up for this account. */
  private async busy(tx: Prisma.TransactionClient, accountId: string, viaExtension: boolean): Promise<boolean> {
    const jobs = await tx.publishJob.count({
      where: {
        platformAccountId: accountId,
        OR: [
          { status: { in: BUSY_JOB_STATUSES } },
          // Extension tasks wait in NEEDS_ACTION: queued (no error) or claimed (locked).
          ...(viaExtension ? [{ status: PublishJobStatus.NEEDS_ACTION, OR: [{ lastErrorCode: null }, { lockedAt: { not: null } }] }] : []),
        ],
      },
    });
    if (jobs) return true;
    return (await tx.extensionLoginCheck.count({ where: { platformAccountId: accountId, status: { in: ['QUEUED', 'RUNNING'] } } })) > 0;
  }

  private async test(item: SavedRow, results: ApiImportResultRow[]): Promise<void> {
    const result = results[item.index]!;
    try {
      const connector = this.registry.get(item.platform.connectorKey);
      if (!connector.testConnection) throw new Error('Connector has no connection test');
      const outcome = await withTimeout(connector.testConnection({
        id: item.accountId,
        ...(item.mapped.username ? { username: item.mapped.username } : {}),
        settings: withoutDelivery(item.settings),
        credentials: item.credential,
      }), TEST_TIMEOUT_MS);
      await this.prisma.$transaction(async (tx) => {
        const current = await tx.platformAccount.findUniqueOrThrow({ where: { id: item.accountId }, select: { settings: true } });
        await tx.platformAccount.update({
          where: { id: item.accountId },
          data: {
            status: AccountStatus.CONNECTED,
            lastTestedAt: new Date(),
            ...(item.viaExtension ? { settings: withoutDelivery(asRecord(current.settings)) as Prisma.InputJsonObject } : {}),
          },
        });
      });
      Object.assign(result, {
        status: 'CONNECTED',
        message: `Đã kết nối${outcome.accountName ? ` (${outcome.accountName})` : ''}${item.viaExtension ? '; từ nay đăng bằng API thay cho tiện ích Chrome' : ''}.`,
      });
    } catch (error) {
      if (!item.viaExtension) {
        await this.prisma.platformAccount.update({ where: { id: item.accountId }, data: { status: AccountStatus.ERROR, lastTestedAt: new Date() } });
      }
      Object.assign(result, {
        status: 'CHECK_FAILED',
        message: `${importFailureMessage(error, item.row.secret.trim())}${item.viaExtension ? ' Tài khoản vẫn đăng qua tiện ích Chrome.' : ''}`,
      });
    }
  }
}
