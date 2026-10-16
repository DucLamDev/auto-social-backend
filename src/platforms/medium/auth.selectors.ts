import type { PlatformAuthAdapter } from '../../auth/auth.types';

export const mediumAuthSelectors = {
  loggedIn: ['a[href="/me/stories"]'],
  emailVerification: ['input[name="emailCode"]'],
} satisfies PlatformAuthAdapter['selectors'];
