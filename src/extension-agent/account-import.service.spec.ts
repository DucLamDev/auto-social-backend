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
});
