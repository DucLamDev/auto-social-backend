import { AccountStatus, CredentialStatus, PlatformMode } from '@prisma/client';
import { CredentialsService } from '../credentials/credentials.service';
import { PrismaService } from '../database/prisma.service';
import { ConnectorAccountsService } from './connector-accounts.service';
import { ConnectorError } from './core/connector-error';
import { ConnectorRegistryService } from './core/connector-registry.service';
import { ManualConnector } from './manual/manual.connector';
import { ErrorCode } from '../common/exceptions/application.exception';

describe('ConnectorAccountsService', () => {
  it('dispatches an aliased platform through connectorKey', async () => {
    type UpdateInput = {
      where: { id: string };
      data: { status: AccountStatus; lastTestedAt: Date };
    };
    let updateInput: UpdateInput | undefined;
    const update = jest.fn((input: UpdateInput) => {
      updateInput = input;
      return Promise.resolve(undefined);
    });
    const prisma = {
      platformAccount: {
        findUniqueOrThrow: jest.fn().mockResolvedValue({
          id: 'account-1',
          externalId: null,
          username: null,
          settings: { manualUrl: 'https://medium.com/new-story' },
          platform: { slug: 'medium', connectorKey: 'manual' },
          credential: null,
          oauthToken: null,
        }),
        update,
      },
    } as unknown as PrismaService;
    const registry = new ConnectorRegistryService();
    registry.register(new ManualConnector('manual'));
    const service = new ConnectorAccountsService(
      prisma,
      {} as CredentialsService,
      registry,
    );

    await expect(service.test('account-1')).resolves.toMatchObject({
      ok: true,
      manual: true,
      ready: true,
    });
    expect(update).toHaveBeenCalledTimes(1);
    expect(updateInput?.where).toEqual({ id: 'account-1' });
    expect(updateInput?.data.status).toBe(AccountStatus.CONNECTED);
    expect(updateInput?.data.lastTestedAt).toBeInstanceOf(Date);
  });

  it.each([
    'CAPTCHA_REQUIRED',
    'LOGIN_REQUIRED',
    'SECURITY_CHECK_REQUIRED',
    'TWO_FACTOR_REQUIRED',
  ])('marks a browser-assisted account for reconnect after %s', async (reason) => {
    const update = jest.fn().mockResolvedValue(undefined);
    const prisma = {
      platformAccount: {
        findUniqueOrThrow: jest.fn().mockResolvedValue({
          id: 'account-browser',
          externalId: null,
          username: null,
          settings: { browserRecipe: 'approved-editor' },
          platform: { slug: 'approved-editor', connectorKey: 'browser-assisted' },
          credential: null,
          oauthToken: null,
        }),
        update,
      },
    } as unknown as PrismaService;
    const failure = new ConnectorError(
      ErrorCode.CONNECTOR_NEEDS_ACTION,
      'Reconnect the browser session',
      false,
      undefined,
      { reason },
    );
    const registry = {
      get: jest.fn().mockReturnValue({
        testConnection: jest.fn().mockRejectedValue(failure),
      }),
    } as unknown as ConnectorRegistryService;
    const service = new ConnectorAccountsService(prisma, {} as CredentialsService, registry);

    await expect(service.test('account-browser')).rejects.toBe(failure);
    expect(update).toHaveBeenCalledWith({
      where: { id: 'account-browser' },
      data: {
        status: AccountStatus.RECONNECT_REQUIRED,
        lastTestedAt: expect.any(Date) as Date,
      },
    });
  });

  it('keeps non-challenge browser test failures in ERROR', async () => {
    const update = jest.fn().mockResolvedValue(undefined);
    const prisma = {
      platformAccount: {
        findUniqueOrThrow: jest.fn().mockResolvedValue({
          id: 'account-browser',
          externalId: null,
          username: null,
          settings: { browserRecipe: 'approved-editor' },
          platform: { slug: 'approved-editor', connectorKey: 'browser-assisted' },
          credential: null,
          oauthToken: null,
        }),
        update,
      },
    } as unknown as PrismaService;
    const failure = new ConnectorError(
      ErrorCode.CONNECTOR_NEEDS_ACTION,
      'Editor changed',
      false,
      undefined,
      { reason: 'EDITOR_NOT_FOUND' },
    );
    const registry = {
      get: jest.fn().mockReturnValue({ testConnection: jest.fn().mockRejectedValue(failure) }),
    } as unknown as ConnectorRegistryService;
    const service = new ConnectorAccountsService(prisma, {} as CredentialsService, registry);

    await expect(service.test('account-browser')).rejects.toBe(failure);
    expect(update).toHaveBeenCalledWith({
      where: { id: 'account-browser' },
      data: { status: AccountStatus.ERROR, lastTestedAt: expect.any(Date) as Date },
    });
  });

  it.each([
    {
      label: 'revoked',
      status: CredentialStatus.REVOKED,
      expiresAt: null,
    },
    {
      label: 'expired',
      status: CredentialStatus.ACTIVE,
      expiresAt: new Date(Date.now() - 60_000),
    },
  ])('starts browser login with empty state for an $label browser credential', async ({ status, expiresAt }) => {
    const resolve = jest.fn();
    const prisma = {
      platformAccount: {
        findUniqueOrThrow: jest.fn().mockResolvedValue({
          id: 'account-browser',
          externalId: null,
          username: null,
          settings: { browserRecipe: 'voz-xenforo', forumPath: '/f/gop-y.3' },
          enabled: true,
          status: AccountStatus.RECONNECT_REQUIRED,
          platform: {
            slug: 'voz-forums',
            connectorKey: 'browser-assisted',
            enabled: true,
            mode: PlatformMode.BROWSER_ASSISTED,
          },
          credential: { id: 'credential-1', status, expiresAt },
          oauthToken: null,
        }),
      },
    } as unknown as PrismaService;
    const service = new ConnectorAccountsService(
      prisma,
      { resolve } as unknown as CredentialsService,
      {} as ConnectorRegistryService,
    );

    await expect(service.loadForBrowserLoginCapture('account-browser')).resolves.toMatchObject({
      connectorKey: 'browser-assisted',
      account: { credentials: {} },
    });
    expect(resolve).not.toHaveBeenCalled();
  });

  it('still resolves and validates an active credential during browser login capture', async () => {
    const resolve = jest.fn().mockRejectedValue(new Error('encrypted payload is corrupt'));
    const prisma = {
      platformAccount: {
        findUniqueOrThrow: jest.fn().mockResolvedValue({
          id: 'account-browser',
          externalId: null,
          username: null,
          settings: { browserRecipe: 'voz-xenforo', forumPath: '/f/gop-y.3' },
          enabled: true,
          status: AccountStatus.RECONNECT_REQUIRED,
          platform: {
            slug: 'voz-forums',
            connectorKey: 'browser-assisted',
            enabled: true,
            mode: PlatformMode.BROWSER_ASSISTED,
          },
          credential: {
            id: 'credential-1',
            status: CredentialStatus.ACTIVE,
            expiresAt: null,
          },
          oauthToken: null,
        }),
      },
    } as unknown as PrismaService;
    const service = new ConnectorAccountsService(
      prisma,
      { resolve } as unknown as CredentialsService,
      {} as ConnectorRegistryService,
    );

    await expect(service.loadForBrowserLoginCapture('account-browser'))
      .rejects.toThrow('encrypted payload is corrupt');
    expect(resolve).toHaveBeenCalledWith('account-browser');
  });
});
