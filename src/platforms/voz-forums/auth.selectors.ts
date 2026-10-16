import type { PlatformAuthAdapter } from '../../auth/auth.types';

export const vozAuthSelectors = {
  loggedIn: ['a[href*="/logout"]', '.p-navgroup-link--user'],
  loginForm: ['form[action*="/login"]'],
  otpInput: 'form[action*="/two-step"] input[name="code"]',
  otpSubmit: 'form[action*="/two-step"] button[type="submit"]',
  rejected: ['.blockMessage--error', '.errorOverlay'],
} satisfies PlatformAuthAdapter['selectors'];
