import { ConfigService } from '@nestjs/config';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { RedisService } from '../../queue/redis.service';
import { BrowserAutomationService } from './browser-automation.service';
import { BrowserChallengeDetector } from './browser-challenge.detector';
import { BrowserNetworkGuard } from './browser-network-guard.service';
import { BrowserMediaPreparationService } from './browser-media-preparation.service';
import type { BrowserPublishRecipe } from './browser-automation.types';
import { BrowserSessionStateStore } from './browser-session-state.store';
import { BrowserSubmissionAuthorizationService } from './browser-submission-authorization.service';

jest.mock('playwright', () => ({ chromium: { launch: jest.fn() } }));
jest.mock('./browser-navigation-safety', () => ({
  assertPublicBrowserUrl: jest.fn().mockResolvedValue(new URL('https://example.com/editor')),
  safeBrowserActionUrl: jest.fn((value: string) => value),
}));

describe('BrowserAutomationService submission uncertainty', () => {
  afterEach(() => jest.clearAllMocks());

  it('keeps the submission uncertain and requests reconnect when a challenge appears after submit', async () => {
    const page = {
      goto: jest.fn().mockResolvedValue(undefined),
      url: jest.fn().mockReturnValue('https://example.com/editor'),
    } as unknown as Page;
    const state = { cookies: [], origins: [] };
    const storageState = jest.fn().mockResolvedValue({ cookies: [], origins: [] });
    const context = {
      setDefaultTimeout: jest.fn(),
      setDefaultNavigationTimeout: jest.fn(),
      newPage: jest.fn().mockResolvedValue(page),
      storageState,
      close: jest.fn().mockResolvedValue(undefined),
    } as unknown as BrowserContext;
    const browser = {
      newContext: jest.fn().mockResolvedValue(context),
      close: jest.fn().mockResolvedValue(undefined),
    } as unknown as Browser;
    // Accessing the mocked module method as a value is intentional in this unit test.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const launch = chromium.launch as jest.MockedFunction<typeof chromium.launch>;
    launch.mockResolvedValue(browser);

    const detect = jest
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({
        kind: 'TWO_FACTOR_REQUIRED',
        message: 'Two-factor authentication requires the account owner',
      });
    const releaseLock = jest.fn().mockResolvedValue(true);
    const save = jest.fn().mockResolvedValue(undefined);
    const service = new BrowserAutomationService(
      {
        get: jest.fn((key: string, fallback: unknown) =>
          key === 'BROWSER_AUTOMATION_ENABLED' ? true : fallback,
        ),
      } as unknown as ConfigService,
      {
        load: jest.fn().mockResolvedValue(state),
        save,
      } as unknown as BrowserSessionStateStore,
      { detect } as unknown as BrowserChallengeDetector,
      {
        acquireLock: jest.fn().mockResolvedValue('lock-token'),
        extendLock: jest.fn().mockResolvedValue(true),
        releaseLock,
      } as unknown as RedisService,
      browserNetworkGuard(),
      {
        withPreparedImages: jest.fn(
          (
            _recipe: BrowserPublishRecipe,
            _post: unknown,
            operation: (images: readonly never[]) => Promise<unknown>,
          ) => operation([]),
        ),
      } as unknown as BrowserMediaPreparationService,
      browserSubmitAuthorization(),
    );
    const recipe = {
      key: 'example',
      allowedHosts: ['example.com'],
      finalSubmitPolicy: 'AUTOMATED',
      startUrl: jest.fn().mockReturnValue('https://example.com/editor'),
      isEditorReady: jest.fn().mockResolvedValue(true),
      prepare: jest.fn().mockResolvedValue(undefined),
      submit: jest.fn().mockRejectedValue(new Error('response lost')),
    } satisfies BrowserPublishRecipe;

    await expect(
      service.publish(
        {
          id: 'account-1',
          settings: { browserAutoSubmit: true },
          credentials: { storageState: state },
        },
        { body: 'Body', idempotencyKey: 'job-1' },
        recipe,
      ),
    ).resolves.toMatchObject({
      status: 'NEEDS_ACTION',
      reason: 'SUBMISSION_UNCERTAIN',
      accountReconnectRequired: true,
      challengeKind: 'TWO_FACTOR_REQUIRED',
      reconciliationRequired: true,
      submissionUncertain: true,
    });
    expect(detect).toHaveBeenCalledTimes(3);
    expect(save).not.toHaveBeenCalled();
    expect(releaseLock).toHaveBeenCalledWith(expect.any(String), 'lock-token');
  });

  it('maps an invalid encrypted session to reconnect without launching or overwriting state', async () => {
    // Accessing the mocked module method as a value is intentional in this unit test.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const launch = chromium.launch as jest.MockedFunction<typeof chromium.launch>;
    const save = jest.fn();
    const releaseLock = jest.fn().mockResolvedValue(true);
    const service = new BrowserAutomationService(
      {
        get: jest.fn((key: string, fallback: unknown) =>
          key === 'BROWSER_AUTOMATION_ENABLED' ? true : fallback,
        ),
      } as unknown as ConfigService,
      {
        load: jest.fn().mockRejectedValue(new Error('invalid state')),
        save,
      } as unknown as BrowserSessionStateStore,
      { detect: jest.fn() } as unknown as BrowserChallengeDetector,
      {
        acquireLock: jest.fn().mockResolvedValue('lock-token'),
        extendLock: jest.fn().mockResolvedValue(true),
        releaseLock,
      } as unknown as RedisService,
      browserNetworkGuard(),
      { withPreparedImages: jest.fn() } as unknown as BrowserMediaPreparationService,
      browserSubmitAuthorization(),
    );
    const recipe = {
      key: 'example',
      allowedHosts: ['example.com'],
      finalSubmitPolicy: 'AUTOMATED',
      startUrl: jest.fn().mockReturnValue('https://example.com/editor'),
      isEditorReady: jest.fn(),
      prepare: jest.fn(),
      submit: jest.fn(),
    } satisfies BrowserPublishRecipe;

    await expect(service.inspect(
      {
        id: 'account-1',
        settings: {},
        credentials: { storageState: '{invalid' },
      },
      recipe,
    )).resolves.toEqual({
      ready: false,
      actionUrl: 'https://example.com/editor',
      message: 'The encrypted browser session is missing or invalid; capture a new login session',
      challenge: {
        kind: 'LOGIN_REQUIRED',
        message: 'The encrypted browser session is missing or invalid; capture a new login session',
      },
    });
    expect(launch).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
    expect(releaseLock).toHaveBeenCalledWith(expect.any(String), 'lock-token');
  });

  it('does not create an empty saved session when a new account reaches a login page', async () => {
    const page = {
      goto: jest.fn().mockResolvedValue(undefined),
      url: jest.fn().mockReturnValue('https://example.com/login'),
    } as unknown as Page;
    const storageState = jest.fn().mockResolvedValue({ cookies: [], origins: [] });
    const context = {
      setDefaultTimeout: jest.fn(),
      setDefaultNavigationTimeout: jest.fn(),
      newPage: jest.fn().mockResolvedValue(page),
      storageState,
      close: jest.fn().mockResolvedValue(undefined),
    } as unknown as BrowserContext;
    const browser = {
      newContext: jest.fn().mockResolvedValue(context),
      close: jest.fn().mockResolvedValue(undefined),
    } as unknown as Browser;
    // Accessing the mocked module method as a value is intentional in this unit test.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const launch = chromium.launch as jest.MockedFunction<typeof chromium.launch>;
    launch.mockResolvedValue(browser);
    const save = jest.fn();
    const service = new BrowserAutomationService(
      {
        get: jest.fn((key: string, fallback: unknown) =>
          key === 'BROWSER_AUTOMATION_ENABLED' ? true : fallback,
        ),
      } as unknown as ConfigService,
      {
        load: jest.fn().mockResolvedValue({ cookies: [], origins: [] }),
        save,
      } as unknown as BrowserSessionStateStore,
      {
        detect: jest.fn().mockResolvedValue({
          kind: 'LOGIN_REQUIRED',
          message: 'The saved browser session is signed out or expired',
        }),
      } as unknown as BrowserChallengeDetector,
      {
        acquireLock: jest.fn().mockResolvedValue('lock-token'),
        extendLock: jest.fn().mockResolvedValue(true),
        releaseLock: jest.fn().mockResolvedValue(true),
      } as unknown as RedisService,
      browserNetworkGuard(),
      { withPreparedImages: jest.fn() } as unknown as BrowserMediaPreparationService,
      browserSubmitAuthorization(),
    );
    const recipe = {
      key: 'example',
      allowedHosts: ['example.com'],
      finalSubmitPolicy: 'AUTOMATED',
      startUrl: jest.fn().mockReturnValue('https://example.com/editor'),
      isEditorReady: jest.fn(),
      prepare: jest.fn(),
      submit: jest.fn(),
    } satisfies BrowserPublishRecipe;

    await expect(service.publish(
      { id: 'account-1', settings: {}, credentials: {} },
      { body: 'Body', idempotencyKey: 'job-1' },
      recipe,
    )).resolves.toMatchObject({
      status: 'NEEDS_ACTION',
      reason: 'LOGIN_REQUIRED',
      challengeKind: 'LOGIN_REQUIRED',
      accountReconnectRequired: true,
    });
    expect(save).not.toHaveBeenCalled();
    expect(storageState).not.toHaveBeenCalled();
  });

  it('never enters submit without the explicit platform automation attestation', async () => {
    const page = {
      goto: jest.fn().mockResolvedValue(undefined),
      url: jest.fn().mockReturnValue('https://example.com/editor'),
    } as unknown as Page;
    const state = { cookies: [], origins: [] };
    const context = {
      setDefaultTimeout: jest.fn(),
      setDefaultNavigationTimeout: jest.fn(),
      newPage: jest.fn().mockResolvedValue(page),
      storageState: jest.fn().mockResolvedValue(state),
      close: jest.fn().mockResolvedValue(undefined),
    } as unknown as BrowserContext;
    const browser = {
      newContext: jest.fn().mockResolvedValue(context),
      close: jest.fn().mockResolvedValue(undefined),
    } as unknown as Browser;
    // Accessing the mocked module method as a value is intentional in this unit test.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const launch = chromium.launch as jest.MockedFunction<typeof chromium.launch>;
    launch.mockResolvedValue(browser);
    const submit = jest.fn().mockResolvedValue({ externalId: 'should-not-publish' });
    const recipe = {
      key: 'permission-gated',
      allowedHosts: ['example.com'],
      finalSubmitPolicy: 'AUTOMATED',
      requiresAutomationPermissionAttestation: true,
      startUrl: jest.fn().mockReturnValue('https://example.com/editor'),
      isEditorReady: jest.fn().mockResolvedValue(true),
      prepare: jest.fn().mockResolvedValue(undefined),
      submit,
    } satisfies BrowserPublishRecipe;
    const service = new BrowserAutomationService(
      {
        get: jest.fn((key: string, fallback: unknown) =>
          key === 'BROWSER_AUTOMATION_ENABLED' ? true : fallback,
        ),
      } as unknown as ConfigService,
      {
        load: jest.fn().mockResolvedValue(state),
        save: jest.fn().mockResolvedValue(undefined),
      } as unknown as BrowserSessionStateStore,
      { detect: jest.fn().mockResolvedValue(undefined) } as unknown as BrowserChallengeDetector,
      {
        acquireLock: jest.fn().mockResolvedValue('lock-token'),
        extendLock: jest.fn().mockResolvedValue(true),
        releaseLock: jest.fn().mockResolvedValue(true),
      } as unknown as RedisService,
      browserNetworkGuard(),
      {
        withPreparedImages: jest.fn(
          (
            _recipe: BrowserPublishRecipe,
            _post: unknown,
            operation: (images: readonly never[]) => Promise<unknown>,
          ) => operation([]),
        ),
      } as unknown as BrowserMediaPreparationService,
      browserSubmitAuthorization(),
    );

    await expect(service.publish(
      {
        id: 'account-1',
        settings: { browserAutoSubmit: true, automationPermissionAttested: false },
        credentials: { storageState: state },
      },
      { body: 'Body', idempotencyKey: 'job-1' },
      recipe,
    )).resolves.toMatchObject({
      status: 'NEEDS_ACTION',
      reason: 'SUBMISSION_CONFIRMATION_REQUIRED',
    });
    expect(submit).not.toHaveBeenCalled();
  });

  it('does not submit when session ownership is lost during the final authorization read', async () => {
    const page = {
      goto: jest.fn().mockResolvedValue(undefined),
      url: jest.fn().mockReturnValue('https://example.com/editor'),
    } as unknown as Page;
    const state = {
      cookies: [{ name: 'session', value: 'secret', domain: 'example.com', path: '/' }],
      origins: [],
    };
    const context = {
      setDefaultTimeout: jest.fn(),
      setDefaultNavigationTimeout: jest.fn(),
      newPage: jest.fn().mockResolvedValue(page),
      storageState: jest.fn().mockResolvedValue(state),
      close: jest.fn().mockResolvedValue(undefined),
    } as unknown as BrowserContext;
    const browser = {
      newContext: jest.fn().mockResolvedValue(context),
      close: jest.fn().mockResolvedValue(undefined),
    } as unknown as Browser;
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const launch = chromium.launch as jest.MockedFunction<typeof chromium.launch>;
    launch.mockResolvedValue(browser);
    const extendLock = jest
      .fn()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    const authorization = browserSubmitAuthorization();
    const submit = jest.fn().mockResolvedValue({ externalId: 'must-not-publish' });
    const service = new BrowserAutomationService(
      {
        get: jest.fn((key: string, fallback: unknown) =>
          key === 'BROWSER_AUTOMATION_ENABLED' ? true : fallback,
        ),
      } as unknown as ConfigService,
      {
        load: jest.fn().mockResolvedValue(state),
        save: jest.fn(),
      } as unknown as BrowserSessionStateStore,
      { detect: jest.fn().mockResolvedValue(undefined) } as unknown as BrowserChallengeDetector,
      {
        acquireLock: jest.fn().mockResolvedValue('old-owner-token'),
        extendLock,
        releaseLock: jest.fn().mockResolvedValue(false),
      } as unknown as RedisService,
      browserNetworkGuard(),
      {
        withPreparedImages: jest.fn(
          (
            _recipe: BrowserPublishRecipe,
            _post: unknown,
            operation: (images: readonly never[]) => Promise<unknown>,
          ) => operation([]),
        ),
      } as unknown as BrowserMediaPreparationService,
      authorization,
    );
    const recipe = {
      key: 'example',
      allowedHosts: ['example.com'],
      finalSubmitPolicy: 'AUTOMATED',
      startUrl: jest.fn().mockReturnValue('https://example.com/editor'),
      isEditorReady: jest.fn().mockResolvedValue(true),
      prepare: jest.fn().mockResolvedValue(undefined),
      submit,
    } satisfies BrowserPublishRecipe;

    await expect(service.publish(
      {
        id: 'account-1',
        settings: { browserAutoSubmit: true },
        credentials: { storageState: state },
      },
      { body: 'Body', idempotencyKey: 'job-1' },
      recipe,
    )).resolves.toMatchObject({
      status: 'NEEDS_ACTION',
      reason: 'AUTOMATION_BUSY',
    });
    expect((authorization as unknown as { inspect: jest.Mock }).inspect).toHaveBeenCalledTimes(1);
    expect(extendLock).toHaveBeenCalledTimes(2);
    expect(submit).not.toHaveBeenCalled();
  });

  it('rechecks database authorization after prepare and refuses a revoked session before submit', async () => {
    const page = {
      goto: jest.fn().mockResolvedValue(undefined),
      url: jest.fn().mockReturnValue('https://example.com/editor'),
    } as unknown as Page;
    const state = {
      cookies: [{ name: 'session', value: 'secret', domain: 'example.com', path: '/' }],
      origins: [],
    };
    const context = {
      setDefaultTimeout: jest.fn(),
      setDefaultNavigationTimeout: jest.fn(),
      newPage: jest.fn().mockResolvedValue(page),
      storageState: jest.fn().mockResolvedValue(state),
      close: jest.fn().mockResolvedValue(undefined),
    } as unknown as BrowserContext;
    const browser = {
      newContext: jest.fn().mockResolvedValue(context),
      close: jest.fn().mockResolvedValue(undefined),
    } as unknown as Browser;
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const launch = chromium.launch as jest.MockedFunction<typeof chromium.launch>;
    launch.mockResolvedValue(browser);
    const submit = jest.fn().mockResolvedValue({ externalId: 'must-not-publish' });
    const prepare = jest.fn().mockResolvedValue(undefined);
    const authorization = browserSubmitAuthorization({
      authorized: false,
      reason: 'LOGIN_REQUIRED',
      message: 'The browser session was revoked during preparation',
      reconnectRequired: true,
    });
    const service = new BrowserAutomationService(
      {
        get: jest.fn((key: string, fallback: unknown) =>
          key === 'BROWSER_AUTOMATION_ENABLED' ? true : fallback,
        ),
      } as unknown as ConfigService,
      { load: jest.fn().mockResolvedValue(state), save: jest.fn() } as unknown as BrowserSessionStateStore,
      { detect: jest.fn().mockResolvedValue(undefined) } as unknown as BrowserChallengeDetector,
      {
        acquireLock: jest.fn().mockResolvedValue('lock-token'),
        releaseLock: jest.fn().mockResolvedValue(true),
        extendLock: jest.fn().mockResolvedValue(true),
        isLockOwner: jest.fn().mockResolvedValue(true),
      } as unknown as RedisService,
      browserNetworkGuard(),
      {
        withPreparedImages: jest.fn(
          (
            _recipe: BrowserPublishRecipe,
            _post: unknown,
            operation: (images: readonly never[]) => Promise<unknown>,
          ) => operation([]),
        ),
      } as unknown as BrowserMediaPreparationService,
      authorization,
    );
    const recipe = {
      key: 'example',
      allowedHosts: ['example.com'],
      finalSubmitPolicy: 'AUTOMATED',
      requiresAutomationPermissionAttestation: true,
      startUrl: jest.fn().mockReturnValue('https://example.com/editor'),
      isEditorReady: jest.fn().mockResolvedValue(true),
      prepare,
      submit,
    } satisfies BrowserPublishRecipe;

    await expect(service.publish(
      {
        id: 'account-1',
        settings: { browserAutoSubmit: true, automationPermissionAttested: true },
        credentials: { storageState: state },
      },
      { body: 'Body', idempotencyKey: 'job-1' },
      recipe,
    )).resolves.toMatchObject({
      status: 'NEEDS_ACTION',
      reason: 'LOGIN_REQUIRED',
      accountReconnectRequired: true,
    });
    expect(prepare).toHaveBeenCalledTimes(1);
    expect((authorization as unknown as { inspect: jest.Mock }).inspect)
      .toHaveBeenCalledWith('account-1', 'example');
    expect(submit).not.toHaveBeenCalled();
  });
});
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

function browserSubmitAuthorization(
  result: { authorized: true } | {
    authorized: false;
    reason: 'AUTOMATION_DISABLED' | 'LOGIN_REQUIRED' | 'SUBMISSION_CONFIRMATION_REQUIRED';
    message: string;
    reconnectRequired?: boolean;
  } = { authorized: true },
): BrowserSubmissionAuthorizationService {
  return {
    inspect: jest.fn().mockResolvedValue(result),
  } as unknown as BrowserSubmissionAuthorizationService;
}

