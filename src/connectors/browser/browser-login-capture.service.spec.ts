import { ConfigService } from '@nestjs/config';
import { access } from 'node:fs/promises';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { PrismaService } from '../../database/prisma.service';
import { RedisService } from '../../queue/redis.service';
import { ConnectorAccountsService } from '../connector-accounts.service';
import { BrowserChallengeDetector } from './browser-challenge.detector';
import { BrowserLoginCaptureService } from './browser-login-capture.service';
import { BrowserNetworkGuard } from './browser-network-guard.service';
import { BrowserRecipeRegistry } from './browser-recipe.registry';
import { BrowserSessionStateStore } from './browser-session-state.store';

function browserNetworkGuard(): BrowserNetworkGuard {
  return {
    startProxy: jest.fn().mockResolvedValue({
      server: 'http://127.0.0.1:32123',
      chromiumArgs: [],
      close: jest.fn().mockResolvedValue(undefined),
    }),
    install: jest.fn().mockResolvedValue(undefined),
  } as unknown as BrowserNetworkGuard;
}

jest.mock('playwright', () => ({
  chromium: {
    launch: jest.fn(),
    executablePath: jest.fn().mockReturnValue('C:/playwright/chromium.exe'),
  },
}));
jest.mock('node:fs/promises', () => ({ access: jest.fn() }));
jest.mock('./browser-navigation-safety', () => ({
  assertPublicBrowserUrl: jest.fn().mockResolvedValue(new URL('https://example.com/editor')),
  safeBrowserActionUrl: jest.fn((value: string) => value),
}));

describe('BrowserLoginCaptureService', () => {
  beforeEach(() => {
    (access as jest.MockedFunction<typeof access>).mockResolvedValue(undefined);
  });

  afterEach(() => jest.clearAllMocks());

  it('captures storage state without accepting an account password', async () => {
    const page = {
      goto: jest.fn().mockResolvedValue(undefined),
      isClosed: jest.fn().mockReturnValue(false),
      url: jest.fn().mockReturnValue('https://example.com/editor'),
    } as unknown as Page;
    const browserClose = jest.fn().mockResolvedValue(undefined);
    const state = {
      cookies: [{ name: 'session', value: 'secret', domain: 'example.com', path: '/' }],
      origins: [],
    };
    const context = {
      newPage: jest.fn().mockResolvedValue(page),
      pages: jest.fn().mockReturnValue([page]),
      storageState: jest.fn().mockResolvedValue(state),
      close: jest.fn().mockResolvedValue(undefined),
    } as unknown as BrowserContext;
    // Accessing the mocked module method as a value is intentional in this unit test.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const launch = chromium.launch as jest.MockedFunction<typeof chromium.launch>;
    launch.mockResolvedValue({
      newContext: jest.fn().mockResolvedValue(context),
      close: browserClose,
    } as unknown as Browser);
    const account = {
      id: 'account-1',
      settings: { browserRecipe: 'approved-editor' },
      credentials: {},
    };
    const accounts = {
      loadForBrowserLoginCapture: jest.fn().mockResolvedValue({ connectorKey: 'browser-assisted', account }),
    } as unknown as ConnectorAccountsService;
    const recipe = {
      key: 'approved-editor',
      allowedHosts: ['example.com'],
      startUrl: jest.fn().mockReturnValue('https://example.com/editor'),
      isEditorReady: jest.fn().mockResolvedValue(true),
    };
    const recipes = { get: jest.fn().mockReturnValue(recipe) } as unknown as BrowserRecipeRegistry;
    const save = jest.fn().mockResolvedValue(undefined);
    const sessions = {
      load: jest.fn().mockResolvedValue(state),
      save,
    } as unknown as BrowserSessionStateStore;
    const releaseLock = jest.fn().mockResolvedValue(true);
    const redis = {
      acquireLock: jest.fn().mockResolvedValue('lock-token'),
      extendLock: jest.fn().mockResolvedValue(true),
      releaseLock,
    } as unknown as RedisService;
    const updateCalls: unknown[] = [];
    const updateMany = jest.fn((input: unknown) => {
      updateCalls.push(input);
      return Promise.resolve({ count: 1 });
    });
    const service = new BrowserLoginCaptureService(
      { get: jest.fn().mockReturnValue(undefined) } as unknown as ConfigService,
      accounts,
      recipes,
      sessions,
      { detect: jest.fn().mockResolvedValue(undefined) } as unknown as BrowserChallengeDetector,
      browserNetworkGuard(),
      redis,
      { platformAccount: { updateMany } } as unknown as PrismaService,
    );

    const result = await service.capture('account-1', (signal) => new Promise((resolve) => {
      signal.addEventListener('abort', () => resolve(), { once: true });
    }));

    expect(result).toMatchObject({ accountId: 'account-1', browserRecipe: 'approved-editor' });
    expect(launch).toHaveBeenCalledWith(expect.objectContaining({ headless: false }));
    expect(save).toHaveBeenCalledWith('account-1', state);
    expect(updateCalls[0]).toMatchObject({
      where: { id: 'account-1', enabled: true },
      data: { status: 'CONNECTED' },
    });
    expect(releaseLock).toHaveBeenCalledWith(expect.any(String), 'lock-token');
  });

  it('does not save or mark connected when capture returns an empty login state', async () => {
    const { service, save, updateMany } = readyCaptureHarness(
      { cookies: [], origins: [] },
      jest.fn().mockResolvedValue(true),
    );

    await expect(service.capture('account-1', () => new Promise(() => undefined)))
      .rejects.toThrow('Login state is missing');

    expect(save).not.toHaveBeenCalled();
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('does not save or mark connected after browser-session lease ownership is lost', async () => {
    const captured = {
      cookies: [{ name: 'session', value: 'secret', domain: 'example.com', path: '/' }],
      origins: [],
    };
    const extendLock = jest.fn().mockResolvedValue(false);
    const { service, save, updateMany } = readyCaptureHarness(captured, extendLock);

    await expect(service.capture('account-1', () => new Promise(() => undefined)))
      .rejects.toThrow('Browser session ownership changed');

    expect(extendLock).toHaveBeenCalledWith(expect.any(String), 'lock-token', 16 * 60_000);
    expect(save).not.toHaveBeenCalled();
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('closes a launched browser when newContext fails', async () => {
    const close = jest.fn().mockResolvedValue(undefined);
    const browser = {
      newContext: jest.fn().mockRejectedValue(new Error('context failed')),
      close,
    } as unknown as Browser;
    // Accessing the mocked module method as a value is intentional in this unit test.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const launch = chromium.launch as jest.MockedFunction<typeof chromium.launch>;
    launch.mockResolvedValue(browser);
    const { service, releaseLock } = loginCaptureHarness();

    await expect(service.capture('account-1', () => Promise.resolve()))
      .rejects.toThrow('context failed');

    expect(close).toHaveBeenCalledTimes(1);
    expect(releaseLock).toHaveBeenCalledWith(expect.any(String), 'lock-token');
  });

  it('reports the local install command when Chromium is missing', async () => {
    (access as jest.MockedFunction<typeof access>).mockRejectedValueOnce(new Error('ENOENT'));
    // Accessing the mocked module method as a value is intentional in this unit test.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const launch = chromium.launch as jest.MockedFunction<typeof chromium.launch>;
    const { service, releaseLock } = loginCaptureHarness();

    await expect(service.capture('account-1', () => Promise.resolve()))
      .rejects.toThrow('pnpm browser:install');

    expect(launch).not.toHaveBeenCalled();
    expect(releaseLock).toHaveBeenCalledWith(expect.any(String), 'lock-token');
  });
});

function loginCaptureHarness(): {
  service: BrowserLoginCaptureService;
  releaseLock: jest.Mock;
} {
  const account = {
    id: 'account-1',
    settings: { browserRecipe: 'test-recipe' },
    credentials: {},
  };
  const accounts = {
    loadForBrowserLoginCapture: jest.fn().mockResolvedValue({ connectorKey: 'browser-assisted', account }),
  } as unknown as ConnectorAccountsService;
  const recipe = {
    key: 'test-recipe',
    allowedHosts: ['example.com'],
    finalSubmitPolicy: 'HUMAN_REQUIRED',
    startUrl: jest.fn().mockReturnValue('https://example.com/editor'),
    isEditorReady: jest.fn().mockResolvedValue(false),
  };
  const releaseLock = jest.fn().mockResolvedValue(true);
  const service = new BrowserLoginCaptureService(
    { get: jest.fn().mockReturnValue(undefined) } as unknown as ConfigService,
    accounts,
    { get: jest.fn().mockReturnValue(recipe) } as unknown as BrowserRecipeRegistry,
    {
      load: jest.fn().mockResolvedValue({ cookies: [], origins: [] }),
      save: jest.fn().mockResolvedValue(undefined),
    } as unknown as BrowserSessionStateStore,
    { detect: jest.fn().mockResolvedValue(undefined) } as unknown as BrowserChallengeDetector,
    browserNetworkGuard(),
    {
      acquireLock: jest.fn().mockResolvedValue('lock-token'),
      extendLock: jest.fn().mockResolvedValue(true),
      releaseLock,
    } as unknown as RedisService,
    { platformAccount: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) } } as unknown as PrismaService,
  );
  return { service, releaseLock };
}

function readyCaptureHarness(
  capturedState: { cookies: unknown[]; origins: unknown[] },
  extendLock: jest.Mock,
): {
  service: BrowserLoginCaptureService;
  save: jest.Mock;
  updateMany: jest.Mock;
} {
  const page = {
    goto: jest.fn().mockResolvedValue(undefined),
    isClosed: jest.fn().mockReturnValue(false),
    url: jest.fn().mockReturnValue('https://example.com/editor'),
  } as unknown as Page;
  const context = {
    newPage: jest.fn().mockResolvedValue(page),
    pages: jest.fn().mockReturnValue([page]),
    storageState: jest.fn().mockResolvedValue(capturedState),
    close: jest.fn().mockResolvedValue(undefined),
  } as unknown as BrowserContext;
  // Accessing the mocked module method as a value is intentional in this unit test.
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const launch = chromium.launch as jest.MockedFunction<typeof chromium.launch>;
  launch.mockResolvedValue({
    newContext: jest.fn().mockResolvedValue(context),
    close: jest.fn().mockResolvedValue(undefined),
  } as unknown as Browser);
  const account = {
    id: 'account-1',
    settings: { browserRecipe: 'approved-editor' },
    credentials: {},
  };
  const save = jest.fn().mockResolvedValue(undefined);
  const updateMany = jest.fn().mockResolvedValue({ count: 1 });
  const service = new BrowserLoginCaptureService(
    { get: jest.fn().mockReturnValue(undefined) } as unknown as ConfigService,
    {
      loadForBrowserLoginCapture: jest.fn().mockResolvedValue({
        connectorKey: 'browser-assisted',
        enabled: true,
        account,
      }),
    } as unknown as ConnectorAccountsService,
    {
      get: jest.fn().mockReturnValue({
        key: 'approved-editor',
        allowedHosts: ['example.com'],
        startUrl: jest.fn().mockReturnValue('https://example.com/editor'),
        isEditorReady: jest.fn().mockResolvedValue(true),
      }),
    } as unknown as BrowserRecipeRegistry,
    {
      load: jest.fn().mockResolvedValue({ cookies: [], origins: [] }),
      save,
    } as unknown as BrowserSessionStateStore,
    { detect: jest.fn().mockResolvedValue(undefined) } as unknown as BrowserChallengeDetector,
    browserNetworkGuard(),
    {
      acquireLock: jest.fn().mockResolvedValue('lock-token'),
      extendLock,
      releaseLock: jest.fn().mockResolvedValue(true),
    } as unknown as RedisService,
    { platformAccount: { updateMany } } as unknown as PrismaService,
  );
  return { service, save, updateMany };
}
