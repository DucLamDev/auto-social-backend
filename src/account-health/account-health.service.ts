import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { AccountStatus, Prisma, PublishJobStatus } from '@prisma/client';
import { ApplicationException } from '../common/exceptions/application.exception';
import { ConnectorAccountsService } from '../connectors/connector-accounts.service';
import { ConnectorRegistryService } from '../connectors/core/connector-registry.service';
import { CredentialsService } from '../credentials/credentials.service';
import { isMetaProvider, META_MIN_TOKEN_AGE_MS, MetaTokenService } from '../credentials/meta-token.service';
import { PrismaService } from '../database/prisma.service';
import { RedisService } from '../queue/redis.service';
import { AlertService } from './alert.service';

const DAY_MS = 24 * 60 * 60 * 1000;
/** Meta tokens live 60 days; refreshing 15 days ahead leaves two weeks of hourly retries. */
export const META_REFRESH_BEFORE_EXPIRY_MS = 15 * DAY_MS;
/** Tokens without automatic refresh are reported this far ahead of expiry. */
export const EXPIRY_WARNING_MS = 7 * DAY_MS;
/** Connectors whose stored token is renewed by the system without the user signing in again. */
const AUTO_REFRESH_CONNECTORS = new Set(['instagram', 'threads', 'blogger']);
const ATTENTION_JOB_STATUSES = [
  PublishJobStatus.NEEDS_ACTION,
  PublishJobStatus.FAILED,
  PublishJobStatus.POSSIBLE_DUPLICATE,
];
const PROBLEM_ACCOUNT_STATUSES = [AccountStatus.RECONNECT_REQUIRED, AccountStatus.EXPIRED, AccountStatus.ERROR];

export interface MaintenanceResult {
  refreshed: number;
  failed: number;
  skipped: number;
}

export interface ConnectionCheckResult {
  checked: number;
  failed: number;
}

@Injectable()
export class AccountHealthService {
  private readonly logger = new Logger(AccountHealthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly credentials: CredentialsService,
    private readonly meta: MetaTokenService,
    private readonly redis: RedisService,
    private readonly accounts: ConnectorAccountsService,
    private readonly registry: ConnectorRegistryService,
    private readonly alerts: AlertService,
    private readonly config: ConfigService,
  ) {}

  @Cron(CronExpression.EVERY_HOUR, { name: 'refresh-meta-tokens', waitForCompletion: true })
  async refreshMetaTokensJob(): Promise<void> {
    await this.withLock('maintenance:refresh-meta-tokens', 10 * 60_000, () => this.refreshMetaTokens());
  }

  @Cron('0 15 3 * * *', { name: 'check-account-connections', waitForCompletion: true })
  async checkConnectionsJob(): Promise<void> {
    await this.withLock('maintenance:check-account-connections', 60 * 60_000, () => this.checkConnections());
  }

  @Cron('0 0 8 * * *', { name: 'warn-expiring-credentials', waitForCompletion: true })
  async warnExpiringJob(): Promise<void> {
    await this.withLock('maintenance:warn-expiring-credentials', 10 * 60_000, () => this.warnExpiring());
  }

  @Cron(CronExpression.EVERY_5_MINUTES, { name: 'alert-attention-jobs', waitForCompletion: true })
  async alertJobsJob(): Promise<void> {
    if (!this.alerts.enabled) return;
    await this.withLock('maintenance:alert-attention-jobs', 4 * 60_000, () => this.alertAttentionJobs());
  }

  /**
   * Renews Instagram/Threads tokens before they lapse. A token Meta rejects is
   * unusable, so the account is flagged for reconnection at once; network
   * failures are left for the next hourly run.
   */
  async refreshMetaTokens(now = new Date()): Promise<MaintenanceResult> {
    const tokens = await this.prisma.oAuthToken.findMany({
      where: {
        expiresAt: { not: null, lte: new Date(now.getTime() + META_REFRESH_BEFORE_EXPIRY_MS) },
        account: { enabled: true, platform: { connectorKey: { in: ['instagram', 'threads'] } } },
      },
      select: {
        platformAccountId: true,
        expiresAt: true,
        updatedAt: true,
        account: { select: { name: true, status: true, platform: { select: { connectorKey: true, name: true } } } },
      },
    });
    const result: MaintenanceResult = { refreshed: 0, failed: 0, skipped: 0 };
    const alerts: string[] = [];
    for (const token of tokens) {
      const provider = token.account.platform.connectorKey;
      if (!isMetaProvider(provider)) continue;
      const label = `${token.account.platform.name} ${token.account.name}`;
      if (token.expiresAt && token.expiresAt.getTime() <= now.getTime()) {
        if (await this.flagReconnect(token.platformAccountId, token.account.status)) {
          alerts.push(`- ${label}: token đã hết hạn, cần bấm "Kết nối" lại.`);
        }
        result.failed += 1;
        continue;
      }
      if (now.getTime() - token.updatedAt.getTime() < META_MIN_TOKEN_AGE_MS) {
        result.skipped += 1;
        continue;
      }
      try {
        const current = await this.credentials.resolveOAuth(token.platformAccountId);
        const renewed = await this.meta.refresh(provider, current.accessToken);
        await this.credentials.upsertOAuthTokens({
          platformAccountId: token.platformAccountId,
          accessToken: renewed.accessToken,
          scopes: current.scopes,
          tokenType: renewed.tokenType ?? 'bearer',
          expiresAt: renewed.expiresAt,
        });
        result.refreshed += 1;
      } catch (error) {
        result.failed += 1;
        if (error instanceof ApplicationException) {
          if (await this.flagReconnect(token.platformAccountId, token.account.status)) {
            alerts.push(`- ${label}: Meta từ chối gia hạn token (${error.code}), cần bấm "Kết nối" lại.`);
          }
        } else {
          this.logger.warn(`Meta token refresh for account ${token.platformAccountId} failed transiently; retrying next hour`);
        }
      }
    }
    if (alerts.length) await this.alerts.send(['Tài khoản cần kết nối lại:', ...alerts]);
    if (tokens.length) this.logger.log(`Meta token maintenance: ${JSON.stringify(result)}`);
    return result;
  }

  /**
   * Calls each connector's read-only connection test (for Meta: GET /me) so a
   * revoked token or removed permission is found before the next scheduled
   * post rather than when it fails.
   */
  async checkConnections(ownerId?: string): Promise<ConnectionCheckResult> {
    const browserEnabled = this.config.get<boolean>('BROWSER_AUTOMATION_ENABLED') === true;
    const accounts = await this.prisma.platformAccount.findMany({
      where: {
        enabled: true,
        ...(ownerId ? { ownerId } : {}),
        platform: { enabled: true },
        status: { in: [AccountStatus.CONNECTED, AccountStatus.ERROR] },
        OR: [{ credential: { isNot: null } }, { oauthToken: { isNot: null } }],
      },
      select: { id: true, name: true, status: true, platform: { select: { name: true, connectorKey: true } } },
      orderBy: { createdAt: 'asc' },
    });
    const result: ConnectionCheckResult = { checked: 0, failed: 0 };
    const failures: string[] = [];
    for (const account of accounts) {
      const key = account.platform.connectorKey;
      if (key === 'manual' || (key === 'browser-assisted' && !browserEnabled)) continue;
      if (!this.registry.has(key) || !this.registry.get(key).testConnection) continue;
      result.checked += 1;
      try {
        await this.accounts.test(account.id);
      } catch (error) {
        result.failed += 1;
        const code = error instanceof Error && 'code' in error ? String((error as { code: unknown }).code) : 'UNKNOWN';
        if (account.status === AccountStatus.CONNECTED) {
          failures.push(`- ${account.platform.name} ${account.name}: kiểm tra kết nối thất bại (${code}).`);
        }
      }
    }
    if (failures.length) await this.alerts.send(['Kiểm tra kết nối hằng ngày phát hiện lỗi:', ...failures]);
    this.logger.log(`Connection check: ${JSON.stringify(result)}`);
    return result;
  }

  /** Daily reminder for tokens the system cannot renew on its own (for example LinkedIn). */
  async warnExpiring(now = new Date()): Promise<number> {
    const soon = new Date(now.getTime() + EXPIRY_WARNING_MS);
    const rows = await this.prisma.platformAccount.findMany({
      where: {
        enabled: true,
        status: AccountStatus.CONNECTED,
        platform: { connectorKey: { notIn: [...AUTO_REFRESH_CONNECTORS] } },
        OR: [
          { oauthToken: { expiresAt: { gt: now, lte: soon } } },
          { credential: { expiresAt: { gt: now, lte: soon } } },
        ],
      },
      select: {
        name: true,
        platform: { select: { name: true } },
        oauthToken: { select: { expiresAt: true } },
        credential: { select: { expiresAt: true } },
      },
    });
    if (rows.length) {
      await this.alerts.send([
        'Token sắp hết hạn, hệ thống không tự gia hạn được:',
        ...rows.map((row) => {
          const expiresAt = row.oauthToken?.expiresAt ?? row.credential?.expiresAt;
          return `- ${row.platform.name} ${row.name}: hết hạn ${expiresAt?.toISOString().slice(0, 10) ?? '?'}`;
        }),
      ]);
    }
    return rows.length;
  }

  /** Notifies each job once per problem status; Redis remembers what was already sent. */
  async alertAttentionJobs(now = new Date()): Promise<number> {
    const jobs = await this.prisma.publishJob.findMany({
      where: { status: { in: ATTENTION_JOB_STATUSES }, updatedAt: { gte: new Date(now.getTime() - 60 * 60_000) } },
      select: {
        id: true,
        status: true,
        lastErrorCode: true,
        platformAccount: { select: { name: true, platform: { select: { name: true } } } },
      },
      orderBy: { updatedAt: 'asc' },
      take: 50,
    });
    const lines: string[] = [];
    for (const job of jobs) {
      if (!(await this.redis.setOnce(`alert:job:${job.id}:${job.status}`, '1', 7 * 24 * 60 * 60))) continue;
      lines.push(`- ${job.platformAccount.platform.name} ${job.platformAccount.name}: ${job.status}${job.lastErrorCode ? ` (${job.lastErrorCode})` : ''} · job ${job.id}`);
    }
    if (lines.length) await this.alerts.send(['Bài đăng cần xử lý:', ...lines]);
    return lines.length;
  }

  /** What the operator has to look at; feeds the dashboard and the top bar badge. */
  async attention(ownerId: string, now = new Date()) {
    const soon = new Date(now.getTime() + EXPIRY_WARNING_MS);
    const accountSelect = {
      id: true,
      name: true,
      status: true,
      platform: { select: { slug: true, name: true, connectorKey: true } },
      oauthToken: { select: { expiresAt: true } },
      credential: { select: { expiresAt: true } },
    } satisfies Prisma.PlatformAccountSelect;
    const [problemAccounts, expiringAccounts, jobCounts] = await Promise.all([
      this.prisma.platformAccount.findMany({
        where: { ownerId, enabled: true, status: { in: PROBLEM_ACCOUNT_STATUSES } },
        select: accountSelect,
        orderBy: { updatedAt: 'desc' },
        take: 100,
      }),
      this.prisma.platformAccount.findMany({
        where: {
          ownerId,
          enabled: true,
          status: AccountStatus.CONNECTED,
          OR: [
            { oauthToken: { expiresAt: { lte: soon } } },
            { credential: { expiresAt: { lte: soon } } },
          ],
        },
        select: accountSelect,
        take: 100,
      }),
      this.prisma.publishJob.groupBy({
        by: ['status'],
        where: { target: { campaign: { ownerId } }, status: { in: [...ATTENTION_JOB_STATUSES, PublishJobStatus.RETRY] } },
        _count: { _all: true },
      }),
    ]);
    const count = (status: PublishJobStatus) => jobCounts.find((row) => row.status === status)?._count._all ?? 0;
    const toAccount = (row: (typeof problemAccounts)[number]) => ({
      id: row.id,
      name: row.name,
      status: row.status,
      platform: row.platform.slug,
      platformName: row.platform.name,
      expiresAt: (row.oauthToken?.expiresAt ?? row.credential?.expiresAt)?.toISOString() ?? null,
      autoRefresh: AUTO_REFRESH_CONNECTORS.has(row.platform.connectorKey) && Boolean(row.oauthToken),
    });
    const accounts = {
      problems: problemAccounts.map(toAccount),
      // Auto-refreshed tokens only need attention once refresh has stopped working.
      expiringSoon: expiringAccounts
        .map(toAccount)
        .filter((account) => !account.autoRefresh || (account.expiresAt !== null && new Date(account.expiresAt).getTime() <= now.getTime() + DAY_MS)),
    };
    const jobs = {
      needsAction: count(PublishJobStatus.NEEDS_ACTION),
      failed: count(PublishJobStatus.FAILED),
      possibleDuplicate: count(PublishJobStatus.POSSIBLE_DUPLICATE),
      retrying: count(PublishJobStatus.RETRY),
    };
    return {
      total: accounts.problems.length + accounts.expiringSoon.length + jobs.needsAction + jobs.failed + jobs.possibleDuplicate,
      accounts,
      jobs,
      alertsEnabled: this.alerts.enabled,
      generatedAt: now.toISOString(),
    };
  }

  private async flagReconnect(accountId: string, status: AccountStatus): Promise<boolean> {
    if (status === AccountStatus.RECONNECT_REQUIRED) return false;
    await this.prisma.platformAccount.update({ where: { id: accountId }, data: { status: AccountStatus.RECONNECT_REQUIRED } });
    return true;
  }

  /** API replicas all run the same crons; only the lock holder does the work. */
  private async withLock(key: string, ttlMs: number, task: () => Promise<unknown>): Promise<void> {
    let token: string | null = null;
    try {
      token = await this.redis.acquireLock(key, ttlMs);
      if (!token) return;
      await task();
    } catch (error) {
      this.logger.error(`${key} failed: ${error instanceof Error ? error.message : 'unknown error'}`);
    } finally {
      if (token) await this.redis.releaseLock(key, token).catch(() => undefined);
    }
  }
}
