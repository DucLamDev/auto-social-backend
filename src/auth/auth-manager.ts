import { mkdir, chmod, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Page } from 'playwright';
import { AuthDetector } from './auth-detector';
import { AccountRuntimeState, AuthState, type AuthDetection, type AuthIdentity,
  type AuthRecoveryResult, type PlatformAuthAdapter } from './auth.types';
import { ManualInterventionError, readHiddenOtp, waitForManualIntervention } from './manual-intervention';
import type { OtpProvider } from './totp-provider';

export interface EnsureAuthenticatedOptions extends AuthIdentity {
  adapter: PlatformAuthAdapter;
  getPage: () => Page;
  makeVisible: () => Promise<void>;
  verifyOwnership: () => Promise<boolean>;
  interactive: boolean;
  skipAuthBlocked?: boolean;
  signal?: AbortSignal;
  timeout?: number;
  captchaTimeout?: number;
  maxAttempts?: number;
  screenshotDir?: string;
  /** Explicitly configured owner-provided TOTP; never used for CAPTCHA/email/device challenges. */
  otpProvider?: OtpProvider;
}

type AuthEvent = AuthIdentity & { timestamp: string; authState: AuthState; action: string; result: string };

export class AuthManager {
  readonly accounts = new Map<string, AccountRuntimeState>();

  constructor(
    private readonly detector = new AuthDetector(),
    private readonly notify: (message: string) => void = (message) => console.log(message),
    private readonly log: (event: AuthEvent) => void = (event) => console.log(JSON.stringify(event)),
    private readonly readOtp = readHiddenOtp,
  ) {}

  async ensureAuthenticated(options: EnsureAuthenticatedOptions): Promise<AuthRecoveryResult> {
    const key = `${options.platform}/${options.account}`;
    let detection: AuthDetection = { state: AuthState.UNKNOWN_AUTH_CHALLENGE };
    let attempts = 0;
    let loginStarted = false;
    let visible = false;
    let lastEvent: AuthState | undefined;
    const timeout = options.timeout ?? 300_000;
    const captchaTimeout = options.captchaTimeout ?? 300_000;
    const maxAttempts = Math.max(1, Math.min(options.maxAttempts ?? 3, 3));
    const abort = new AbortController();
    const cancel = () => abort.abort();
    options.signal?.addEventListener('abort', cancel, { once: true });
    if (options.signal?.aborted) abort.abort();
    // Bound the entire recovery, including changing challenge types and OTP input.
    const deadline = Date.now() + Math.max(timeout, captchaTimeout);
    const timer = setTimeout(cancel, Math.max(timeout, captchaTimeout));
    const update = () => {
      const state = detection.state;
      this.accounts.set(key, state === AuthState.AUTHENTICATED ? AccountRuntimeState.READY
        : state === AuthState.CAPTCHA_REQUIRED ? AccountRuntimeState.WAITING_CAPTCHA
        : state === AuthState.TWO_FACTOR_REQUIRED ? AccountRuntimeState.WAITING_2FA
        : state === AuthState.SESSION_EXPIRED ? AccountRuntimeState.SESSION_EXPIRED : AccountRuntimeState.AUTH_REQUIRED);
      if (state !== lastEvent) {
        this.log({ timestamp: new Date().toISOString(), platform: options.platform, account: options.account,
          authState: state, action: 'AUTH_DETECTED', result: state });
        lastEvent = state;
      }
    };
    const detect = async () => {
      if (abort.signal.aborted) throw new ManualInterventionError(Date.now() >= deadline ? 'TIMEOUT' : 'CANCELLED');
      if (!await options.verifyOwnership()) throw new ManualInterventionError('CANCELLED');
      detection = await this.detector.detectAuthState(options.getPage(), options.adapter);
      update();
      if (detection.failure) throw new Error(detection.failure);
    };
    const fail = async (reason: NonNullable<AuthRecoveryResult['reason']>): Promise<AuthRecoveryResult> => {
      const runtimeState = reason === 'LOCKED' ? AccountRuntimeState.LOCKED
        : ['SKIPPED', 'NON_INTERACTIVE'].includes(reason) ? AccountRuntimeState.AUTH_REQUIRED : AccountRuntimeState.FAILED;
      this.accounts.set(key, runtimeState);
      const screenshot = await this.captureFailure(options, detection.state);
      this.log({ timestamp: new Date().toISOString(), platform: options.platform, account: options.account,
        authState: detection.state, action: 'AUTH_PAUSED', result: reason });
      return { authenticated: false, state: detection.state, runtimeState, reason, screenshot };
    };
    try {
      await detect();
      while (true) {
        if (detection.state === AuthState.AUTHENTICATED) {
          this.notify(`[${key}] ✓ Session authenticated → Tiếp tục công việc.`);
          return { authenticated: true, state: detection.state, runtimeState: AccountRuntimeState.READY };
        }
        if (options.skipAuthBlocked) return await fail('SKIPPED');
        const automaticOtp = detection.state === AuthState.TWO_FACTOR_REQUIRED && options.otpProvider
          && options.adapter.selectors.otpInput && options.adapter.selectors.otpSubmit;
        if (!automaticOtp && !options.interactive) return await fail('NON_INTERACTIVE');
        if (!automaticOtp && !visible) {
          await options.makeVisible();
          visible = true;
          await detect();
          continue;
        }
        if (detection.state === AuthState.UNKNOWN_AUTH_CHALLENGE) return await fail('UNKNOWN');
        const state = detection.state;
        const remaining = Math.min(state === AuthState.CAPTCHA_REQUIRED ? captchaTimeout : timeout, deadline - Date.now());
        if (remaining <= 0) return await fail('TIMEOUT');
        if ((state === AuthState.LOGIN_REQUIRED || state === AuthState.SESSION_EXPIRED) && !loginStarted) {
          loginStarted = true;
          if (options.adapter.login) await options.adapter.login(options.getPage(), abort.signal);
        }
        if (automaticOtp) {
          if (attempts > 0) return await fail('REJECTED');
          const page = options.getPage();
          const input = page.locator(options.adapter.selectors.otpInput!);
          const submit = page.locator(options.adapter.selectors.otpSubmit!);
          if (await input.count() !== 1 || await submit.count() !== 1
            || !await input.isVisible() || !await submit.isVisible()) return await fail('UNKNOWN');
          let code: string | undefined;
          try {
            code = await options.otpProvider!(abort.signal);
            if (!/^\d{6}(?:\d{2})?$/.test(code)) return await fail('FAILED');
            await detect();
            if (detection.state !== AuthState.TWO_FACTOR_REQUIRED) continue;
            attempts++;
            await input.fill(code, { timeout: Math.min(10_000, remaining) });
            code = undefined;
            if (abort.signal.aborted || !await options.verifyOwnership()) throw new ManualInterventionError('CANCELLED');
            await submit.click({ timeout: Math.min(10_000, remaining) });
          } finally {
            code = undefined;
            await input.fill('', { timeout: 1000 }).catch(() => undefined);
          }
          await waitForManualIntervention({ ...options, type: state, timeout: Math.max(1, deadline - Date.now()),
            signal: abort.signal, notify: () => this.notify(`[${key}] TOTP đã submit; đang kiểm tra xác thực...`),
            check: async () => { await detect(); return detection.state !== state; },
          });
          continue;
        }
        if (state === AuthState.TWO_FACTOR_REQUIRED && options.adapter.selectors.otpInput && options.adapter.selectors.otpSubmit) {
          if (attempts >= maxAttempts) return await fail('REJECTED');
          this.notify(`[${key}] 🔐 TWO_FACTOR_REQUIRED; trình duyệt đang mở. Timeout: ${remaining}ms.`);
          const promptAbort = new AbortController();
          const stopPrompt = () => promptAbort.abort();
          abort.signal.addEventListener('abort', stopPrompt, { once: true });
          const otp = this.readOtp(promptAbort.signal, remaining);
          const transitioned = waitForManualIntervention({ ...options, type: state, timeout: remaining,
            signal: promptAbort.signal, notify: () => undefined,
            check: async () => { await detect(); return detection.state !== state; },
          }).then(() => ({ changed: true as const }));
          let code: string | undefined;
          try {
            const entered = await Promise.race([otp.then((value) => ({ code: value })), transitioned]);
            stopPrompt();
            await Promise.allSettled([otp, transitioned]);
            if ('changed' in entered) continue;
            code = entered.code;
            entered.code = '';
            await detect();
            if (detection.state !== AuthState.TWO_FACTOR_REQUIRED) continue;
            const page = options.getPage();
            const input = page.locator(options.adapter.selectors.otpInput);
            const submit = page.locator(options.adapter.selectors.otpSubmit);
            // Never guess a generic submit button, auto-submit an email code, or select an ambiguous input.
            if (await input.count() !== 1 || await submit.count() !== 1
              || !await input.isVisible() || !await submit.isVisible()) return await fail('UNKNOWN');
            attempts++;
            try {
              await input.fill(code, { timeout: Math.min(10_000, remaining) });
              if (abort.signal.aborted || !await options.verifyOwnership()) throw new ManualInterventionError('CANCELLED');
              await submit.click({ timeout: Math.min(10_000, remaining) });
            } finally {
              code = undefined;
              await input.fill('', { timeout: 1000 }).catch(() => undefined);
            }
          } finally {
            code = undefined;
            stopPrompt();
            abort.signal.removeEventListener('abort', stopPrompt);
            await Promise.allSettled([otp, transitioned]);
          }
        }
        await waitForManualIntervention({ ...options, type: state, timeout: remaining, signal: abort.signal,
          notify: this.notify, check: async () => { await detect(); return detection.state !== state; },
        });
      }
    } catch (error) {
      const reason = detection.failure ?? (abort.signal.aborted
        ? Date.now() >= deadline ? 'TIMEOUT' : 'CANCELLED' : error instanceof ManualInterventionError
        ? Date.now() >= deadline ? 'TIMEOUT' : error.reason : 'FAILED');
      return await fail(reason);
    } finally {
      clearTimeout(timer);
      abort.abort();
      options.signal?.removeEventListener('abort', cancel);
    }
  }

  private async captureFailure(options: EnsureAuthenticatedOptions, state: AuthState): Promise<string | undefined> {
    try {
      const page = options.getPage();
      if (page.isClosed()) return undefined;
      const url = new URL(page.url());
      // Never capture Authenticator extension pages, settings, or unrelated origins.
      if (url.protocol !== 'https:' || !options.adapter.allowedHosts.includes(url.hostname)) return undefined;
      // Do not save HTML, HAR or traces: those can contain cookies, passwords or OTP requests.
      const bytes = await page.screenshot({ type: 'png', fullPage: true, timeout: 5000,
        mask: [page.locator('input, textarea, [contenteditable], iframe, [role="alert"], pre, code'),
          ...(options.adapter.selectors.sensitive ?? []).map((selector) => page.locator(selector))],
      });
      const root = resolve(options.screenshotDir ?? 'logs/screenshots');
      const directory = join(root, new Date().toISOString().slice(0, 10));
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await chmod(root, 0o700);
      await chmod(directory, 0o700);
      const safe = (value: string) => value.replace(/[^a-z0-9_-]/gi, '_').slice(0, 80);
      const file = join(directory, `${safe(options.platform)}-${safe(options.account)}-${state.toLowerCase()}-${randomUUID()}.png`);
      await writeFile(file, bytes, { mode: 0o600, flag: 'wx' });
      return file;
    } catch { return undefined; }
  }
}
