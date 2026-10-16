import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { CredentialEncryptionService } from './credential-encryption.service';
import { CredentialsService } from './credentials.service';

describe('CredentialsService', () => {
  it('refuses to reactivate a revoked credential during automatic auth recovery', async () => {
    const decrypt = jest.fn();
    const updateMany = jest.fn();
    const service = new CredentialsService({ platformCredential: {
      findUnique: jest.fn().mockResolvedValue({ status: 'REVOKED', expiresAt: null, encryptedPayload: 'revoked' }), updateMany,
    } } as unknown as PrismaService, { decrypt } as unknown as CredentialEncryptionService, {} as ConfigService);
    await expect(service.merge('account-1', { storageState: { cookies: [], origins: [] } }, { requireActive: true })).rejects.toThrow('revoked');
    expect(decrypt).not.toHaveBeenCalled();
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('preserves revocation when it races an encrypted session refresh', async () => {
    const updatedAt = new Date('2026-10-13T00:00:00Z');
    const updateMany = jest.fn().mockResolvedValue({ count: 0 });
    const service = new CredentialsService({ platformCredential: {
      findUnique: jest.fn().mockResolvedValueOnce({ status: 'ACTIVE', expiresAt: null, encryptedPayload: 'before', updatedAt })
        .mockResolvedValueOnce({ status: 'REVOKED', expiresAt: null, encryptedPayload: 'revoked', updatedAt }), updateMany,
    } } as unknown as PrismaService, { decrypt: jest.fn().mockReturnValue({}), encrypt: jest.fn().mockReturnValue('after'), keyVersion: 'v1' } as unknown as CredentialEncryptionService, {} as ConfigService);
    await expect(service.merge('account-1', { storageState: { cookies: [], origins: [] } }, { requireActive: true })).rejects.toThrow('revoked');
    expect(updateMany).toHaveBeenCalledTimes(1);
    expect(updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({
      updatedAt, status: 'ACTIVE', OR: [{ expiresAt: null }, { expiresAt: { gt: expect.any(Date) as unknown } }],
    }) as unknown }));
  });

  it('resolves only active, unexpired credential payloads', async () => {
    const decrypt = jest.fn().mockReturnValue({ apiKey: 'secret' });
    const findUniqueOrThrow = jest.fn().mockResolvedValue({
      encryptedPayload: 'encrypted-payload',
      status: 'ACTIVE',
      expiresAt: new Date(Date.now() + 60_000),
    });
    const service = new CredentialsService(
      { platformCredential: { findUniqueOrThrow } } as unknown as PrismaService,
      { decrypt } as unknown as CredentialEncryptionService,
      {} as ConfigService,
    );

    await expect(service.resolve('account-1')).resolves.toEqual({ apiKey: 'secret' });
    expect(findUniqueOrThrow).toHaveBeenCalledWith({
      where: { platformAccountId: 'account-1' },
      select: { encryptedPayload: true, status: true, expiresAt: true },
    });
  });

  it.each([
    ['REVOKED', null],
    ['ACTIVE', new Date(Date.now() - 1_000)],
  ])('rejects %s or expired credential material', async (status, expiresAt) => {
    const decrypt = jest.fn();
    const service = new CredentialsService(
      {
        platformCredential: {
          findUniqueOrThrow: jest.fn().mockResolvedValue({
            encryptedPayload: 'must-not-decrypt',
            status,
            expiresAt,
          }),
        },
      } as unknown as PrismaService,
      { decrypt } as unknown as CredentialEncryptionService,
      {} as ConfigService,
    );

    await expect(service.resolve('account-1')).rejects.toMatchObject({
      code: 'PLATFORM_TOKEN_EXPIRED',
    });
    expect(decrypt).not.toHaveBeenCalled();
  });

  it('uses the supplied transaction client for an atomic credential upsert', async () => {
    const defaultUpsert = jest.fn();
    const transactionalUpsert = jest.fn().mockResolvedValue({});
    const encrypt = jest.fn().mockReturnValue('encrypted-payload');
    const prisma = {
      platformCredential: { upsert: defaultUpsert },
    } as unknown as PrismaService;
    const encryption = {
      encrypt,
      keyVersion: 'v2',
    } as unknown as CredentialEncryptionService;
    const transaction = {
      platformCredential: { upsert: transactionalUpsert },
    } as unknown as Prisma.TransactionClient;
    const service = new CredentialsService(
      prisma,
      encryption,
      {} as ConfigService,
    );
    const expiresAt = new Date('2026-10-08T00:00:00.000Z');

    await service.upsert(
      'account-1',
      { apiKey: 'secret' },
      expiresAt,
      transaction,
    );

    expect(encrypt).toHaveBeenCalledWith({ apiKey: 'secret' });
    expect(defaultUpsert).not.toHaveBeenCalled();
    expect(transactionalUpsert).toHaveBeenCalledWith({
      where: { platformAccountId: 'account-1' },
      create: {
        platformAccountId: 'account-1',
        encryptedPayload: 'encrypted-payload',
        keyVersion: 'v2',
        status: 'ACTIVE',
        expiresAt,
      },
      update: {
        encryptedPayload: 'encrypted-payload',
        keyVersion: 'v2',
        status: 'ACTIVE',
        expiresAt,
      },
    });
  });

  it('merges refreshed browser state without dropping other encrypted fields', async () => {
    const updatedAt = new Date('2026-10-09T00:00:00.000Z');
    const findUnique = jest.fn().mockResolvedValue({
      encryptedPayload: 'before',
      updatedAt,
    });
    const updateMany = jest.fn().mockResolvedValue({ count: 1 });
    const prisma = {
      platformCredential: { findUnique, updateMany },
    } as unknown as PrismaService;
    const encrypt = jest.fn().mockReturnValue('after');
    const encryption = {
      decrypt: jest.fn().mockReturnValue({ apiKey: 'preserved', storageState: { cookies: [] } }),
      encrypt,
      keyVersion: 'v2',
    } as unknown as CredentialEncryptionService;
    const service = new CredentialsService(prisma, encryption, {} as ConfigService);

    await service.merge('account-1', { storageState: { cookies: ['new'], origins: [] } });

    expect(encrypt).toHaveBeenCalledWith({
      apiKey: 'preserved',
      storageState: { cookies: ['new'], origins: [] },
    });
    expect(updateMany).toHaveBeenCalledWith({
      where: { platformAccountId: 'account-1', updatedAt },
      data: {
        encryptedPayload: 'after',
        keyVersion: 'v2',
        status: 'ACTIVE',
        expiresAt: null,
      },
    });
  });

  it('creates the first encrypted credential row during browser login capture', async () => {
    const create = jest.fn().mockResolvedValue({});
    const prisma = {
      platformCredential: {
        findUnique: jest.fn().mockResolvedValue(null),
        create,
      },
    } as unknown as PrismaService;
    const encrypt = jest.fn().mockReturnValue('encrypted-browser-state');
    const encryption = {
      encrypt,
      keyVersion: 'v3',
    } as unknown as CredentialEncryptionService;
    const service = new CredentialsService(prisma, encryption, {} as ConfigService);
    const storageState = { cookies: [], origins: [] };

    await service.merge('account-new', { storageState });

    expect(encrypt).toHaveBeenCalledWith({ storageState });
    expect(create).toHaveBeenCalledWith({
      data: {
        platformAccountId: 'account-new',
        encryptedPayload: 'encrypted-browser-state',
        keyVersion: 'v3',
        status: 'ACTIVE',
      },
    });
  });

  it('cryptographically clears and revokes a captured browser session', async () => {
    const updateMany = jest.fn().mockResolvedValue({ count: 1 });
    const transaction = { platformCredential: { updateMany } };
    const encrypt = jest.fn().mockReturnValue('encrypted-empty-payload');
    const encryption = {
      encrypt,
      keyVersion: 'v4',
    } as unknown as CredentialEncryptionService;
    const service = new CredentialsService(
      {} as PrismaService,
      encryption,
      {} as ConfigService,
    );

    await service.revoke('account-1', transaction as never);

    expect(encrypt).toHaveBeenCalledWith({});
    expect(updateMany).toHaveBeenCalledWith({
      where: { platformAccountId: 'account-1' },
      data: {
        encryptedPayload: 'encrypted-empty-payload',
        keyVersion: 'v4',
        status: 'REVOKED',
        expiresAt: null,
      },
    });
  });
});
