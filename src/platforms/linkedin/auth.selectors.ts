import type { PlatformAuthAdapter } from '../../auth/auth.types';

export const linkedinAuthSelectors = {
  loggedIn: ['a[href*="/feed/"]'],
  loginForm: ['#username'],
  otpInput: 'input[name="pin"]',
  otpSubmit: 'form:has(input[name="pin"]) button[type="submit"]',
} satisfies PlatformAuthAdapter['selectors'];
