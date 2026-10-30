import { AccountStatus, PlatformMode } from '@prisma/client';
import { CredentialsService } from '../credentials/credentials.service';
import { PrismaService } from '../database/prisma.service';
import { BrowserRecipeRegistry } from '../connectors/browser/browser-recipe.registry';
import { apiPublishingSettings, PlatformAccountsService } from './platform-accounts.service';
import { RedisService } from '../queue/redis.service';

function browserRecipes(): BrowserRecipeRegistry {
  return {
    get: jest.fn().mockReturnValue({
      startUrl: jest.fn().mockImplementation((account: { settings: Record<string, unknown> }) => {
        const forumPath = account.settings.forumPath;
        if (typeof forumPath !== 'string' || !forumPath) throw new Error('forumPath is required');
        return `https://voz.vn${forumPath}/post-thread`;
      }),
    }),
  } as unknown as BrowserRecipeRegistry;
}

describe('PlatformAccountsService credential updates', () => {
  it('creates a Chrome flow for a browser platform without requiring a Playwright path or session', async () => {
    const recipes = browserRecipes();
    const getRecipe = jest.spyOn(recipes, 'get');
    const create = jest.fn().mockResolvedValue({ id: 'account-1' });
    const prisma = {
      platform: { findUniqueOrThrow: jest.fn().mockResolvedValue({ id: 'voz', mode: PlatformMode.BROWSER_ASSISTED, defaultSettings: { browserRecipe: 'voz-xenforo', forumPath: '', extensionEngine: 'xenforo' } }) },
      platformAccount: { create, findFirstOrThrow: jest.fn().mockResolvedValue({ id: 'account-1', platform: { mode: PlatformMode.MANUAL } }) },
    } as unknown as PrismaService;
    const upsert = jest.fn();
    const credentials = { upsert } as unknown as CredentialsService;
    await new PlatformAccountsService(prisma, credentials, recipes).create('owner', { platformSlug: 'voz-forums', name: 'VOZ Chrome', settings: { delivery: 'extension' } });
    expect(getRecipe).not.toHaveBeenCalled();
    const saved = (create.mock.calls[0] as [{ data: Record<string, unknown> }])[0];
    expect(saved.data).toMatchObject({ status: AccountStatus.RECONNECT_REQUIRED, settings: { delivery: 'extension', extensionEngine: 'xenforo' } });
    expect(upsert).not.toHaveBeenCalled();
  });
  it('merges safe catalog defaults into a newly created account', async () => {
    const created = { id: 'account-1' };
    const safeAccount = { id: 'account-1', settings: { manualUrl: 'https://medium.com/new-story', locale: 'vi' } };
    const create = jest.fn().mockResolvedValue(created);
    const prisma = {
      platform: {
        findUniqueOrThrow: jest.fn().mockResolvedValue({
          id: 'platform-1',
          mode: PlatformMode.MANUAL,
          defaultSettings: { manualUrl: 'https://medium.com/new-story', locale: 'en' },
        }),
      },
      platformAccount: {
        create,
        findFirstOrThrow: jest.fn().mockResolvedValue(safeAccount),
      },
    } as unknown as PrismaService;
    const credentials = { upsert: jest.fn() } as unknown as CredentialsService;

    await expect(new PlatformAccountsService(prisma, credentials).create('owner-1', {
      platformSlug: 'medium',
      name: 'Medium manual',
      settings: { locale: 'vi' },
    })).resolves.toBe(safeAccount);

    expect(create).toHaveBeenCalledWith({
      data: {
        ownerId: 'owner-1',
        platformId: 'platform-1',
        name: 'Medium manual',
        username: undefined,
        externalId: undefined,
        settings: { manualUrl: 'https://medium.com/new-story', locale: 'vi' },
        enabled: true,
        status: AccountStatus.CONNECTED,
      },
      select: { id: true },
    });
  });

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
      select: { id: true, settings: true, platform: { select: { mode: true } } },
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

  it('updates browser policy settings without touching its encrypted session or connection state', async () => {
    const safeAccount = {
      id: 'account-1',
      status: AccountStatus.CONNECTED,
      settings: {
        browserRecipe: 'voz-xenforo',
        forumPath: '/f/technology.1',
        threadPrefixId: '',
        browserAutoSubmit: true,
        automationPermissionAttested: false,
      },
    };
    const update = jest.fn().mockResolvedValue({});
    const transaction = {
      platformAccount: {
        findFirstOrThrow: jest.fn().mockResolvedValue({
          id: 'account-1',
          enabled: true,
          status: AccountStatus.CONNECTED,
          lastTestedAt: new Date('2026-10-09T00:00:00.000Z'),
          settings: safeAccount.settings,
          platform: {
            mode: PlatformMode.BROWSER_ASSISTED,
            defaultSettings: {
              browserRecipe: 'voz-xenforo',
              forumPath: '',
              threadPrefixId: '',
              browserAutoSubmit: false,
              automationPermissionAttested: false,
            },
          },
        }),
        update,
      },
    };
    const prisma = {
      platformAccount: { findFirstOrThrow: jest.fn().mockResolvedValue(safeAccount) },
      $transaction: jest.fn(
        (callback: (client: typeof transaction) => Promise<void>) => callback(transaction),
      ),
    } as unknown as PrismaService;
    const credentialUpsert = jest.fn();
    const credentialMerge = jest.fn();
    const credentials = {
      upsert: credentialUpsert,
      merge: credentialMerge,
    } as unknown as CredentialsService;
    const service = new PlatformAccountsService(prisma, credentials, browserRecipes());

    await expect(service.updateSettings('owner-1', 'account-1', {
      browserAutoSubmit: false,
      automationPermissionAttested: true,
    })).resolves.toBe(safeAccount);

    expect(update).toHaveBeenCalledWith({
      where: { id: 'account-1' },
      data: {
        settings: {
          browserRecipe: 'voz-xenforo',
          forumPath: '/f/technology.1',
          threadPrefixId: '',
          browserAutoSubmit: false,
          automationPermissionAttested: true,
        },
      },
    });
    expect(credentialUpsert).not.toHaveBeenCalled();
    expect(credentialMerge).not.toHaveBeenCalled();
  });

  it('requires a new connection test when browser routing settings change', async () => {
    const update = jest.fn().mockResolvedValue({});
    const transaction = {
      platformAccount: {
        findFirstOrThrow: jest.fn().mockResolvedValue({
          id: 'account-1',
          enabled: true,
          status: AccountStatus.CONNECTED,
          lastTestedAt: new Date('2026-10-09T00:00:00.000Z'),
          settings: { browserRecipe: 'voz-xenforo', forumPath: '/f/old.1' },
          platform: {
            mode: PlatformMode.BROWSER_ASSISTED,
            defaultSettings: {
              browserRecipe: 'voz-xenforo',
              forumPath: '',
              threadPrefixId: '',
              browserAutoSubmit: false,
              automationPermissionAttested: false,
            },
          },
        }),
        update,
      },
    };
    const prisma = {
      platformAccount: { findFirstOrThrow: jest.fn().mockResolvedValue({ id: 'account-1' }) },
      $transaction: jest.fn(
        (callback: (client: typeof transaction) => Promise<void>) => callback(transaction),
      ),
    } as unknown as PrismaService;
    const service = new PlatformAccountsService(
      prisma,
      {} as CredentialsService,
      browserRecipes(),
    );

    await service.updateSettings('owner-1', 'account-1', { forumPath: '/f/new.2' });

    expect(update).toHaveBeenCalledWith({
      where: { id: 'account-1' },
      data: {
        settings: {
          browserRecipe: 'voz-xenforo',
          forumPath: '/f/new.2',
          threadPrefixId: '',
          browserAutoSubmit: false,
          automationPermissionAttested: false,
        },
        status: AccountStatus.RECONNECT_REQUIRED,
        lastTestedAt: null,
      },
    });
  });

  it('binds a browser recipe to the platform catalog and refuses a client override', async () => {
    const accountCreate = jest.fn();
    const prisma = {
      platform: {
        findUniqueOrThrow: jest.fn().mockResolvedValue({
          id: 'platform-voz',
          mode: PlatformMode.BROWSER_ASSISTED,
          defaultSettings: {
            browserRecipe: 'voz-xenforo',
            forumPath: '',
            browserAutoSubmit: false,
            automationPermissionAttested: false,
          },
        }),
      },
      platformAccount: { create: accountCreate },
    } as unknown as PrismaService;
    const service = new PlatformAccountsService(
      prisma,
      {} as CredentialsService,
      browserRecipes(),
    );

    await expect(service.create('owner-1', {
      platformSlug: 'voz-forums',
      name: 'VOZ',
      settings: {
        browserRecipe: 'some-other-registered-recipe',
        forumPath: '/f/technology.1',
      },
    })).rejects.toThrow('browserRecipe is controlled by the platform catalog');
    expect(accountCreate).not.toHaveBeenCalled();
  });

  it('returns browser session readiness without exposing encrypted storage state', async () => {
    const account = {
      id: 'account-1',
      platform: { mode: PlatformMode.BROWSER_ASSISTED },
      credential: { status: 'ACTIVE' },
    };
    const prisma = {
      platformAccount: { findFirstOrThrow: jest.fn().mockResolvedValue(account) },
    } as unknown as PrismaService;
    const resolve = jest.fn().mockResolvedValue({
      apiKey: 'unrelated-secret',
      storageState: {
        cookies: [{ name: 'session', value: 'encrypted-before-return', domain: 'voz.vn', path: '/' }],
        origins: [],
      },
    });
    const service = new PlatformAccountsService(
      prisma,
      { resolve } as unknown as CredentialsService,
      browserRecipes(),
    );

    await expect(service.get('owner-1', 'account-1')).resolves.toEqual({
      ...account,
      browserSessionConfigured: true,
    });
    expect(resolve).toHaveBeenCalledWith('account-1');
  });

  it('never infers an automatic connection from a stale successful or failed test timestamp', async () => {
    const update = jest.fn().mockResolvedValue({});
    const result = { id: 'account-1', platform: { mode: PlatformMode.BROWSER_ASSISTED }, credential: null };
    const prisma = {
      platformAccount: {
        findFirstOrThrow: jest
          .fn()
          .mockResolvedValueOnce({
            id: 'account-1',
            enabled: false,
            status: AccountStatus.DISABLED,
            lastTestedAt: new Date('2026-10-09T00:00:00.000Z'),
            platform: { mode: PlatformMode.BROWSER_ASSISTED },
          })
          .mockResolvedValueOnce(result),
        update,
      },
    } as unknown as PrismaService;
    const resolve = jest.fn();
    const service = new PlatformAccountsService(
      prisma,
      { resolve } as unknown as CredentialsService,
      browserRecipes(),
    );

    await expect(service.setEnabled('owner-1', 'account-1', true)).resolves.toEqual({
      ...result,
      browserSessionConfigured: false,
    });
    expect(update).toHaveBeenCalledWith({
      where: { id: 'account-1' },
      data: {
        enabled: true,
        status: AccountStatus.RECONNECT_REQUIRED,
        lastTestedAt: null,
      },
    });
    expect(resolve).not.toHaveBeenCalled();
  });

  it('revokes encrypted browser state while holding the shared browser-session lock', async () => {
    const transactionAccount = {
      findFirstOrThrow: jest.fn().mockResolvedValue({
        id: 'account-1',
        enabled: true,
        platform: { mode: PlatformMode.BROWSER_ASSISTED },
      }),
      update: jest.fn().mockResolvedValue({}),
    };
    const transaction = { platformAccount: transactionAccount };
    const safeAccount = {
      id: 'account-1',
      platform: { mode: PlatformMode.BROWSER_ASSISTED },
      credential: { status: 'REVOKED' },
    };
    const prisma = {
      platformAccount: { findFirstOrThrow: jest.fn().mockResolvedValue(safeAccount) },
      $transaction: jest.fn(
        (callback: (client: typeof transaction) => Promise<void>) => callback(transaction),
      ),
    } as unknown as PrismaService;
    const revoke = jest.fn().mockResolvedValue(undefined);
    const resolve = jest.fn().mockResolvedValue({});
    const acquireLock = jest.fn().mockResolvedValue('revoke-token');
    const extendLock = jest.fn().mockResolvedValue(true);
    const releaseLock = jest.fn().mockResolvedValue(true);
    const service = new PlatformAccountsService(
      prisma,
      { revoke, resolve } as unknown as CredentialsService,
      browserRecipes(),
      { acquireLock, extendLock, releaseLock } as unknown as RedisService,
    );

    await expect(service.revokeBrowserSession('owner-1', 'account-1')).resolves.toEqual({
      ...safeAccount,
      browserSessionConfigured: false,
    });
    expect(acquireLock).toHaveBeenCalledWith(expect.stringMatching(/^lock:browser-session:/), 60_000);
    expect(extendLock).toHaveBeenCalledWith(
      expect.stringMatching(/^lock:browser-session:/),
      'revoke-token',
      60_000,
    );
    expect(revoke).toHaveBeenCalledWith('account-1', transaction);
    expect(transactionAccount.update).toHaveBeenCalledWith({
      where: { id: 'account-1' },
      data: { status: AccountStatus.RECONNECT_REQUIRED, lastTestedAt: null },
    });
    expect(releaseLock).toHaveBeenCalledWith(expect.any(String), 'revoke-token');
  });

  it('does not revoke while login capture or publishing owns the browser session', async () => {
    const transaction = jest.fn();
    const service = new PlatformAccountsService(
      { $transaction: transaction } as unknown as PrismaService,
      {} as CredentialsService,
      browserRecipes(),
      {
        acquireLock: jest.fn().mockResolvedValue(null),
        releaseLock: jest.fn(),
      } as unknown as RedisService,
    );

    await expect(service.revokeBrowserSession('owner-1', 'account-1'))
      .rejects.toThrow('currently in use');
    expect(transaction).not.toHaveBeenCalled();
  });
});

describe('apiPublishingSettings', () => {
  it('accepts only publishing options for API accounts', () => {
    expect(apiPublishingSettings({ publishImmediately: true, rateLimit: 5 })).toEqual({ publishImmediately: true, rateLimit: 5 });
    expect(() => apiPublishingSettings({ accessToken: 'x' })).toThrow('accessToken');
    expect(() => apiPublishingSettings({ publishImmediately: 'yes' })).toThrow('true or false');
    expect(() => apiPublishingSettings({ rateLimit: 0 })).toThrow('positive integer');
  });
});
