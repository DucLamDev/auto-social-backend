import { AccountStatus, CredentialStatus } from '@prisma/client';
import { ErrorCode } from '../common/exceptions/application.exception';
import { ConnectorError } from '../connectors/core/connector-error';
import { ConnectorRegistryService } from '../connectors/core/connector-registry.service';
import { CredentialEncryptionService } from '../credentials/credential-encryption.service';
import { CredentialsService } from '../credentials/credentials.service';
import { PrismaService } from '../database/prisma.service';
import { ApiImportRow } from './api-account-import';
import { ApiAccountImportService, importFailureMessage } from './api-account-import.service';

const platforms = [
  { id: 'p-devto', slug: 'devto', name: 'dev.to', connectorKey: 'devto', defaultSettings: { publishImmediately: false } },
  { id: 'p-bluesky', slug: 'bluesky', name: 'Bluesky', connectorKey: 'bluesky', defaultSettings: {} },
  { id: 'p-instagram', slug: 'instagram', name: 'Instagram', connectorKey: 'instagram', defaultSettings: {} },
];

function row(values: Partial<ApiImportRow>): ApiImportRow {
  return { source: 'upload:2', platform: '', name: '', url: '', username: '', secret: '', categoryId: '', tags: '', publishNow: '', visibility: '', ...values };
}

const DEV_KEY = 'dev-secret-key-123';
const APP_PASSWORD = 'abcd-efgh-ijkl-mnop';

function setup(options: { owned?: unknown[]; busyJobs?: number; test?: jest.Mock; currentSettings?: Record<string, unknown> } = {}) {
  const testConnection = options.test ?? jest.fn().mockResolvedValue({ ok: true, accountName: 'Alice' });
  const tx = {
    $queryRaw: jest.fn().mockResolvedValue([]),
    platformAccount: {
      findMany: jest.fn().mockResolvedValue(options.owned ?? []),
      create: jest.fn().mockResolvedValue({ id: 'new-account' }),
      update: jest.fn().mockResolvedValue({}),
      findUniqueOrThrow: jest.fn().mockResolvedValue({ settings: options.currentSettings ?? {} }),
    },
    publishJob: { count: jest.fn().mockResolvedValue(options.busyJobs ?? 0) },
    extensionLoginCheck: { count: jest.fn().mockResolvedValue(0) },
  };
  const prisma = {
    platform: { findMany: jest.fn().mockResolvedValue(platforms) },
    platformAccount: tx.platformAccount,
    $transaction: jest.fn((callback: (client: typeof tx) => Promise<unknown>) => callback(tx)),
  };
  const credentials = { upsert: jest.fn().mockResolvedValue(undefined) };
  const encryption = { decrypt: jest.fn().mockReturnValue({ extensionLogin: { username: 'alice@example.com', password: 'chrome-login' }, apiKey: 'old-key' }) }; // vpsttt-secretscan: ignore (mật khẩu giả cho test)
  const registry = { get: jest.fn().mockReturnValue({ testConnection }) };
  const service = new ApiAccountImportService(
    prisma as unknown as PrismaService,
    credentials as unknown as CredentialsService,
    encryption as unknown as CredentialEncryptionService,
    registry as unknown as ConnectorRegistryService,
  );
  return { service, tx, credentials, registry, testConnection };
}

describe('ApiAccountImportService', () => {
  it('creates an API account, stores the encrypted key and marks it connected after the connector test', async () => {
    const { service, tx, credentials, testConnection } = setup();

    const result = await service.import('owner-1', [row({ platform: 'dev.to', username: 'alice', secret: DEV_KEY, publishNow: 'có' })]);

    expect(tx.$queryRaw).toHaveBeenCalled();
    expect(tx.platformAccount.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        ownerId: 'owner-1', platformId: 'p-devto', name: 'dev.to · alice', username: 'alice', enabled: true, status: AccountStatus.RECONNECT_REQUIRED,
        settings: expect.objectContaining({ baseUrl: 'https://dev.to/api', publishImmediately: true, apiImport: expect.objectContaining({ key: 'devto:alice', row: 2 }) as unknown }) as unknown,
      }) as unknown,
      select: { id: true },
    });
    expect(credentials.upsert).toHaveBeenCalledWith('new-account', { apiKey: DEV_KEY }, null, tx);
    expect(testConnection).toHaveBeenCalledWith(expect.objectContaining({ id: 'new-account', credentials: { apiKey: DEV_KEY } }));
    expect(tx.platformAccount.update).toHaveBeenCalledWith({
      where: { id: 'new-account' },
      data: expect.objectContaining({ status: AccountStatus.CONNECTED }) as unknown,
    });
    expect(result).toEqual({
      total: 1, connected: 1, needsAttention: 0,
      rows: [{ row: 2, platform: 'dev.to', name: 'dev.to · alice', status: 'CONNECTED', accountId: 'new-account', message: 'Đã kết nối (Alice).' }],
    });
    expect(JSON.stringify(result)).not.toContain(DEV_KEY);
  });

  it('reports a failed test with a redacted reason and leaves the account in error', async () => {
    const test = jest.fn().mockRejectedValue(new ConnectorError(ErrorCode.PLATFORM_AUTH_FAILED, `Invalid key ${DEV_KEY}`, false));
    const { service, tx } = setup({ test });

    const result = await service.import('owner-1', [row({ platform: 'devto', username: 'alice', secret: DEV_KEY })]);

    expect(result.rows[0]).toMatchObject({ status: 'CHECK_FAILED', message: 'Khoá bị từ chối hoặc cấu hình sai: Invalid key ***.' });
    expect(tx.platformAccount.update).toHaveBeenCalledWith({ where: { id: 'new-account' }, data: expect.objectContaining({ status: AccountStatus.ERROR }) as unknown });
    expect(JSON.stringify(result)).not.toContain(DEV_KEY);
  });

  it('updates the account imported before instead of creating a duplicate, keeping other stored secrets', async () => {
    const owned = [{ id: 'acc-1', platformId: 'p-devto', name: 'Dev chính', username: 'alice', settings: { apiImport: { key: 'devto:alice' }, rateLimit: 5 },
      credential: { status: CredentialStatus.ACTIVE, encryptedPayload: 'enc' } }];
    const { service, tx, credentials } = setup({ owned });

    const result = await service.import('owner-1', [row({ platform: 'devto', username: 'Alice', secret: DEV_KEY })]);

    expect(tx.platformAccount.create).not.toHaveBeenCalled();
    expect(tx.platformAccount.update).toHaveBeenNthCalledWith(1, {
      where: { id: 'acc-1' },
      data: expect.objectContaining({ status: AccountStatus.RECONNECT_REQUIRED, settings: expect.objectContaining({ rateLimit: 5, baseUrl: 'https://dev.to/api' }) as unknown }) as unknown,
    });
    expect(credentials.upsert).toHaveBeenCalledWith('acc-1', expect.objectContaining({ apiKey: DEV_KEY, extensionLogin: expect.any(Object) as unknown }), null, tx);
    expect(result.rows[0]).toMatchObject({ name: 'Dev chính', accountId: 'acc-1', status: 'CONNECTED' });
  });

  it('attaches the key to the matching Chrome-extension account and switches it to the API only after the test passes', async () => {
    const extensionSettings = { delivery: 'extension', extensionEngine: 'bluesky', extensionSession: { deviceId: 'd1', expectedUsername: '@bob.bsky.social' } };
    const owned = [{ id: 'ext-1', platformId: 'p-bluesky', name: 'Bluesky · bob', username: null, settings: extensionSettings,
      credential: { status: CredentialStatus.ACTIVE, encryptedPayload: 'enc' } }];
    const { service, tx, testConnection } = setup({ owned, currentSettings: { ...extensionSettings, apiImport: { key: 'bluesky:bob.bsky.social' } } });

    const result = await service.import('owner-1', [row({ platform: 'Bluesky', username: 'bob.bsky.social', secret: APP_PASSWORD })]);

    const saveCall = (tx.platformAccount.update.mock.calls[0] as [{ data: Record<string, unknown> }])[0];
    expect(saveCall.data.status).toBeUndefined();
    expect(saveCall.data.settings).toMatchObject({ delivery: 'extension' });
    expect(testConnection).toHaveBeenCalledWith(expect.objectContaining({
      settings: expect.not.objectContaining({ delivery: 'extension' }) as unknown,
      credentials: expect.objectContaining({ identifier: 'bob.bsky.social', appPassword: APP_PASSWORD, extensionLogin: expect.any(Object) as unknown }) as unknown,
    }));
    const switchCall = (tx.platformAccount.update.mock.calls[1] as [{ data: { settings: Record<string, unknown>; status: string } }])[0];
    expect(switchCall.data.status).toBe(AccountStatus.CONNECTED);
    expect(switchCall.data.settings).not.toHaveProperty('delivery');
    expect(switchCall.data.settings).toHaveProperty('extensionSession');
    expect(result.rows[0]?.message).toContain('từ nay đăng bằng API thay cho tiện ích Chrome');
  });

  it('keeps an extension account on Chrome when the API test fails', async () => {
    const owned = [{ id: 'ext-1', platformId: 'p-bluesky', name: 'Bluesky · bob', username: 'bob.bsky.social', settings: { delivery: 'extension' }, credential: null }];
    const { service, tx } = setup({ owned, test: jest.fn().mockRejectedValue(new Error('network down')) });

    const result = await service.import('owner-1', [row({ platform: 'Bluesky', username: 'bob.bsky.social', secret: APP_PASSWORD })]);

    expect(tx.platformAccount.update).toHaveBeenCalledTimes(1);
    expect(result.rows[0]).toMatchObject({ status: 'CHECK_FAILED', message: 'Kiểm tra kết nối thất bại: network down. Tài khoản vẫn đăng qua tiện ích Chrome.' });
  });

  it('skips accounts with pending jobs, and reports OAuth, unknown and duplicate rows without writing', async () => {
    const owned = [{ id: 'acc-1', platformId: 'p-devto', name: 'Dev', username: 'alice', settings: {}, credential: null }];
    const { service, tx, credentials } = setup({ owned, busyJobs: 1 });

    const result = await service.import('owner-1', [
      row({ source: 'upload:2', platform: 'devto', username: 'alice', secret: DEV_KEY }),
      row({ source: 'upload:3', platform: 'devto', username: 'ALICE', secret: 'other' }),
      row({ source: 'upload:4', platform: 'Instagram', secret: 'token' }),
      row({ source: 'upload:5', platform: 'Facebook', secret: 'token' }),
    ]);

    expect(result.rows.map((item) => [item.row, item.status])).toEqual([[2, 'ACCOUNT_BUSY'], [3, 'DUPLICATE_ROW'], [4, 'OAUTH_REQUIRED'], [5, 'INVALID_ROW']]);
    expect(result).toMatchObject({ total: 4, connected: 0, needsAttention: 4 });
    expect(credentials.upsert).not.toHaveBeenCalled();
    expect(tx.platformAccount.update).not.toHaveBeenCalled();
  });

  it('refuses to guess between several accounts with the same username', async () => {
    const owned = [
      { id: 'a', platformId: 'p-devto', name: 'A', username: 'alice', settings: {}, credential: null },
      { id: 'b', platformId: 'p-devto', name: 'B', username: '@Alice', settings: {}, credential: null },
    ];
    const { service, credentials } = setup({ owned });
    const result = await service.import('owner-1', [row({ platform: 'devto', username: 'alice', secret: DEV_KEY })]);
    expect(result.rows[0]).toMatchObject({ status: 'INVALID_ROW' });
    expect(credentials.upsert).not.toHaveBeenCalled();
  });

  it('explains a test timeout', () => {
    expect(importFailureMessage(new Error('IMPORT_TEST_TIMEOUT'), DEV_KEY)).toBe('Nền tảng không trả lời trong 20 giây; thử nhập lại sau.');
  });
});
