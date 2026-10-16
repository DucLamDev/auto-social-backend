import type { PlatformAuthAdapter } from '../../auth/auth.types';

export const threadsAuthSelectors = {
  loggedIn: ['a[href="/activity"]'],
  loginForm: ['input[autocomplete="current-password"]'],
  // Unreviewed OTP submit stays manual in the visible browser.
} satisfies PlatformAuthAdapter['selectors'];
