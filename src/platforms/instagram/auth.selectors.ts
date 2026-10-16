import type { PlatformAuthAdapter } from '../../auth/auth.types';

/** Candidate auth selectors only; this does not register a publishing recipe. */
export const instagramAuthSelectors = {
  loggedIn: ['a[href="/direct/inbox/"]'],
  loginForm: ['input[name="username"]'],
  captcha: ['iframe[src*="recaptcha"]'],
  otpInput: 'input[name="verificationCode"]',
  otpSubmit: 'form:has(input[name="verificationCode"]) button[type="submit"]',
} satisfies PlatformAuthAdapter['selectors'];
