import type { Page } from 'playwright';
import { AuthState, type AuthDetection, type PlatformAuthAdapter } from './auth.types';
import { anyVisible, CaptchaDetector } from './captcha-detector';
import { TwoFactorDetector } from './two-factor-detector';

/** Only authentication surfaces are read; arbitrary post bodies are not scanned. */
export class AuthDetector {
  constructor(
    private readonly captcha = new CaptchaDetector(),
    private readonly twoFactor = new TwoFactorDetector(),
  ) {}

  async detectAuthState(page: Page, adapter: PlatformAuthAdapter): Promise<AuthDetection> {
    if (page.isClosed()) return { state: AuthState.UNKNOWN_AUTH_CHALLENGE };
    const url = new URL(page.url());
    if (url.protocol !== 'https:' || !adapter.allowedHosts.includes(url.hostname)) {
      return { state: AuthState.UNKNOWN_AUTH_CHALLENGE };
    }
    const path = url.pathname;
    const selectors = adapter.selectors;
    const surfaces = page.locator('h1:visible, h2:visible, [role="alert"]:visible, '
      + 'form:visible:has(input[type="password"]), form:visible:has(input[autocomplete="one-time-code"]), '
      + 'form[action*="challenge" i]:visible, form[action*="verify" i]:visible');
    const heading = [await page.title(), ...(await surfaces.allInnerTexts())].join('\n').slice(0, 16_000);
    if (await anyVisible(page, selectors.locked)
      || /account (?:is |has been )?(?:locked|suspended|disabled)/i.test(heading)) {
      return { state: AuthState.UNKNOWN_AUTH_CHALLENGE, failure: 'LOCKED' };
    }
    if (await anyVisible(page, selectors.rejected)
      || /(?:incorrect|invalid|wrong) (?:password|(?:verification |authentication |security )?code|otp)|captcha (?:failed|incorrect)|password (?:is )?incorrect/i.test(heading)) {
      return { state: AuthState.UNKNOWN_AUTH_CHALLENGE, failure: 'REJECTED' };
    }
    if (await this.captcha.detect(page, path, heading, selectors.captcha)) return { state: AuthState.CAPTCHA_REQUIRED };
    // Email/device challenges can also have one-time-code inputs: prefer their explicit context.
    if (await anyVisible(page, selectors.emailVerification)
      || /verify[-_/]?email|email[-_/]?verification/i.test(path)
      || /verify (?:your )?email|check your (?:email|inbox)|code (?:sent|emailed) to (?:your )?email/i.test(heading)) {
      return { state: AuthState.EMAIL_VERIFICATION_REQUIRED };
    }
    if (await anyVisible(page, selectors.deviceConfirmation)
      || /confirm[-_/]?device|device[-_/]?confirmation/i.test(path)
      || /confirm (?:this |your )?device|approve (?:the |this )?(?:sign[- ]in|login)|check your (?:phone|other device)/i.test(heading)) {
      return { state: AuthState.DEVICE_CONFIRMATION_REQUIRED };
    }
    if (await this.twoFactor.detect(page, path, heading, selectors.otpInput)) return { state: AuthState.TWO_FACTOR_REQUIRED };
    if (await anyVisible(page, selectors.sessionExpired) || /session (?:has )?expired|login expired/i.test(heading)) {
      return { state: AuthState.SESSION_EXPIRED };
    }
    if (await anyVisible(page, [...(selectors.loginForm ?? []), 'input[type="password"]'])
      || /\/(login|log-in|signin|sign-in)(\/|$)/i.test(path)) return { state: AuthState.LOGIN_REQUIRED };
    if (/\/(challenge|checkpoint|security-check|verify-identity)(\/|$)/i.test(path)
      || /security check|verify (?:your )?identity|login verification/i.test(heading)) {
      return { state: AuthState.UNKNOWN_AUTH_CHALLENGE };
    }
    if (await anyVisible(page, selectors.loggedIn)
      || await adapter.isAuthenticated?.(page)) return { state: AuthState.AUTHENTICATED };
    // Disappearance of a challenge or a URL change is never proof of login.
    return { state: AuthState.UNKNOWN_AUTH_CHALLENGE };
  }
}
