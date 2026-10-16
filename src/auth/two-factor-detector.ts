import type { Page } from 'playwright';
import { anyVisible } from './captcha-detector';

export class TwoFactorDetector {
  async detect(page: Page, path: string, heading: string, input?: string): Promise<boolean> {
    return await anyVisible(page, [
      ...(input ? [input] : []), 'input[autocomplete="one-time-code"]',
      'input[name*="otp" i]', 'input[name*="totp" i]',
    ]) || /\/(2fa|mfa|two-factor|two_factor|otp)(\/|$)/i.test(path)
      || /two[- ]factor|\b2fa\b|authenticat(?:ion|or) code|verification code|one[- ]time (?:code|password)/i.test(heading);
  }
}
