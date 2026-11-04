import { ExtensionLoginCheckService, loginSession } from './extension-login-check.service';

describe('separate login methods', () => {
  const settings = { extensionSession: { deviceId: 'device', expectedUsername: 'brand', origin: 'https://social.test', provider: 'google', loginUsername: 'google@example.test', autoLogin: true },
    extensionLoginMethods: { password: { available: true, username: 'social-user' }, google: { available: true, username: 'google@example.test' } } };
  it('uses the social identity for password attempts without changing the Google config', () => {
    expect(loginSession(settings, 'password')).toMatchObject({ provider: 'password', loginUsername: 'social-user', autoLogin: true });
    expect(settings.extensionSession.loginUsername).toBe('google@example.test');
  });
  it('does not release Google credentials to a password attempt with no method secret', async () => {
    const prisma = { extensionLoginCheck: { findFirst: jest.fn().mockResolvedValue({ id: 'check', platformAccountId: 'account', method: 'password', account: { settings } }) } };
    const service = new ExtensionLoginCheckService(prisma as never, { resolve: jest.fn().mockResolvedValue({ extensionLogin: { username: 'google@example.test', password: 'not-a-social-password' } }) } as never);
    await expect(service.authStep({ id: 'device' } as never, 'check', { step: 'password', pageUrl: 'https://social.test/login' })).rejects.toThrow('no matching credential');
  });
  it('queues Google only after a failed password attempt and keeps the first result', async () => {
    const check = { id: 'check', deviceId: 'device', platformAccountId: 'account', batchId: 'batch', method: 'password', tryFallback: true, account: { settings } };
    const tx = { extensionLoginCheck: { updateMany: jest.fn().mockResolvedValue({ count: 1 }), create: jest.fn() } };
    const prisma = { extensionLoginCheck: { findFirst: jest.fn().mockResolvedValue(check) }, $transaction: jest.fn(fn => fn(tx)) };
    const service = new ExtensionLoginCheckService(prisma as never, {} as never);
    await service.result({ id: 'device' } as never, 'check', { outcome: 'NEEDS_ACTION', message: 'Password not accepted' });
    expect(tx.extensionLoginCheck.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'NEEDS_ACTION', message: 'Password not accepted' }) }));
    expect(tx.extensionLoginCheck.create).toHaveBeenCalledWith({ data: expect.objectContaining({ method: 'google', batchId: 'batch', platformAccountId: 'account', tryFallback: false }) });
  });
});

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
      findMany: jest.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([]).mockResolvedValueOnce([check]),
    } };
    const prisma = { $transaction: jest.fn(fn => fn(tx)) };
    const service = new ExtensionLoginCheckService(prisma as never, {} as never);
    const task = await service.claim({ id: 'device', ownerId: 'owner' } as never, ['https://example.test']);
    expect(task?.auth).toMatchObject({ autoLogin: false, autoTotp: false, expectedUsername: 'brand' });
    expect(settings.extensionSession.autoLogin).toBe(true);
  });

  function fixture(settings: Record<string, unknown>, enabled = false, verifyOnly = false, slug = 'disqus') {
    const auth = { deviceId: 'device', expectedUsername: 'brand', loginUsername: 'owner@example.test', provider: 'google', allowIdentityByEmail: true, profileUrl: 'https://example.test/u/brand' };
    const check = { id: 'check', platformAccountId: 'account', verifyOnly, account: { enabled, settings: { ...settings, extensionSession: auth }, platform: { slug } } };
    const tx = { extensionLoginCheck: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) }, platformAccount: { update: jest.fn() } };
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
    expect(tx.extensionLoginCheck.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ message: expect.stringContaining('phiên đăng nhập sẵn có') }) }));
  });
  type Update = [{ data: { enabled?: boolean; status?: string; settings?: Record<string, unknown> } }];
  const updates = (tx: ReturnType<typeof fixture>['tx']) => (tx.platformAccount.update.mock.calls as Update[]).map(([call]) => call.data);

  it.each([
    ['daily-dev', 'https://daily.dev/squads/create'],
    ['cloudpanel-forum', 'https://www.cloudpanelforum.org/forums/install-config/post-thread'],
    ['directadmin-forums', 'https://forum.directadmin.com/forums/general-technical-discussion-troubleshooting.32/post-thread'],
    ['tinhte', 'https://tinhte.vn/editorv2/create/795/'],
  ])('connects a signed-in imported %s account that never got a posting route, using the flow default page', async (slug, page) => {
    // daily.dev still carries the reason saved before its flow existed.
    const { service, tx } = fixture({ extensionAutoConnect: true, extensionSetup: { status: 'FLOW_REQUIRED' } }, false, true, slug);
    await service.result({ id: 'device', ownerId: 'owner' } as never, 'check', { outcome: 'AUTHENTICATED' });
    const connected = updates(tx).find((data) => data.enabled === true);
    expect(connected).toMatchObject({ status: 'CONNECTED', settings: { delivery: 'extension', extensionTargetUrl: page, extensionAutoSubmit: true, extensionSetup: { status: 'READY' } } });
  });

  it('records why a signed-in account still cannot post, without switching it on', async () => {
    const { service, tx } = fixture({ extensionAutoConnect: true, extensionSetup: { status: 'DESTINATION_REQUIRED' } }, false, false, 'disqus');
    await service.result({ id: 'device', ownerId: 'owner' } as never, 'check', { outcome: 'AUTHENTICATED' });
    expect(updates(tx)).toEqual([expect.objectContaining({ settings: expect.objectContaining({ extensionSetup: { status: 'FLOW_REQUIRED' } }) as unknown }) as unknown]);
    expect(updates(tx).some((data) => data.enabled)).toBe(false);
  });

  it('gives no route after a failed login, nor to an account not meant to connect by itself', async () => {
    const failed = fixture({ extensionAutoConnect: true }, false, false, 'daily-dev');
    await failed.service.result({ id: 'device', ownerId: 'owner' } as never, 'check', { outcome: 'NEEDS_ACTION' });
    expect(failed.tx.platformAccount.update).not.toHaveBeenCalled();
    const manual = fixture({}, false, false, 'daily-dev');
    await manual.service.result({ id: 'device', ownerId: 'owner' } as never, 'check', { outcome: 'AUTHENTICATED' });
    expect(manual.tx.platformAccount.update).not.toHaveBeenCalled();
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

describe('bulk login checks', () => {
  const session = (deviceId = 'device') => ({ extensionSession: { deviceId, expectedUsername: 'brand', origin: 'https://social.test', provider: 'password', loginUsername: 'brand', autoLogin: true },
    extensionLoginMethods: { password: { available: true, username: 'brand' } } });
  function setup(latest: Array<{ platformAccountId: string; status: string }>) {
    const accounts = ['signed-in', 'needs-action', 'never-checked', 'running'].map((id) => ({ id, settings: session() }));
    const tx = {
      $queryRaw: jest.fn(),
      platformAccount: { findMany: jest.fn().mockResolvedValue(accounts) },
      extensionDevice: { findMany: jest.fn().mockResolvedValue([{ id: 'device' }]) },
      extensionLoginCheck: {
        findMany: jest.fn((args: { where: { status?: unknown } }) => Promise.resolve(args.where.status ? [{ platformAccountId: 'running' }] : latest)),
        create: jest.fn().mockResolvedValue({}),
      },
    };
    const service = new ExtensionLoginCheckService({ $transaction: jest.fn((fn: (client: typeof tx) => unknown) => fn(tx)) } as never, {} as never);
    return { service, tx };
  }
  const queuedIds = (tx: ReturnType<typeof setup>['tx']) => (tx.extensionLoginCheck.create.mock.calls as Array<[{ data: { platformAccountId: string } }]>).map(([call]) => call.data.platformAccountId);

  it('leaves out accounts whose latest check signed in, and checks every other status', async () => {
    const { service, tx } = setup([{ platformAccountId: 'signed-in', status: 'AUTHENTICATED' }, { platformAccountId: 'needs-action', status: 'NEEDS_ACTION' }]);
    await expect(service.queue('owner', undefined, false, true, true)).resolves.toMatchObject({ queued: 2, skipped: 1 });
    expect(queuedIds(tx)).toEqual(['needs-action', 'never-checked']);
    // Only the latest check of each account decides.
    expect(tx.extensionLoginCheck.findMany).toHaveBeenCalledWith(expect.objectContaining({ orderBy: { createdAt: 'desc' }, distinct: ['platformAccountId'] }));
  });

  it('checks an account again when its latest check failed after an earlier success', async () => {
    // The query returns the latest check per account: here NEEDS_ACTION, newer than an old success.
    const { service, tx } = setup([{ platformAccountId: 'signed-in', status: 'NEEDS_ACTION' }]);
    await service.queue('owner', undefined, false, true, true);
    expect(queuedIds(tx)).toContain('signed-in');
  });

  it('still checks signed-in accounts when the caller asks for them (one account, import)', async () => {
    const { service, tx } = setup([{ platformAccountId: 'signed-in', status: 'AUTHENTICATED' }]);
    await expect(service.queue('owner', undefined, false, true)).resolves.toMatchObject({ queued: 3, skipped: 0 });
    expect(queuedIds(tx)).toContain('signed-in');
  });
});
