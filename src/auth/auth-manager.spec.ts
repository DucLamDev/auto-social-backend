import type { Page } from 'playwright';
import { AuthManager, type EnsureAuthenticatedOptions } from './auth-manager';
import { AuthDetector } from './auth-detector';
import { AccountRuntimeState, AuthState, type AuthDetection } from './auth.types';
import { ManualInterventionError } from './manual-intervention';

function setup(states: AuthDetection[], overrides: Partial<EnsureAuthenticatedOptions> = {}) {
  let last = states[0]!;
  const detectAuthState = jest.fn().mockImplementation(() => { last = states.shift() ?? last; return Promise.resolve(last); });
  const fill = jest.fn().mockResolvedValue(undefined);
  const click = jest.fn().mockResolvedValue(undefined);
  const locator = jest.fn().mockReturnValue({ count: () => Promise.resolve(1), isVisible: () => Promise.resolve(true), fill, click });
  const page = { locator, isClosed: () => false } as unknown as Page;
  const log = jest.fn();
  const notify = jest.fn();
  const readOtp = jest.fn().mockResolvedValue('654321');
  const manager = new AuthManager({ detectAuthState } as unknown as AuthDetector, notify, log, readOtp);
  const options: EnsureAuthenticatedOptions = {
    platform: 'linkedin', account: 'account01', adapter: {
      allowedHosts: ['example.com'], selectors: { otpInput: '#otp', otpSubmit: '#verify' },
    }, getPage: () => page, makeVisible: jest.fn().mockResolvedValue(undefined),
    verifyOwnership: jest.fn().mockResolvedValue(true), interactive: true, timeout: 10_000,
    captchaTimeout: 10_000, ...overrides,
  };
  return { manager, options, detectAuthState, fill, click, log, notify, readOtp };
}
const state = (state: AuthState): AuthDetection => ({ state });

describe('AuthManager recovery', () => {
  afterEach(() => jest.useRealTimers());
  it('submits owner-provided TOTP without a terminal or visible browser and verifies auth', async () => {
    const otpProvider = jest.fn().mockResolvedValue('287082');
    const { manager, options, fill, click, readOtp, log, notify } = setup([
      state(AuthState.TWO_FACTOR_REQUIRED), state(AuthState.TWO_FACTOR_REQUIRED), state(AuthState.AUTHENTICATED),
    ], { interactive: false, otpProvider });
    await expect(manager.ensureAuthenticated(options)).resolves.toMatchObject({ authenticated: true });
    expect(fill).toHaveBeenCalledWith('287082', expect.any(Object));
    expect(fill).toHaveBeenCalledWith('', expect.any(Object));
    expect(click).toHaveBeenCalledTimes(1);
    expect(options.makeVisible).not.toHaveBeenCalled();
    expect(readOtp).not.toHaveBeenCalled();
    expect(otpProvider).toHaveBeenCalledTimes(1);
    expect(JSON.stringify([log.mock.calls, notify.mock.calls])).not.toContain('287082');
  });
  it.each([AuthState.CAPTCHA_REQUIRED, AuthState.EMAIL_VERIFICATION_REQUIRED, AuthState.DEVICE_CONFIRMATION_REQUIRED, AuthState.LOGIN_REQUIRED])('never uses TOTP for %s', async (challenge) => {
    const otpProvider = jest.fn().mockResolvedValue('287082');
    const { manager, options, fill } = setup([state(challenge)], { interactive: false, otpProvider });
    await expect(manager.ensureAuthenticated(options)).resolves.toMatchObject({ reason: 'NON_INTERACTIVE' });
    expect(otpProvider).not.toHaveBeenCalled();
    expect(fill).not.toHaveBeenCalled();
  });
  it('does not generate another TOTP after rejection', async () => {
    const otpProvider = jest.fn().mockResolvedValue('287082');
    const { manager, options, click } = setup([
      state(AuthState.TWO_FACTOR_REQUIRED), state(AuthState.TWO_FACTOR_REQUIRED),
      { state: AuthState.UNKNOWN_AUTH_CHALLENGE, failure: 'REJECTED' },
    ], { interactive: false, otpProvider });
    await expect(manager.ensureAuthenticated(options)).resolves.toMatchObject({ reason: 'REJECTED' });
    expect(otpProvider).toHaveBeenCalledTimes(1);
    expect(click).toHaveBeenCalledTimes(1);
  });
  it('stops before submit when the lease is lost while using TOTP', async () => {
    const verifyOwnership = jest.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(true).mockResolvedValue(false);
    const { manager, options, fill, click } = setup([state(AuthState.TWO_FACTOR_REQUIRED)], {
      interactive: false, otpProvider: () => Promise.resolve('287082'), verifyOwnership,
    });
    await expect(manager.ensureAuthenticated(options)).resolves.toMatchObject({ reason: 'CANCELLED' });
    expect(click).not.toHaveBeenCalled();
    expect(fill).toHaveBeenCalledWith('', expect.any(Object));
  });
  it('resumes when CAPTCHA is completed and authenticated evidence appears', async () => {
    const { manager, options, readOtp } = setup([
      state(AuthState.CAPTCHA_REQUIRED), state(AuthState.CAPTCHA_REQUIRED), state(AuthState.AUTHENTICATED),
    ]);
    await expect(manager.ensureAuthenticated(options)).resolves.toMatchObject({ authenticated: true, runtimeState: AccountRuntimeState.READY });
    expect(readOtp).not.toHaveBeenCalled();
  });
  it('handles successive CAPTCHA → OTP → authenticated without restarting', async () => {
    const { manager, options, fill, click, log, notify } = setup([
      state(AuthState.CAPTCHA_REQUIRED), state(AuthState.CAPTCHA_REQUIRED), state(AuthState.TWO_FACTOR_REQUIRED),
      state(AuthState.TWO_FACTOR_REQUIRED), state(AuthState.TWO_FACTOR_REQUIRED), state(AuthState.AUTHENTICATED),
    ]);
    await expect(manager.ensureAuthenticated(options)).resolves.toMatchObject({ authenticated: true });
    expect(fill).toHaveBeenCalledWith('654321', expect.any(Object));
    expect(fill).toHaveBeenCalledWith('', expect.any(Object));
    expect(click).toHaveBeenCalledTimes(1);
    expect(JSON.stringify([log.mock.calls, notify.mock.calls])).not.toContain('654321');
  });
  it('does not submit OTP when the owner completes verification in the browser', async () => {
    const { manager, options, readOtp, fill } = setup([
      state(AuthState.TWO_FACTOR_REQUIRED), state(AuthState.TWO_FACTOR_REQUIRED), state(AuthState.AUTHENTICATED),
    ]);
    readOtp.mockImplementation((signal: AbortSignal) => new Promise<string>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new ManualInterventionError('CANCELLED')), { once: true });
    }));
    await expect(manager.ensureAuthenticated(options)).resolves.toMatchObject({ authenticated: true });
    expect(fill).not.toHaveBeenCalled();
  });
  it.each([AuthState.EMAIL_VERIFICATION_REQUIRED, AuthState.DEVICE_CONFIRMATION_REQUIRED, AuthState.LOGIN_REQUIRED, AuthState.SESSION_EXPIRED])('supports manual %s', async (challenge) => {
    const { manager, options, readOtp } = setup([state(challenge), state(challenge), state(AuthState.AUTHENTICATED)]);
    await expect(manager.ensureAuthenticated(options)).resolves.toMatchObject({ authenticated: true });
    expect(readOtp).not.toHaveBeenCalled();
  });
  it.each(['LOCKED', 'REJECTED'] as const)('stops on %s without attempts', async (failure) => {
    const { manager, options, readOtp } = setup([{ state: AuthState.UNKNOWN_AUTH_CHALLENGE, failure }]);
    await expect(manager.ensureAuthenticated(options)).resolves.toMatchObject({ authenticated: false, reason: failure });
    expect(readOtp).not.toHaveBeenCalled();
  });
  it('stops after a wrong OTP and does not retry', async () => {
    const { manager, options, click, readOtp } = setup([
      state(AuthState.TWO_FACTOR_REQUIRED), state(AuthState.TWO_FACTOR_REQUIRED), state(AuthState.TWO_FACTOR_REQUIRED),
      state(AuthState.TWO_FACTOR_REQUIRED), { state: AuthState.UNKNOWN_AUTH_CHALLENGE, failure: 'REJECTED' },
    ]);
    await expect(manager.ensureAuthenticated(options)).resolves.toMatchObject({ authenticated: false, reason: 'REJECTED' });
    expect(click).toHaveBeenCalledTimes(1);
    expect(readOtp).toHaveBeenCalledTimes(1);
  });
  it('skips challenges without opening a visible browser or prompting', async () => {
    const { manager, options, readOtp } = setup([state(AuthState.CAPTCHA_REQUIRED)], { skipAuthBlocked: true });
    await expect(manager.ensureAuthenticated(options)).resolves.toMatchObject({ reason: 'SKIPPED', runtimeState: AccountRuntimeState.AUTH_REQUIRED });
    expect(options.makeVisible).not.toHaveBeenCalled();
    expect(readOtp).not.toHaveBeenCalled();
  });
  it('leaves unattended accounts requiring human action', async () => {
    const { manager, options } = setup([state(AuthState.TWO_FACTOR_REQUIRED)], { interactive: false });
    await expect(manager.ensureAuthenticated(options)).resolves.toMatchObject({ reason: 'NON_INTERACTIVE' });
  });

  it('never screenshots an Authenticator extension or a different origin', async () => {
    for (const url of ['chrome-extension://fixture/secret-page', 'https://other.example.com/login']) {
      const screenshot = jest.fn();
      const page = { url: () => url, isClosed: () => false, screenshot } as unknown as Page;
      const { manager, options } = setup([state(AuthState.UNKNOWN_AUTH_CHALLENGE)], {
        interactive: false, getPage: () => page,
      });
      await expect(manager.ensureAuthenticated(options)).resolves.toMatchObject({ authenticated: false });
      expect(screenshot).not.toHaveBeenCalled();
    }
  });
  it('stops if account lease is lost', async () => {
    const { manager, options, readOtp } = setup([state(AuthState.TWO_FACTOR_REQUIRED)], { verifyOwnership: () => Promise.resolve(false) });
    await expect(manager.ensureAuthenticated(options)).resolves.toMatchObject({ reason: 'CANCELLED' });
    expect(readOtp).not.toHaveBeenCalled();
  });
  it('times out with bounded polling and cleans its timer', async () => {
    jest.useFakeTimers();
    const { manager, options, detectAuthState } = setup([state(AuthState.CAPTCHA_REQUIRED)], { timeout: 3500, captchaTimeout: 3500 });
    const result = manager.ensureAuthenticated(options);
    await jest.advanceTimersByTimeAsync(4000);
    await expect(result).resolves.toMatchObject({ reason: 'TIMEOUT' });
    expect(detectAuthState.mock.calls.length).toBeLessThanOrEqual(5);
    expect(jest.getTimerCount()).toBe(0);
  });
});
