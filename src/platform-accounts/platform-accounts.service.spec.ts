import { AccountStatus } from '@prisma/client';
import { CredentialsService } from '../credentials/credentials.service';
import { PrismaService } from '../database/prisma.service';
import { PlatformAccountsService } from './platform-accounts.service';

describe('PlatformAccountsService credential updates', () => {
  it('merges editable connector settings while replacing the encrypted credential', async () => {
    const safeAccount = { id: 'account-1', settings: {} };
    const transactionalFind = jest.fn().mockResolvedValue({
        id: 'account-1',
        settings: {
          baseUrl: 'https://old.example.com',
          apiUsername: 'publisher',
          categoryId: '7',
          rateLimit: 3,
        },
      });
    const update = jest.fn().mockResolvedValue({ id: 'account-1' });
    const transaction = {
      platformAccount: { findFirstOrThrow: transactionalFind, update },
    };
    const findFirstOrThrow = jest.fn().mockResolvedValue(safeAccount);
    const runTransaction = jest.fn(
      (callback: (client: typeof transaction) => Promise<void>) => callback(transaction),
    );
    const prisma = {
      platformAccount: { findFirstOrThrow },
      $transaction: runTransaction,
    } as unknown as PrismaService;
    const upsert = jest.fn().mockResolvedValue(undefined);
    const credentials = { upsert } as unknown as CredentialsService;
    const service = new PlatformAccountsService(prisma, credentials);

    await expect(service.updateCredential(
      'owner-1',
      'account-1',
      { apiKey: 'new-secret' },
      {
        baseUrl: 'https://forum.example.com',
        apiUsername: 'new-publisher',
        categoryId: '12',
        defaultTags: 'guides, nodejs',
      },
    )).resolves.toBe(safeAccount);

    expect(runTransaction).toHaveBeenCalledTimes(1);
    expect(transactionalFind).toHaveBeenCalledWith({
      where: { id: 'account-1', ownerId: 'owner-1' },
      select: { id: true, settings: true },
    });
    expect(upsert).toHaveBeenCalledWith(
      'account-1',
      { apiKey: 'new-secret' },
      undefined,
      transaction,
    );
    expect(update).toHaveBeenCalledWith({
      where: { id: 'account-1' },
      data: {
        settings: {
          baseUrl: 'https://forum.example.com',
          apiUsername: 'new-publisher',
          categoryId: '12',
          defaultTags: 'guides, nodejs',
          rateLimit: 3,
        },
        status: AccountStatus.RECONNECT_REQUIRED,
        lastTestedAt: null,
      },
    });
  });

  it('keeps existing settings when an older client only replaces the credential', async () => {
    const safeAccount = { id: 'account-1', settings: { categoryId: '7' } };
    const transactionalFind = jest.fn()
      .mockResolvedValue({ id: 'account-1', settings: { categoryId: '7' } });
    const update = jest.fn().mockResolvedValue({ id: 'account-1' });
    const transaction = {
      platformAccount: { findFirstOrThrow: transactionalFind, update },
    };
    const prisma = {
      platformAccount: { findFirstOrThrow: jest.fn().mockResolvedValue(safeAccount) },
      $transaction: jest.fn(
        (callback: (client: typeof transaction) => Promise<void>) => callback(transaction),
      ),
    } as unknown as PrismaService;
    const upsert = jest.fn().mockResolvedValue(undefined);
    const credentials = { upsert } as unknown as CredentialsService;

    await new PlatformAccountsService(prisma, credentials).updateCredential(
      'owner-1',
      'account-1',
      { apiKey: 'new-secret' },
    );

    expect(upsert).toHaveBeenCalledWith(
      'account-1',
      { apiKey: 'new-secret' },
      undefined,
      transaction,
    );
    expect(update).toHaveBeenCalledWith({
      where: { id: 'account-1' },
      data: {
        status: AccountStatus.RECONNECT_REQUIRED,
        lastTestedAt: null,
      },
    });
  });
});
