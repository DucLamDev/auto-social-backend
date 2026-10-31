import { CredentialStatus } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { CredentialsService } from '../credentials/credentials.service';
import { CredentialEncryptionService } from '../credentials/credential-encryption.service';
import { deviceCanRunAccount, ExtensionAccountSessionService, sessionOf } from './extension-account-session.service';
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

  it('rejects a foreign device, a second identity in the same cookie scope, and reassignment during a claimed job', async () => {
    const { service, tx } = setup();
    tx.extensionDevice.findFirst.mockResolvedValueOnce(null);
    await expect(service.configure(device.ownerId, 'account-a', input)).rejects.toThrow('active paired Chrome');
    tx.platformAccount.findMany.mockResolvedValueOnce([{ settings: { ...base, extensionSession: { deviceId: device.id, expectedUsername: 'bob' } } }]);
    await expect(service.configure(device.ownerId, 'account-a', input)).rejects.toThrow('already belongs');
    tx.publishJob.count.mockResolvedValueOnce(1);
    await expect(service.configure(device.ownerId, 'account-a', input)).rejects.toThrow('claimed task');
  });

  it('does not reuse password or TOTP when changing the Google identity', async () => {
    const { service, tx, encryption } = setup();
    tx.platformAccount.findFirst.mockResolvedValue({ id: 'account-a', settings: { ...base, extensionSession: { ...input, loginUsername: 'old@example.test' } },
      credential: { status: CredentialStatus.ACTIVE, encryptedPayload: 'encrypted' } });
    encryption.decrypt.mockReturnValue({ extensionLogin: { password: input.password, totpSecret: input.totpSecret } });
    await expect(service.configure(device.ownerId, 'account-a', { ...input, password: '', totpSecret: '' })).rejects.toThrow('password are required');
  });

  it('requires Google SSO accounts in one profile to use the same Google identity', async () => {
    const { service, tx } = setup();
    tx.platformAccount.findMany.mockResolvedValue([{ settings: { ...base, extensionTargetUrl: 'https://other.test/new-topic', extensionSession: { ...input, provider: 'google', loginUsername: 'bob@example.test' } } }]);
    await expect(service.configure(device.ownerId, 'account-a', { ...input, provider: 'google' })).rejects.toThrow('same Google identity');
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
});
