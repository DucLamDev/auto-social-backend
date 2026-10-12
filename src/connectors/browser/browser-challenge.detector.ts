import { Injectable } from '@nestjs/common';
import type { Locator, Page } from 'playwright';
import { BrowserChallenge } from './browser-automation.types';

const CAPTCHA_SELECTORS = [
  'iframe[src*="recaptcha" i]',
  'iframe[src*="hcaptcha" i]',
  'iframe[src*="turnstile" i]',
  'iframe[src*="challenges.cloudflare.com" i]',
  '[data-sitekey]',
  '.cf-turnstile',
  '.cf-chl-widget',
] as const;

const CAPTCHA_TEXT_SURFACES = [
  '#challenge-form',
  '#cf-challenge-running',
  '#cf-challenge-body-text',
  'form[action*="captcha" i]',
  'form[action*="challenge" i]',
  '[data-testid*="captcha" i]',
  '[data-testid*="human-verification" i]',
] as const;

const TWO_FACTOR_SELECTORS = [
  'input[autocomplete="one-time-code"]',
  'input[name*="otp" i]',
  'input[name*="totp" i]',
] as const;

const TWO_FACTOR_TEXT_SURFACES = [
  'form[action*="2fa" i]',
  'form[action*="two-factor" i]',
  'form[action*="mfa" i]',
  'form[action*="otp" i]',
  '[data-testid*="two-factor" i]',
  '[data-testid*="two_factor" i]',
  '[data-testid*="2fa" i]',
] as const;

const SECURITY_CHECK_TEXT_SURFACES = [
  'form[action*="security-check" i]',
  'form[action*="verify-identity" i]',
  '[data-testid*="security-check" i]',
  '[data-testid*="account-challenge" i]',
] as const;

const LOGIN_SELECTORS = [
  'input[type="password"]',
  'form[action*="login" i]',
  'form[action*="signin" i]',
] as const;

@Injectable()
export class BrowserChallengeDetector {
  async detect(page: Page): Promise<BrowserChallenge | undefined> {
    const path = this.urlPath(page.url());
    if (await this.anyVisible(page, CAPTCHA_SELECTORS)
      || /\/(captcha|recaptcha|hcaptcha|turnstile)(\/|$)/i.test(path)
      || await this.visibleSurfaceText(
        page,
        CAPTCHA_TEXT_SURFACES,
        /captcha|turnstile|just a moment|performing security verification|verify (that )?you are human|checking your browser/i,
      )) {
      return {
        kind: 'CAPTCHA_REQUIRED',
        message: 'CAPTCHA or human verification requires the account owner',
      };
    }
    if (await this.anyVisible(page, TWO_FACTOR_SELECTORS)
      || /\/(2fa|mfa|two-factor|two_factor|otp)(\/|$)/i.test(path)
      || await this.visibleSurfaceText(
        page,
        TWO_FACTOR_TEXT_SURFACES,
        /two[- ]factor|verification code|authentication code|security code/i,
      )) {
      return {
        kind: 'TWO_FACTOR_REQUIRED',
        message: 'Two-factor authentication requires the account owner',
      };
    }
    if (/\/(security-check|account-challenge|verify-identity)(\/|$)/i.test(path)
      || await this.visibleSurfaceText(
        page,
        SECURITY_CHECK_TEXT_SURFACES,
        /unusual activity|security check|confirm (that )?it'?s you/i,
      )) {
      return {
        kind: 'SECURITY_CHECK_REQUIRED',
        message: 'The platform requested an account security check',
      };
    }
    if (await this.anyVisible(page, LOGIN_SELECTORS)
      || /\/(login|log-in|signin|sign-in|auth)(\/|$)/i.test(path)) {
      return {
        kind: 'LOGIN_REQUIRED',
        message: 'The saved browser session is signed out or expired',
      };
    }
    return undefined;
  }

  private async anyVisible(page: Page, selectors: readonly string[]): Promise<boolean> {
    for (const selector of selectors) {
      if (await this.isVisible(page.locator(selector).first())) return true;
    }
    return false;
  }

  private async visibleSurfaceText(
    page: Page,
    selectors: readonly string[],
    pattern: RegExp,
  ): Promise<boolean> {
    for (const selector of selectors) {
      const surface = page.locator(selector).filter({ hasText: pattern }).first();
      if (await this.isVisible(surface)) return true;
    }
    return false;
  }

  private async isVisible(locator: Locator): Promise<boolean> {
    return locator.isVisible({ timeout: 250 }).catch(() => false);
  }

  private urlPath(value: string): string {
    try {
      return new URL(value).pathname;
    } catch {
      return '';
    }
  }
}
