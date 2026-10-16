import type { Page } from 'playwright';
import { AuthDetector } from './auth-detector';
import { AuthState, type PlatformAuthAdapter } from './auth.types';

export function authPage(input: { path?: string; text?: string; title?: string; visible?: Record<string, boolean[]> } = {}): Page {
  const locator = (selector: string) => ({
    count: jest.fn().mockResolvedValue(input.visible?.[selector]?.length ?? 0),
    nth: (index: number) => ({ isVisible: jest.fn().mockResolvedValue(input.visible?.[selector]?.[index] ?? false) }),
    allInnerTexts: jest.fn().mockResolvedValue([input.text ?? '']),
  });
  return { url: () => `https://example.com${input.path ?? '/editor'}`, title: () => Promise.resolve(input.title ?? ''),
    isClosed: () => false, locator,
  } as unknown as Page;
}

const adapter: PlatformAuthAdapter = { allowedHosts: ['example.com'], selectors: { loggedIn: ['#signed-in'] } };

describe('AuthDetector', () => {
  const detector = new AuthDetector();
  it.each([
    ['/login', '', AuthState.LOGIN_REQUIRED], ['/otp', '', AuthState.TWO_FACTOR_REQUIRED],
    ['/captcha', '', AuthState.CAPTCHA_REQUIRED], ['/editor', 'Just a moment', AuthState.CAPTCHA_REQUIRED],
    ['/verify-email', '', AuthState.EMAIL_VERIFICATION_REQUIRED], ['/editor', 'Check your inbox', AuthState.EMAIL_VERIFICATION_REQUIRED],
    ['/confirm-device', '', AuthState.DEVICE_CONFIRMATION_REQUIRED], ['/editor', 'Approve this sign-in', AuthState.DEVICE_CONFIRMATION_REQUIRED],
    ['/editor', 'Session has expired', AuthState.SESSION_EXPIRED], ['/checkpoint', '', AuthState.UNKNOWN_AUTH_CHALLENGE],
  ])('detects %s / %s as %s', async (path, text, state) => {
    await expect(detector.detectAuthState(authPage({ path, text }), adapter)).resolves.toMatchObject({ state });
  });
  it('requires positive evidence and finds a visible match after a hidden match', async () => {
    await expect(detector.detectAuthState(authPage(), adapter)).resolves.toEqual({ state: AuthState.UNKNOWN_AUTH_CHALLENGE });
    await expect(detector.detectAuthState(authPage({ visible: { '#signed-in': [false, true] } }), adapter))
      .resolves.toEqual({ state: AuthState.AUTHENTICATED });
  });
  it('prefers email verification over a one-time-code field', async () => {
    await expect(detector.detectAuthState(authPage({ text: 'Verify your email', visible: { 'input[autocomplete="one-time-code"]': [true] } }), adapter))
      .resolves.toEqual({ state: AuthState.EMAIL_VERIFICATION_REQUIRED });
  });
  it('detects Cloudflare iframe even when login controls exist', async () => {
    await expect(detector.detectAuthState(authPage({ visible: {
      'iframe[src*="challenges.cloudflare.com" i]': [true], 'input[type="password"]': [true], '#signed-in': [true],
    } }), adapter)).resolves.toEqual({ state: AuthState.CAPTCHA_REQUIRED });
  });
  it.each(['Account is locked', 'Wrong password', 'Invalid verification code', 'CAPTCHA failed'])('fails closed on %s', async (text) => {
    await expect(detector.detectAuthState(authPage({ text }), adapter)).resolves.toMatchObject({ failure: text.includes('locked') ? 'LOCKED' : 'REJECTED' });
  });
  it('does not trust a signed-in selector on a different host', async () => {
    await expect(detector.detectAuthState(authPage({ visible: { '#signed-in': [true] } }), { ...adapter, allowedHosts: ['other.example.com'] }))
      .resolves.toEqual({ state: AuthState.UNKNOWN_AUTH_CHALLENGE });
  });
});
