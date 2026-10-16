import { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';
import type { BrowserContext, Page } from 'playwright';
import { AuthManager } from '../../auth/auth-manager';
import { AuthDetector } from '../../auth/auth-detector';
import { AuthState, AccountRuntimeState } from '../../auth/auth.types';
import { SessionManager } from '../../auth/session-manager';
import { RedisService } from '../../queue/redis.service';
import { BrowserAutomationService } from './browser-automation.service';
import { BrowserChallengeDetector } from './browser-challenge.detector';
import { BrowserSessionStateStore } from './browser-session-state.store';
import { BrowserNetworkGuard } from './browser-network-guard.service';
import { BrowserMediaPreparationService } from './browser-media-preparation.service';
import { BrowserSubmissionAuthorizationService } from './browser-submission-authorization.service';
import type { BrowserPublishRecipe } from './browser-automation.types';

jest.mock('../../auth/session-manager');
jest.mock('./browser-chromium', () => ({ assertChromiumInstalled: jest.fn().mockResolvedValue(undefined), BrowserRuntimeUnavailableError: class extends Error {} }));
jest.mock('./browser-navigation-safety', () => ({ assertPublicBrowserUrl: jest.fn().mockResolvedValue(undefined), safeBrowserActionUrl: (url: string) => url }));

describe('Browser publisher auth recovery integration (mock browser)', () => {
  const traceStart = jest.fn();
  const prepare = jest.fn().mockResolvedValue(undefined);
  const submit = jest.fn().mockResolvedValue({ externalId: 'post-1' });
  let ensureAuth: jest.SpyInstance<ReturnType<AuthManager['ensureAuthenticated']>, Parameters<AuthManager['ensureAuthenticated']>>;
  const page = { goto: jest.fn().mockResolvedValue(undefined), url: () => 'https://fixture.example.com/editor' } as unknown as Page;
  const context = { setDefaultTimeout: jest.fn(), setDefaultNavigationTimeout: jest.fn(),
    storageState: jest.fn().mockResolvedValue({ cookies: [], origins: [] }), close: jest.fn().mockResolvedValue(undefined),
    tracing: { start: traceStart },
  } as unknown as BrowserContext;
  const save = jest.fn().mockResolvedValue(undefined);
  const releaseLock = jest.fn().mockResolvedValue(undefined);
  const verify = jest.fn().mockResolvedValue(true);
  const proxyClose = jest.fn().mockResolvedValue(undefined);
  const recipe: BrowserPublishRecipe = {
    key: 'fixture', allowedHosts: ['fixture.example.com'], finalSubmitPolicy: 'AUTOMATED',
    startUrl: () => 'https://fixture.example.com/editor', isEditorReady: jest.fn().mockResolvedValue(true),
    prepare, submit,
  };
  const account = { id: 'account01', settings: { browserAutoSubmit: true }, credentials: {} };
  const service = (values: Record<string, unknown> = {}) => new BrowserAutomationService({ get: (key: string, fallback: unknown) =>
    Object.hasOwn(values, key) ? values[key]
      : ['BROWSER_AUTH_RECOVERY_ENABLED', 'BROWSER_AUTOMATION_ENABLED'].includes(key) ? true : fallback } as unknown as ConfigService,
    { load: jest.fn().mockResolvedValue({ cookies: [], origins: [] }), save } as unknown as BrowserSessionStateStore,
    { detect: jest.fn() } as unknown as BrowserChallengeDetector,
    { acquireLock: jest.fn().mockResolvedValue('lease'), extendLock: verify, releaseLock } as unknown as RedisService,
    { startProxy: jest.fn().mockResolvedValue({ server: 'http://guard', chromiumArgs: [], close: proxyClose }),
      install: jest.fn().mockResolvedValue(undefined) } as unknown as BrowserNetworkGuard,
    { withPreparedImages: (_recipe: unknown, _post: unknown, action: (files: readonly never[]) => Promise<unknown>) => action([]) } as unknown as BrowserMediaPreparationService,
    { inspect: jest.fn().mockResolvedValue({ authorized: true }) } as unknown as BrowserSubmissionAuthorizationService);

  beforeEach(() => {
    jest.spyOn(SessionManager.prototype, 'open').mockResolvedValue(page);
    jest.spyOn(SessionManager.prototype, 'getPage').mockReturnValue(page);
    jest.spyOn(SessionManager.prototype, 'getContext').mockReturnValue(context);
    jest.spyOn(SessionManager.prototype, 'close').mockResolvedValue(undefined);
    ensureAuth = jest.spyOn(AuthManager.prototype, 'ensureAuthenticated').mockResolvedValue({ authenticated: true, state: AuthState.AUTHENTICATED, runtimeState: AccountRuntimeState.READY });
    jest.spyOn(AuthDetector.prototype, 'detectAuthState').mockResolvedValue({ state: AuthState.AUTHENTICATED });
  });
  afterEach(() => { jest.restoreAllMocks(); jest.clearAllMocks(); jest.useRealTimers(); });

  it('wires only the enabled account UUID to its owner-configured TOTP provider', async () => {
    jest.useFakeTimers().setSystemTime(40_000);
    const configured = { ...account, id: '12345678-1234-1234-1234-123456789abc',
      settings: { ...account.settings, browserAutoTotp: true } };
    await service({
      // Public RFC 6238 test vector, not a real credential.
      BROWSER_TOTP_SECRET_12345678_1234_1234_1234_123456789ABC: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',
    }).inspect(configured, recipe);
    const provider = ensureAuth.mock.calls[0]?.[0].otpProvider;
    expect(provider).toBeDefined();
    await expect(provider!(new AbortController().signal)).resolves.toMatch(/^\d{6}$/);
  });

  it('authenticates before preparing/submitting, saves the encrypted session and closes resources', async () => {
    await expect(service().publish(account, { body: 'test', idempotencyKey: 'job' }, recipe)).resolves.toMatchObject({ status: 'PUBLISHED' });
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(submit).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalled();
    expect(releaseLock).toHaveBeenCalled();
    expect(proxyClose).toHaveBeenCalled();
    expect(traceStart).not.toHaveBeenCalled();
  });
  it('returns screenshot metadata on timeout without preparing or submitting', async () => {
    jest.spyOn(AuthManager.prototype, 'ensureAuthenticated').mockResolvedValue({ authenticated: false,
      state: AuthState.CAPTCHA_REQUIRED, runtimeState: AccountRuntimeState.FAILED, reason: 'TIMEOUT', screenshot: '/fixture/masked.png' });
    await expect(service().publish(account, { body: 'test', idempotencyKey: 'job' }, recipe)).resolves.toMatchObject({
      status: 'NEEDS_ACTION', reason: 'CAPTCHA_REQUIRED', authRecovery: { reason: 'TIMEOUT', screenshot: '/fixture/masked.png' },
    });
    expect(prepare).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  it('reports login failure if the encrypted session cannot be saved', async () => {
    save.mockRejectedValueOnce(new Error('store unavailable'));
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    await expect(service().login(account, recipe)).resolves.toMatchObject({ ready: false });
    expect(warn).toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
  });

  it('does not save a session after the final authorization says it was revoked', async () => {
    const denied = service();
    const authorization = denied as unknown as { submitAuthorization: BrowserSubmissionAuthorizationService };
    jest.spyOn(authorization.submitAuthorization, 'inspect').mockResolvedValue({ authorized: false,
      reason: 'LOGIN_REQUIRED', message: 'Session revoked', reconnectRequired: true });
    await expect(denied.publish(account, { body: 'test', idempotencyKey: 'job' }, recipe)).resolves.toMatchObject({ reason: 'LOGIN_REQUIRED' });
    expect(save).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
  });
  it('recovers an email challenge after draft preparation and prepares the draft again', async () => {
    jest.spyOn(AuthDetector.prototype, 'detectAuthState').mockResolvedValueOnce({ state: AuthState.AUTHENTICATED })
      .mockResolvedValueOnce({ state: AuthState.EMAIL_VERIFICATION_REQUIRED }).mockResolvedValue({ state: AuthState.AUTHENTICATED });
    await expect(service().publish(account, { body: 'test', idempotencyKey: 'job' }, recipe)).resolves.toMatchObject({ status: 'PUBLISHED' });
    expect(ensureAuth).toHaveBeenCalledTimes(2);
    expect(prepare).toHaveBeenCalledTimes(2);
    expect(submit).toHaveBeenCalledTimes(1);
  });
  it('keeps an uncertain submit without attempting recovery or resubmission', async () => {
    const failed = { ...recipe, submit: jest.fn().mockRejectedValue(new Error('response lost')) };
    jest.spyOn(AuthDetector.prototype, 'detectAuthState').mockResolvedValueOnce({ state: AuthState.AUTHENTICATED })
      .mockResolvedValueOnce({ state: AuthState.AUTHENTICATED }).mockResolvedValue({ state: AuthState.TWO_FACTOR_REQUIRED });
    await expect(service().publish(account, { body: 'test', idempotencyKey: 'job' }, failed)).resolves.toMatchObject({
      reason: 'SUBMISSION_UNCERTAIN', submissionUncertain: true, challengeKind: 'TWO_FACTOR_REQUIRED',
    });
    expect(ensureAuth).toHaveBeenCalledTimes(1);
    expect(failed.submit).toHaveBeenCalledTimes(1);
  });
  it('does not print raw Playwright error messages containing secrets', async () => {
    jest.spyOn(SessionManager.prototype, 'open').mockRejectedValue(new Error('password=secret-password otp=654321 token=secret-token'));
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    await expect(service().publish(account, { body: 'test', idempotencyKey: 'job' }, recipe)).resolves.toMatchObject({ status: 'NEEDS_ACTION' });
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/secret-password|654321|secret-token/);
  });
});
