import type { Page } from 'playwright';

export async function anyVisible(page: Page, selectors: readonly string[] = []): Promise<boolean> {
  for (const selector of selectors) {
    const matches = page.locator(selector);
    // A hidden first match must not hide a visible challenge later in the DOM.
    const count = Math.min(await matches.count(), 30);
    for (let index = 0; index < count; index++) {
      if (await matches.nth(index).isVisible()) return true;
    }
  }
  return false;
}

export class CaptchaDetector {
  async detect(page: Page, path: string, heading: string, selectors: readonly string[] = []): Promise<boolean> {
    return await anyVisible(page, [...selectors,
      'iframe[src*="recaptcha" i]', 'iframe[src*="hcaptcha" i]',
      'iframe[src*="turnstile" i]',
      'iframe[src*="challenges.cloudflare.com" i]', '.cf-turnstile',
      '#challenge-form', '#cf-challenge-running', '[data-sitekey]',
    ]) || /\/(captcha|recaptcha|hcaptcha|turnstile)(\/|$)|\/cdn-cgi\/challenge/i.test(path)
      || /captcha|verify (that )?you are human|checking your browser|just a moment|performing security verification/i.test(heading);
  }
}
