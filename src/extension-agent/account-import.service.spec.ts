import { AccountImportService, importLogin, parseAccountUpload, AccountImportRow } from './account-import.service';

const row: AccountImportRow = { source: 'upload:2', platform: 'mastodon', label: 'Mastodon', provider: 'password', loginUsername: 'alice@example.test', password: '', totpSecret: '', profileUrl: '', expectedUsername: '' };
describe('account file onboarding', () => {
  it('uses passwords from complete rows and Google for email-only rows', () => {
    expect(importLogin({ ...row, password: 'fixture-secret' }, 'company@example.test')).toEqual({ provider: 'password', username: 'alice@example.test' });
    expect(importLogin(row, 'company@example.test')).toEqual({ provider: 'google', username: 'company@example.test' });
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

  describe('shared Google account from the import dialog', () => {
    const GOOGLE_PASSWORD = 'google-dialog-password';
    const GOOGLE_TOTP = 'JBSWY3DPEHPK3PXP';
    const platforms = [
      { id: 'p-medium', slug: 'medium', name: 'Medium' },
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
      return { service, prisma, tx, credentials };
    }
    const googleRow: AccountImportRow = { ...row, platform: 'medium', label: 'Medium', loginUsername: 'writer@example.test', provider: 'google', password: 'row-social-password', totpSecret: '' }; // vpsttt-secretscan: ignore (mật khẩu giả cho test)
    const passwordRow: AccountImportRow = { ...row, platform: 'mastodon', label: 'Mastodon', loginUsername: 'alice', provider: 'password', password: 'mastodon-password', expectedUsername: 'alice' }; // vpsttt-secretscan: ignore (mật khẩu giả cho test)

    it('gives Google rows the dialog password and TOTP key, enabling automatic login and code entry', async () => {
      const { service, tx, credentials } = setup();

      const result = await service.import('owner', 'device-1', [googleRow, passwordRow], 'company@example.test', { password: GOOGLE_PASSWORD, totpSecret: ` ${GOOGLE_TOTP} ` });

      const calls = credentials.upsert.mock.calls as Array<[string, Record<string, Record<string, unknown>>, null, unknown]>;
      const googleCall = calls[0]!, passwordCall = calls[1]!;
      expect(googleCall[1].extensionLogin).toEqual({ username: 'company@example.test', password: GOOGLE_PASSWORD, totpSecret: GOOGLE_TOTP });
      // The file's social password never becomes the Google password.
      expect(JSON.stringify(googleCall[1])).not.toContain('row-social-password');
      expect(passwordCall[1].extensionLogin).toEqual({ username: 'alice', password: 'mastodon-password' }); // vpsttt-secretscan: ignore (mật khẩu giả cho test)
      expect(passwordCall[1].extensionLoginMethods?.google).toEqual({ username: 'company@example.test', password: GOOGLE_PASSWORD, totpSecret: GOOGLE_TOTP });
      const settingsOf = (index: number) => (tx.platformAccount.update.mock.calls[index] as [{ data: { settings: Record<string, Record<string, unknown>> } }])[0].data.settings;
      expect(settingsOf(0).extensionSession).toMatchObject({ provider: 'google', loginUsername: 'company@example.test', autoLogin: true, autoTotp: true });
      expect(settingsOf(1).extensionLoginMethods?.google).toMatchObject({ available: true, username: 'company@example.test', autoTotp: true });
      expect(JSON.stringify(result)).not.toContain(GOOGLE_PASSWORD);
      expect(JSON.stringify(result)).not.toContain(GOOGLE_TOTP);
    });

    it('keeps the previous behaviour when no shared Google secrets are given', async () => {
      const { service, credentials } = setup();
      await service.import('owner', 'device-1', [googleRow], 'company@example.test');
      const payload = (credentials.upsert.mock.calls as Array<[string, Record<string, Record<string, unknown>>]>)[0]![1];
      expect(payload.extensionLogin).toEqual({ username: 'company@example.test' });
    });

    it.each([
      ['a six-digit code instead of the setup key', { email: 'company@example.test', secrets: { totpSecret: '123456' } }, 'không nhập mã 6 số'],
      ['an invalid setup key', { email: 'company@example.test', secrets: { totpSecret: 'not base32!' } }, 'Khoá TOTP Google không hợp lệ'],
      ['Google secrets without the shared Google email', { email: undefined, secrets: { password: GOOGLE_PASSWORD } }, 'email Google dùng chung'],
    ])('rejects %s before changing any account', async (_label, input, message) => {
      const { service, prisma } = setup();
      await expect(service.import('owner', 'device-1', [googleRow], input.email, input.secrets)).rejects.toThrow(message);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });
  });
});

