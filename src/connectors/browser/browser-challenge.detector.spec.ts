import type { Page } from 'playwright';
import { BrowserChallengeDetector } from './browser-challenge.detector';

function fakePage(input: {
  url?: string;
  visibleSelectors?: string[];
  pageText?: string;
  visibleSurfaceText?: Record<string, string>;
}): Page {
  const visibleSelectors = new Set(input.visibleSelectors ?? []);
  const locator = (selector: string, textPattern?: RegExp) => ({
    filter: ({ hasText }: { hasText: RegExp }) => locator(selector, hasText),
    first: () => ({
      isVisible: jest.fn().mockResolvedValue(
        visibleSelectors.has(selector)
        || Boolean(
          textPattern
          && input.visibleSurfaceText?.[selector]
          && new RegExp(textPattern.source, textPattern.flags)
            .test(input.visibleSurfaceText[selector]),
        ),
      ),
    }),
  });
  return {
    url: () => input.url ?? 'https://example.com/editor',
    locator,
    getByText: jest.fn(() => ({
      first: () => ({ isVisible: jest.fn().mockResolvedValue(Boolean(input.pageText)) }),
    })),
  } as unknown as Page;
}

describe('BrowserChallengeDetector', () => {
  const detector = new BrowserChallengeDetector();

  it('pauses for CAPTCHA before trying any login automation', async () => {
    const page = fakePage({ visibleSelectors: ['iframe[src*="recaptcha" i]'] });
    await expect(detector.detect(page)).resolves.toMatchObject({ kind: 'CAPTCHA_REQUIRED' });
  });

  it('pauses for a visible Cloudflare Turnstile widget', async () => {
    const page = fakePage({ visibleSelectors: ['.cf-turnstile'] });
    await expect(detector.detect(page)).resolves.toMatchObject({ kind: 'CAPTCHA_REQUIRED' });
  });

  it('pauses for one-time-code input', async () => {
    const page = fakePage({ visibleSelectors: ['input[autocomplete="one-time-code"]'] });
    await expect(detector.detect(page)).resolves.toMatchObject({ kind: 'TWO_FACTOR_REQUIRED' });
  });

  it('recognizes a signed-out URL without exposing page contents', async () => {
    const page = fakePage({ url: 'https://example.com/signin' });
    await expect(detector.detect(page)).resolves.toMatchObject({ kind: 'LOGIN_REQUIRED' });
  });

  it('recognizes challenge text inside a known challenge surface', async () => {
    const page = fakePage({
      visibleSurfaceText: {
        '#challenge-form': 'Verify that you are human',
      },
    });
    await expect(detector.detect(page)).resolves.toMatchObject({ kind: 'CAPTCHA_REQUIRED' });
  });

  it('does not scan draft or editor text for challenge keywords', async () => {
    const page = fakePage({
      pageText: 'How CAPTCHA works, where to find your security code, and how to pass a security check',
    });

    await expect(detector.detect(page)).resolves.toBeUndefined();
  });

  it('does not treat text inside an editor as two-factor UI', async () => {
    const page = fakePage({
      visibleSelectors: ['[contenteditable="true"]'],
      visibleSurfaceText: {
        '[contenteditable="true"]': 'Enter your verification code and authentication code',
      },
    });

    await expect(detector.detect(page)).resolves.toBeUndefined();
  });

  it('returns no challenge for an authenticated editor', async () => {
    await expect(detector.detect(fakePage({}))).resolves.toBeUndefined();
  });
});
