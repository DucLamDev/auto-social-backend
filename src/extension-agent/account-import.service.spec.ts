import { AccountImportService, importLogin, parseAccountUpload, AccountImportRow } from './account-import.service';

const row: AccountImportRow = { source: 'upload:2', platform: 'mastodon', label: 'Mastodon', provider: 'password', loginUsername: 'alice@example.test', password: '', totpSecret: '', profileUrl: '', expectedUsername: '' };
describe('account file onboarding', () => {
  it('uses passwords from complete rows and Google for email-only rows', () => {
    expect(importLogin({ ...row, password: 'fixture-secret' })).toEqual({ provider: 'password', username: 'alice@example.test' }); // vpsttt-secretscan: ignore (mật khẩu giả cho test)
    expect(importLogin(row)).toEqual({ provider: 'google', username: 'alice@example.test' });
  });
  it('parses quoted passwords and optional destinations without evaluating file contents', async () => {
    const rows = await parseAccountUpload(Buffer.from('Social Network,Email,Pass,URL Profile,URL đăng bài\nMastodon.social,alice@example.test,"a,b""c",https://mastodon.social/@alice,https://mastodon.social/publish\n'), 'csv');
    expect(rows[0]).toMatchObject({ platform: 'mastodon', loginUsername: 'alice@example.test', password: 'a,b"c', expectedUsername: 'alice', targetUrl: 'https://mastodon.social/publish' });
  });
  it('rejects malformed uploads without including cells in its error', async () => {
    await expect(parseAccountUpload(Buffer.from('private-password,do-not-log\nsecret,secret'), 'csv')).rejects.toThrow('Không đọc được file');
  });
  it('refuses a Chrome device owned by someone else before changing accounts', async () => {
    const prisma = { extensionDevice: { findFirst: jest.fn().mockResolvedValue(null) }, $transaction: jest.fn() };
    const service = new AccountImportService(prisma as never, {} as never, {} as never, {} as never);
    await expect(service.import('owner', 'another-device', [row])).rejects.toThrow('Chrome');
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.extensionDevice.findFirst).toHaveBeenCalledWith({ where: { id: 'another-device', ownerId: 'owner', revokedAt: null } });
  });

  describe('Google rows use their own Google account', () => {
    const TOTP_A = 'JBSWY3DPEHPK3PXP';
    const TOTP_B = 'GEZDGNBVGY3TQOJQ';
    const platforms = [
      { id: 'p-medium', slug: 'medium', name: 'Medium' },
      { id: 'p-substack', slug: 'substack', name: 'Substack' },
      { id: 'p-mastodon', slug: 'mastodon', name: 'Mastodon.social' },
    ];
    function setup() {
      const created: Array<{ data: Record<string, unknown> }> = [];
      const tx = {
        $queryRaw: jest.fn().mockResolvedValue([]),
        platformAccount: {
          findMany: jest.fn().mockResolvedValue([]),
          create: jest.fn((args: { data: Record<string, unknown> }) => { created.push(args); return Promise.resolve({ id: `acc-${created.length}` }); }),
          update: jest.fn().mockResolvedValue({}),
        },
        extensionLoginCheck: { count: jest.fn().mockResolvedValue(0) },
        publishJob: { count: jest.fn().mockResolvedValue(0) },
      };
      const prisma = {
        extensionDevice: { findFirst: jest.fn().mockResolvedValue({ id: 'device-1' }) },
        platform: { findMany: jest.fn().mockResolvedValue(platforms) },
        $transaction: jest.fn((callback: (client: typeof tx) => Promise<unknown>) => callback(tx)),
      };
      const credentials = { upsert: jest.fn().mockResolvedValue(undefined) };
      const checks = { queue: jest.fn().mockResolvedValue({ queued: 2, batchId: 'batch-1' }) };
      const service = new AccountImportService(prisma as never, credentials as never, { decrypt: jest.fn() } as never, checks as never);
      return { service, tx, credentials };
    }
    const mediumA: AccountImportRow = { ...row, platform: 'medium', label: 'Medium', loginUsername: 'writer-a@example.test', provider: 'google', password: 'google-a-password', totpSecret: TOTP_A }; // vpsttt-secretscan: ignore (mật khẩu giả cho test)
    const substackB: AccountImportRow = { ...row, platform: 'substack', label: 'Substack', loginUsername: 'writer-b@example.test', provider: 'google', password: 'google-b-password', totpSecret: TOTP_B }; // vpsttt-secretscan: ignore (mật khẩu giả cho test)
    const passwordRow: AccountImportRow = { ...row, platform: 'mastodon', label: 'Mastodon', loginUsername: 'alice', provider: 'password', password: 'mastodon-password', expectedUsername: 'alice' }; // vpsttt-secretscan: ignore (mật khẩu giả cho test)

    it('keeps each row on its own Google email, password and 2FA key', async () => {
      const { service, tx, credentials } = setup();
      const result = await service.import('owner', 'device-1', [mediumA, substackB, passwordRow]);
      const payloads = (credentials.upsert.mock.calls as Array<[string, Record<string, Record<string, unknown>>]>).map((call) => call[1]);
      expect(payloads[0]?.extensionLogin).toEqual({ username: 'writer-a@example.test', password: 'google-a-password', totpSecret: TOTP_A }); // vpsttt-secretscan: ignore (mật khẩu giả cho test)
      expect(payloads[1]?.extensionLogin).toEqual({ username: 'writer-b@example.test', password: 'google-b-password', totpSecret: TOTP_B }); // vpsttt-secretscan: ignore (mật khẩu giả cho test)
      // A password row never receives a Google login borrowed from another row.
      expect(payloads[2]?.extensionLoginMethods).toEqual({ password: { username: 'alice', password: 'mastodon-password' } }); // vpsttt-secretscan: ignore (mật khẩu giả cho test)
      const settingsOf = (index: number) => (tx.platformAccount.update.mock.calls[index] as [{ data: { settings: Record<string, Record<string, unknown>> } }])[0].data.settings;
      expect(settingsOf(0).extensionSession).toMatchObject({ provider: 'google', loginUsername: 'writer-a@example.test', autoLogin: true, autoTotp: true });
      expect(settingsOf(1).extensionSession).toMatchObject({ provider: 'google', loginUsername: 'writer-b@example.test', autoTotp: true });
      expect(Object.keys(settingsOf(2).extensionLoginMethods ?? {})).toEqual(['password']);
      expect(JSON.stringify(result)).not.toMatch(/google-a-password|google-b-password|JBSWY3DP|GEZDGNBV/);
    });

    it('reports an invalid 2FA key on its row and still imports the others', async () => {
      const { service, credentials } = setup();
      const result = await service.import('owner', 'device-1', [{ ...mediumA, totpSecret: '123456' }, substackB]);
      expect(result.rows).toEqual(expect.arrayContaining([expect.objectContaining({ row: 'upload:2', issue: 'INVALID_TOTP' })]));
      expect(credentials.upsert).toHaveBeenCalledTimes(1);
    });
  });
});

