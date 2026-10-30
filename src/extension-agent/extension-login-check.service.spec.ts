import { ExtensionLoginCheckService } from './extension-login-check.service';

describe('login completion and automatic connection', () => {
  it('never supplies credentials for a session-only check', async () => {
    const resolve = jest.fn();
    const prisma = { extensionLoginCheck: { findFirst: jest.fn().mockResolvedValue({
      verifyOnly: true, account: { settings: { extensionSession: { deviceId: 'device', expectedUsername: 'brand', autoLogin: true, autoTotp: true, origin: 'https://example.test' } } },
    }) } };
    const service = new ExtensionLoginCheckService(prisma as never, { resolve } as never);
    await expect(service.authStep({ id: 'device', ownerId: 'owner' } as never, 'check', { step: 'password', pageUrl: 'https://example.test/login' })).rejects.toThrow('Session verification cannot request login credentials');
    expect(resolve).not.toHaveBeenCalled();
  });

  it('claims session-only checks without Google permission or automatic login', async () => {
    const settings = { extensionLoginTarget: { url: 'https://example.test', engine: 'generic' }, extensionSession: {
      deviceId: 'device', expectedUsername: 'brand', origin: 'https://example.test', provider: 'google', autoLogin: true, autoTotp: true,
    } };
    const check = { id: 'check', verifyOnly: true, account: { id: 'account', name: 'Brand', settings, platform: { name: 'Social' } } };
    const tx = { $queryRaw: jest.fn(), extensionLoginCheck: {
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      findMany: jest.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([check]),
    } };
    const prisma = { $transaction: jest.fn(fn => fn(tx)) };
    const service = new ExtensionLoginCheckService(prisma as never, {} as never);
    const task = await service.claim({ id: 'device', ownerId: 'owner' } as never, ['https://example.test']);
    expect(task?.auth).toMatchObject({ autoLogin: false, autoTotp: false, expectedUsername: 'brand' });
    expect(settings.extensionSession.autoLogin).toBe(true);
  });

  function fixture(settings: Record<string, unknown>, enabled = false, verifyOnly = false) {
    const auth = { deviceId: 'device', expectedUsername: 'brand', loginUsername: 'owner@example.test', provider: 'google', allowIdentityByEmail: true, profileUrl: 'https://example.test/u/brand' };
    const check = { id: 'check', platformAccountId: 'account', verifyOnly, account: { enabled, settings: { ...settings, extensionSession: auth } } };
    const tx = { extensionLoginCheck: { update: jest.fn() }, platformAccount: { update: jest.fn() } };
    const prisma = { extensionLoginCheck: { findFirst: jest.fn().mockResolvedValue(check) }, $transaction: jest.fn(async fn => fn(tx)) };
    const service = new ExtensionLoginCheckService(prisma as never, {} as never);
    return { service, tx };
  }
  it('enables a configured imported route only after successful authentication', async () => {
    const { service, tx } = fixture({ delivery: 'extension', extensionAutoConnect: true, extensionAutoSubmit: true, extensionSetup: { status: 'READY' } });
    await service.result({ id: 'device', ownerId: 'owner' } as never, 'check', { outcome: 'AUTHENTICATED', detectedUsername: 'real-handle' });
    expect(tx.platformAccount.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ enabled: true, status: 'CONNECTED' }) }));
    expect(tx.platformAccount.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ settings: expect.objectContaining({ extensionSession: expect.objectContaining({ expectedUsername: 'real-handle', profileUrl: '' }) }) }) }));
  });
  it('does not turn a known posting restriction into a connected account after login', async () => {
    const { service, tx } = fixture({ delivery: 'extension', extensionSetup: { status: 'ACCESS_RESTRICTED' } }, true);
    await service.result({ id: 'device', ownerId: 'owner' } as never, 'check', { outcome: 'AUTHENTICATED' });
    expect(tx.platformAccount.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ enabled: false, status: 'ERROR' }) }));
  });
  it('explains an unverified existing session without claiming credentials are missing', async () => {
    const { service, tx } = fixture({}, false, true);
    await service.result({ id: 'device', ownerId: 'owner' } as never, 'check', { outcome: 'NEEDS_ACTION', message: 'Chưa nhận diện được phiên sẵn có và tài khoản này chưa bật tự đăng nhập hoặc còn thiếu thông tin xác thực.' });
    expect(tx.extensionLoginCheck.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ message: expect.stringContaining('phiên đăng nhập sẵn có') }) }));
  });
  it.each([
    { delivery: 'extension', extensionAutoConnect: false },
    { extensionAutoConnect: true, extensionSetup: { status: 'FLOW_REQUIRED' } },
    { delivery: 'extension', extensionAutoConnect: true, extensionSetup: { status: 'DESTINATION_REQUIRED' } },
  ])('does not enable a disabled, incomplete or API account using login alone', async settings => {
    const { service, tx } = fixture(settings);
    await service.result({ id: 'device', ownerId: 'owner' } as never, 'check', { outcome: 'AUTHENTICATED' });
    expect(tx.platformAccount.update).not.toHaveBeenCalled();
  });
});
