import { CredentialStatus } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { CredentialsService } from '../credentials/credentials.service';
import { CredentialEncryptionService } from '../credentials/credential-encryption.service';
import { deviceCanRunAccount, ExtensionAccountSessionService, isRegistrationPage, sessionOf } from './extension-account-session.service';
import { ExtensionSessionDto } from './extension-agent.dto';

const base = { delivery: 'extension', extensionEngine: 'discourse', extensionTargetUrl: 'https://forum.test/new-topic', extensionAutoSubmit: true };
const device = { id: 'chrome-a', ownerId: 'owner-a', name: 'Chrome A' };
const input: ExtensionSessionDto = { deviceId: device.id, expectedUsername: 'alice', provider: 'password', autoLogin: true,
  autoTotp: true, loginUrl: 'https://forum.test/login', loginUsername: 'alice@example.test', password: 'fixture-password',
  totpSecret: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ' }; // public RFC fixture
function setup() {
  const tx = { $queryRaw: jest.fn(), platformAccount: { findFirst: jest.fn().mockResolvedValue({ id: 'account-a', settings: base }),
    findMany: jest.fn().mockResolvedValue([]), update: jest.fn() }, extensionDevice: { findFirst: jest.fn().mockResolvedValue({ id: device.id }) },
    publishJob: { count: jest.fn().mockResolvedValue(0) } };
  const prisma = { $transaction: jest.fn((fn: (value: typeof tx) => Promise<unknown>) => fn(tx)),
    publishJob: { findFirst: jest.fn(), updateMany: jest.fn().mockResolvedValue({ count: 1 }) } };
  const credentials = { upsert: jest.fn(), resolve: jest.fn().mockResolvedValue({ extensionLogin: { username: input.loginUsername, password: input.password, totpSecret: input.totpSecret } }) };
  const encryption = { decrypt: jest.fn() };
  const service = new ExtensionAccountSessionService(prisma as unknown as PrismaService, credentials as unknown as CredentialsService, encryption as unknown as CredentialEncryptionService);
  return { service, prisma, tx, credentials, encryption };
}

describe('Chrome account sessions', () => {
  it('routes two accounts on the same platform to their own profiles and rejects legacy agents', () => {
    const a = { id: 'a', settings: { ...base, extensionSession: { deviceId: 'chrome-a', expectedUsername: 'alice' } } };
    const b = { id: 'b', settings: { ...base, extensionSession: { deviceId: 'chrome-b', expectedUsername: 'bob' } } };
    expect(deviceCanRunAccount(a, 'chrome-a', [a, b], 2, 1)).toBe(true);
    expect(deviceCanRunAccount(b, 'chrome-a', [a, b], 2, 1)).toBe(false);
    expect(deviceCanRunAccount(b, 'chrome-b', [a, b], 2, 1)).toBe(true);
    expect(deviceCanRunAccount(a, 'chrome-a', [a, b], 2)).toBe(false);
    const unbound = { id: 'c', settings: base };
    expect(deviceCanRunAccount(unbound, 'chrome-a', [unbound], 1, 1)).toBe(true);
    expect(deviceCanRunAccount(unbound, 'chrome-a', [unbound], 2, 1)).toBe(false);
    expect(deviceCanRunAccount(unbound, 'chrome-a', [a, unbound], 1, 1)).toBe(false);
  });

  it('stores secrets only through the encrypted vault, not account settings or the configuration response', async () => {
    const { service, tx, credentials } = setup();
    const result = await service.configure(device.ownerId, 'account-a', input);
    const expectedSecret = { username: input.loginUsername, password: input.password, totpSecret: input.totpSecret };
    expect(credentials.upsert).toHaveBeenCalledWith('account-a', { extensionLogin: expectedSecret, extensionLoginMethods: { password: expectedSecret } }, null, tx);
    const publicData = JSON.stringify([result, tx.platformAccount.update.mock.calls]);
    expect(publicData).not.toContain(input.password);
    expect(publicData).not.toContain(input.totpSecret);
    expect(result).toMatchObject({ deviceId: device.id, passwordConfigured: true, totpConfigured: true });
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it('keeps the extra sign-in origins and e-mail matching from the import when the form is saved', async () => {
    const { service, tx } = setup();
    const imported = { deviceId: 'chrome-old', origin: 'https://forum.test', expectedUsername: 'alice', profileUrl: '', identitySelector: '', provider: 'password',
      autoLogin: true, autoTotp: false, loginUrl: 'https://forum.test/login', loginUsername: 'alice@example.test', allowedOrigins: ['https://sso.forum.test'], allowIdentityByEmail: true };
    tx.platformAccount.findFirst.mockResolvedValueOnce({ id: 'account-a', settings: { ...base, extensionSession: imported } });
    type Saved = [{ data: { settings: { extensionSession: Record<string, unknown> } } }];
    const savedSession = (call: number) => (tx.platformAccount.update.mock.calls as unknown as Saved[])[call]![0].data.settings.extensionSession;
    await service.configure(device.ownerId, 'account-a', input);
    expect(savedSession(0)).toMatchObject({ deviceId: device.id, allowedOrigins: ['https://sso.forum.test'], allowIdentityByEmail: true });
    // Another site never inherits them.
    tx.platformAccount.findFirst.mockResolvedValueOnce({ id: 'account-a', settings: { ...base, extensionSession: { ...imported, origin: 'https://other.test' } } });
    await service.configure(device.ownerId, 'account-a', input);
    expect(savedSession(1).allowedOrigins).toBeUndefined();
  });

  it('lets Vivaldi and MongoDB sessions follow the sign-in redirect to their login site', () => {
    const vivaldi = { deviceId: 'chrome-a', expectedUsername: 'vpsttt', origin: 'https://social.vivaldi.net', loginUrl: 'https://social.vivaldi.net/auth/sign_in' };
    expect(sessionOf({ extensionSession: { ...vivaldi, allowedOrigins: [] } })?.allowedOrigins).toEqual(['https://login.vivaldi.net']);
    expect(sessionOf({ extensionSession: vivaldi })?.allowedOrigins).toEqual(['https://login.vivaldi.net']);
    expect(sessionOf({ extensionSession: { ...vivaldi, allowedOrigins: ['https://login.vivaldi.net'] } })?.allowedOrigins).toEqual(['https://login.vivaldi.net']);
    expect(sessionOf({ extensionSession: { ...vivaldi, origin: 'https://mastodon.social' } })?.allowedOrigins).toBeUndefined();
    expect(sessionOf({ extensionSession: { ...vivaldi, origin: 'https://www.mongodb.com' } })?.allowedOrigins).toEqual(['https://account.mongodb.com']);
  });

  it('rejects a foreign device, a second identity in the same cookie scope, and reassignment during a claimed job', async () => {
    const { service, tx } = setup();
    tx.extensionDevice.findFirst.mockResolvedValueOnce(null);
    await expect(service.configure(device.ownerId, 'account-a', input)).rejects.toThrow('active paired Chrome');
    tx.platformAccount.findMany.mockResolvedValueOnce([{ name: 'Forum · bob', settings: { ...base, extensionSession: { deviceId: device.id, expectedUsername: 'bob' } } }]);
    await expect(service.configure(device.ownerId, 'account-a', input)).rejects.toThrow('đang giữ tài khoản Forum · bob của cùng nền tảng');
    tx.publishJob.count.mockResolvedValueOnce(1);
    await expect(service.configure(device.ownerId, 'account-a', input)).rejects.toThrow('claimed task');
  });

  it('still saves an account that already shares its profile with another account of the site (older import), naming the other one', async () => {
    const { service, tx } = setup();
    const imported = { deviceId: device.id, origin: 'https://forum.test', expectedUsername: 'alice', provider: 'password', autoLogin: true, autoTotp: true,
      loginUrl: 'https://forum.test/login', loginUsername: 'alice@example.test' };
    tx.platformAccount.findFirst.mockResolvedValueOnce({ id: 'account-a', settings: { ...base, extensionSession: imported } });
    tx.platformAccount.findMany.mockResolvedValueOnce([
      { name: 'Forum · bob', settings: { ...base, extensionSession: { deviceId: device.id, expectedUsername: 'bob' } } },
      // Another site on the same profile is not a conflict.
      { name: 'Other · carol', settings: { ...base, extensionTargetUrl: 'https://other.test/new-topic', extensionSession: { deviceId: device.id, expectedUsername: 'carol' } } },
    ]);
    const result = await service.configure(device.ownerId, 'account-a', { ...input, profileUrl: 'https://forum.test/u/alice' });
    expect(result).toMatchObject({ deviceId: device.id, profileUrl: 'https://forum.test/u/alice', sharedWith: ['Forum · bob'] });
    expect(tx.platformAccount.update).toHaveBeenCalledTimes(1);
    // Without a second account of the site the response has no warning.
    tx.platformAccount.findFirst.mockResolvedValueOnce({ id: 'account-a', settings: { ...base, extensionSession: imported } });
    expect(await service.configure(device.ownerId, 'account-a', input)).not.toHaveProperty('sharedWith');
  });

  it('does not reuse password or TOTP when changing the Google identity', async () => {
    const { service, tx, encryption } = setup();
    tx.platformAccount.findFirst.mockResolvedValue({ id: 'account-a', settings: { ...base, extensionSession: { ...input, loginUsername: 'old@example.test' } },
      credential: { status: CredentialStatus.ACTIVE, encryptedPayload: 'encrypted' } });
    encryption.decrypt.mockReturnValue({ extensionLogin: { password: input.password, totpSecret: input.totpSecret } });
    await expect(service.configure(device.ownerId, 'account-a', { ...input, password: '', totpSecret: '' })).rejects.toThrow('password are required');
  });

  it('refuses a new Google identity on a profile whose platforms already use another one', async () => {
    const { service, tx } = setup();
    tx.platformAccount.findMany.mockResolvedValue([{ settings: { ...base, extensionTargetUrl: 'https://other.test/new-topic', extensionSession: { ...input, provider: 'google', loginUsername: 'bob@example.test' } } }]);
    await expect(service.configure(device.ownerId, 'account-a', { ...input, provider: 'google' })).rejects.toThrow('đang dùng Google bob@example.test');
  });

  it('lets an account switch to a Google identity this profile already uses, even when the profile carries several', async () => {
    const { service, tx } = setup();
    const google = (site: string, email: string) => ({ settings: { ...base, extensionTargetUrl: `https://${site}/new-topic`, extensionSession: { ...input, provider: 'google', loginUsername: email } } });
    tx.platformAccount.findMany.mockResolvedValue([google('one.test', 'bob@example.test'), google('two.test', 'Alice@Example.test'), google('three.test', 'carol@example.test')]);
    await expect(service.configure(device.ownerId, 'account-a', { ...input, provider: 'google' })).resolves.toBeDefined();
    await expect(service.configure(device.ownerId, 'account-a', { ...input, provider: 'google', loginUsername: 'dave@example.test' }))
      .rejects.toThrow('đang dùng Google alice@example.test, bob@example.test, carol@example.test');
  });

  it('requires the exact claimed device and auth origin, returns only a current OTP, and prevents a repeated attempt', async () => {
    jest.useFakeTimers().setSystemTime(60_000);
    try {
      const { service, prisma, credentials } = setup();
      const auth = { ...input, origin: 'https://forum.test' };
      prisma.publishJob.findFirst.mockResolvedValue({ platformAccountId: 'account-a', platformAccount: { settings: { ...base, extensionSession: auth } } });
      await expect(service.authStep(device, 'job-a', { step: 'password', pageUrl: 'https://evil.test/login' })).rejects.toThrow('origin');
      expect(credentials.resolve).not.toHaveBeenCalled();
      const otp = await service.authStep(device, 'job-a', { step: 'totp', pageUrl: 'https://forum.test/login' });
      expect(otp).toEqual({ code: '359152', expiresAt: 90_000 });
      const query = (prisma.publishJob.findFirst.mock.calls.at(-1) as [{ where: unknown }])[0];
      expect(query.where).toMatchObject({ extensionClaimDeviceId: 'chrome-a', lastErrorCode: null, target: { campaign: { ownerId: 'owner-a' } } });
      prisma.publishJob.updateMany.mockResolvedValueOnce({ count: 0 });
      await expect(service.authStep(device, 'job-a', { step: 'totp', pageUrl: 'https://forum.test/login' })).rejects.toThrow('already attempted');
      prisma.publishJob.findFirst.mockResolvedValueOnce(null);
      await expect(service.authStep({ ...device, id: 'chrome-b' }, 'job-a', { step: 'password', pageUrl: 'https://forum.test/login' })).rejects.toThrow('claimed by this Chrome');
      expect(sessionOf({})).toBeUndefined();
    } finally { jest.useRealTimers(); }
  });

  it('never releases a Google password to the social destination', async () => {
    const { service, prisma } = setup();
    prisma.publishJob.findFirst.mockResolvedValue({ platformAccountId: 'account-a', platformAccount: { settings: { ...base, extensionSession: { ...input, provider: 'google', origin: 'https://forum.test' } } } });
    await expect(service.authStep(device, 'job-a', { step: 'password', pageUrl: 'https://forum.test/login' })).rejects.toThrow('origin');
    await expect(service.authStep(device, 'job-a', { step: 'password', pageUrl: 'https://accounts.google.com/v3/signin/challenge/pwd' })).resolves.toEqual({ username: input.loginUsername, password: input.password });
  });

  it('never hands a login secret to a sign-up page on the right origin', async () => {
    const { service, prisma, credentials } = setup();
    prisma.publishJob.findFirst.mockResolvedValue({ platformAccountId: 'account-a', platformAccount: { settings: { ...base, extensionSession: { ...input, origin: 'https://forum.test' } } } });
    for (const pageUrl of ['https://forum.test/signup', 'https://forum.test/users/sign_up', 'https://forum.test/u/Register?next=/', 'https://forum.test/join',
      'https://forum.test/account/create-account', 'https://forum.test/registration.php', 'https://forum.test/ucp.php?mode=register']) {
      for (const step of ['identifier', 'password', 'totp'] as const) {
        await expect(service.authStep(device, 'job-a', { step, pageUrl })).rejects.toThrow('sign-up form');
      }
    }
    expect(credentials.resolve).not.toHaveBeenCalled();
    expect(prisma.publishJob.updateMany).not.toHaveBeenCalled();
    await expect(service.authStep(device, 'job-a', { step: 'password', pageUrl: 'https://forum.test/login?return=/signup' })).resolves.toMatchObject({ password: input.password });
  });

  it('tells sign-up pages from login pages', () => {
    for (const url of ['https://meta.discourse.org/signup', 'https://mastodon.social/auth/sign_up', 'https://x.test/sign-up/', 'https://x.test/new-account', 'https://accounts.google.com/lifecycle/steps/signup/name']) {
      expect(isRegistrationPage(new URL(url))).toBe(true);
    }
    for (const url of ['https://meta.discourse.org/login', 'https://x.test/session/sso_login', 'https://accounts.google.com/v3/signin/identifier', 'https://x.test/joint-venture', 'https://x.test/ucp.php?mode=login', 'https://x.test/c/join-us']) {
      expect(isRegistrationPage(new URL(url))).toBe(false);
    }
  });
});
