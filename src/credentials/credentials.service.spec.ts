import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { CredentialEncryptionService } from './credential-encryption.service';
import { CredentialsService } from './credentials.service';

describe('CredentialsService', () => {
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
});
