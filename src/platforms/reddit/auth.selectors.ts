import type { PlatformAuthAdapter } from '../../auth/auth.types';

export const redditAuthSelectors = {
  loggedIn: ['[data-testid="user-drawer-button"]'],
  loginForm: ['input[name="password"]'],
} satisfies PlatformAuthAdapter['selectors'];
