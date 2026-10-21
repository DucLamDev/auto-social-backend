import { HttpStatus } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AccountStatus, PublishJobStatus } from '@prisma/client';
import { ApplicationException, ErrorCode } from '../common/exceptions/application.exception';
import { ConnectorAccountsService } from '../connectors/connector-accounts.service';
import { ConnectorRegistryService } from '../connectors/core/connector-registry.service';
import { CredentialsService } from '../credentials/credentials.service';
import { MetaTokenService } from '../credentials/meta-token.service';
import { PrismaService } from '../database/prisma.service';
import { RedisService } from '../queue/redis.service';
import { AccountHealthService } from './account-health.service';
import { AlertService } from './alert.service';

const NOW = new Date('2026-10-21T00:00:00Z');
const DAY = 24 * 60 * 60 * 1000;

function tokenRow(id: string, overrides: { expiresInDays: number; ageDays: number; status?: AccountStatus; connectorKey?: string }) {
  return {
    platformAccountId: id,
    expiresAt: new Date(NOW.getTime() + overrides.expiresInDays * DAY),
    updatedAt: new Date(NOW.getTime() - overrides.ageDays * DAY),
    account: {
      name: `@${id}`,
      status: overrides.status ?? AccountStatus.CONNECTED,
      platform: { connectorKey: overrides.connectorKey ?? 'threads', name: 'Threads' },
    },
  };
}

function setup(options: { tokens?: unknown[]; refresh?: jest.Mock; accounts?: unknown[]; test?: jest.Mock; jobs?: unknown[] } = {}) {
  const update = jest.fn().mockResolvedValue({});
  const prisma = {
    oAuthToken: { findMany: jest.fn().mockResolvedValue(options.tokens ?? []) },
    platformAccount: {
      update,
      findMany: jest.fn().mockResolvedValue(options.accounts ?? []),
    },
    publishJob: {
      findMany: jest.fn().mockResolvedValue(options.jobs ?? []),
      groupBy: jest.fn().mockResolvedValue([]),
    },
  };
  const credentials = {
    resolveOAuth: jest.fn().mockResolvedValue({ accessToken: 'current', scopes: ['threads_basic'] }),
    upsertOAuthTokens: jest.fn().mockResolvedValue(undefined),
  };
  const meta = { refresh: options.refresh ?? jest.fn().mockResolvedValue({ accessToken: 'renewed', expiresAt: new Date(NOW.getTime() + 60 * DAY) }) };
  const sent: string[][] = [];
  const alerts = { enabled: true, send: jest.fn((lines: string[]) => { sent.push(lines); return Promise.resolve(true); }) };
  const redis = {
    acquireLock: jest.fn().mockResolvedValue('lock'),
    releaseLock: jest.fn().mockResolvedValue(true),
    setOnce: jest.fn().mockResolvedValueOnce(true).mockResolvedValue(false),
  };
  const registry = new ConnectorRegistryService();
  registry.register({ platform: 'threads', testConnection: jest.fn() } as never);
  registry.register({ platform: 'manual' } as never);
  const accounts = { test: options.test ?? jest.fn().mockResolvedValue({ ok: true }) };
  const service = new AccountHealthService(
    prisma as unknown as PrismaService,
    credentials as unknown as CredentialsService,
    meta as unknown as MetaTokenService,
    redis as unknown as RedisService,
    accounts as unknown as ConnectorAccountsService,
    registry,
    alerts as unknown as AlertService,
    new ConfigService({}),
  );
  return { service, prisma, credentials, meta, alerts, sent, update, accounts, redis };
}

describe('AccountHealthService.refreshMetaTokens', () => {
  it('renews tokens that are due and at least a day old, skipping fresh ones', async () => {
    const { service, credentials, meta } = setup({
      tokens: [tokenRow('due', { expiresInDays: 10, ageDays: 50 }), tokenRow('fresh', { expiresInDays: 10, ageDays: 0.5 })],
    });
    await expect(service.refreshMetaTokens(NOW)).resolves.toEqual({ refreshed: 1, failed: 0, skipped: 1 });
    expect(meta.refresh).toHaveBeenCalledWith('threads', 'current');
    expect(credentials.upsertOAuthTokens).toHaveBeenCalledWith(expect.objectContaining({
      platformAccountId: 'due',
      accessToken: 'renewed',
      scopes: ['threads_basic'],
    }));
  });

  it('flags the account and alerts once when Meta rejects the refresh', async () => {
    const refresh = jest.fn().mockRejectedValue(new ApplicationException(ErrorCode.PLATFORM_AUTH_FAILED, 'x', HttpStatus.BAD_GATEWAY));
    const { service, update, sent } = setup({ tokens: [tokenRow('revoked', { expiresInDays: 3, ageDays: 57 })], refresh });
    await service.refreshMetaTokens(NOW);
    expect(update).toHaveBeenCalledWith({ where: { id: 'revoked' }, data: { status: AccountStatus.RECONNECT_REQUIRED } });
    expect(sent[0]?.join('\n')).toContain('Threads @revoked');
  });

  it('leaves the account alone on a transient network failure', async () => {
    const refresh = jest.fn().mockRejectedValue(new TypeError('fetch failed'));
    const { service, update, alerts } = setup({ tokens: [tokenRow('flaky', { expiresInDays: 3, ageDays: 57 })], refresh });
    await expect(service.refreshMetaTokens(NOW)).resolves.toMatchObject({ failed: 1 });
    expect(update).not.toHaveBeenCalled();
    expect(alerts.send).not.toHaveBeenCalled();
  });

  it('marks already-expired tokens for reconnection without calling Meta', async () => {
    const { service, meta, update } = setup({ tokens: [tokenRow('lapsed', { expiresInDays: -1, ageDays: 61 })] });
    await service.refreshMetaTokens(NOW);
    expect(meta.refresh).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledWith({ where: { id: 'lapsed' }, data: { status: AccountStatus.RECONNECT_REQUIRED } });
  });
});

describe('AccountHealthService.checkConnections', () => {
  it('tests API accounts, skips manual ones and reports new failures', async () => {
    const test = jest.fn().mockRejectedValue(Object.assign(new Error('bad'), { code: 'PLATFORM_TOKEN_EXPIRED' }));
    const { service, sent } = setup({
      test,
      accounts: [
        { id: 'a', name: '@a', status: AccountStatus.CONNECTED, platform: { name: 'Threads', connectorKey: 'threads' } },
        { id: 'b', name: 'b', status: AccountStatus.CONNECTED, platform: { name: 'Medium', connectorKey: 'manual' } },
      ],
    });
    await expect(service.checkConnections()).resolves.toEqual({ checked: 1, failed: 1 });
    expect(test).toHaveBeenCalledWith('a');
    expect(sent[0]?.join('\n')).toContain('PLATFORM_TOKEN_EXPIRED');
  });
});

describe('AccountHealthService.alertAttentionJobs', () => {
  it('notifies each problem job only once', async () => {
    const job = { id: 'job-1', status: PublishJobStatus.NEEDS_ACTION, lastErrorCode: 'CAPTCHA_REQUIRED', platformAccount: { name: 'acc', platform: { name: 'Voz' } } };
    const { service, alerts } = setup({ jobs: [job] });
    await expect(service.alertAttentionJobs(NOW)).resolves.toBe(1);
    await expect(service.alertAttentionJobs(NOW)).resolves.toBe(0);
    expect(alerts.send).toHaveBeenCalledTimes(1);
  });
});

describe('AccountHealthService.attention', () => {
  it('hides auto-refreshed tokens until refresh is overdue and totals the work', async () => {
    const { service, prisma } = setup();
    const row = (id: string, connectorKey: string, expiresInDays: number) => ({
      id,
      name: id,
      status: AccountStatus.CONNECTED,
      platform: { slug: connectorKey, name: connectorKey, connectorKey },
      oauthToken: { expiresAt: new Date(NOW.getTime() + expiresInDays * DAY) },
      credential: null,
    });
    prisma.platformAccount.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([row('threads-ok', 'threads', 5), row('threads-late', 'threads', 0.5), row('linkedin', 'linkedin', 5)]);
    prisma.publishJob.groupBy.mockResolvedValueOnce([{ status: PublishJobStatus.NEEDS_ACTION, _count: { _all: 2 } }]);

    const result = await service.attention('user-1', NOW);
    expect(result.accounts.expiringSoon.map((account) => account.id)).toEqual(['threads-late', 'linkedin']);
    expect(result.jobs.needsAction).toBe(2);
    expect(result.total).toBe(4);
  });
});
