import { createHash, createHmac, type BinaryLike } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { type BrowserContext, type Locator, type Page } from 'playwright';
import { SessionManager } from '../src/auth/session-manager';
import { AuthDetector } from '../src/auth/auth-detector';
import { AuthState } from '../src/auth/auth.types';
import {
  createPrivateFileSessionStore,
  captureAllowedStorageState,
} from '../src/auth/file-session-store';
import { waitForManualIntervention } from '../src/auth/manual-intervention';
import { assertChromiumInstalled } from '../src/connectors/browser/browser-chromium';
import {
  BrowserNetworkGuard,
  type BrowserNetworkProxy,
} from '../src/connectors/browser/browser-network-guard.service';

interface AuthRecord {
  rowNumber: number;
  sequence: string;
  platform: string;
  loginUrl: string;
  loginMethod: string;
  user: string;
  password: string;
  twoFactor: string;
  profileUrl: string;
}

interface CliOptions {
  authFile?: string;
  platform: string;
  ordinal: number;
  accountRef?: string;
  executeLiveLogin: boolean;
  headless: boolean;
  requireTwoFactor: boolean;
  timeoutMs: number;
  manualLogin: boolean;
  profilesDir: string;
  inspectSession: boolean;
  accountLabel: string;
}

interface SmokeResult {
  phase: 'login-page' | 'authentication' | 'editor';
  status:
    | 'READY'
    | 'CHALLENGE_REQUIRES_HUMAN'
    | 'EDITOR_NOT_FOUND'
    | 'FORM_NOT_FOUND'
    | 'LOGIN_REJECTED'
    | 'ACCOUNT_LOCKED'
    | 'SESSION_NOT_VERIFIED'
    | 'TWO_FACTOR_REJECTED'
    | 'TWO_FACTOR_REQUIRED';
  url: string;
  statusCode?: number;
  authState?: AuthState;
}

/** Missing UI or cookies is not evidence that credentials were rejected. */
export async function inspectUnverifiedLogin(
  page: Page,
  allowedHosts: readonly string[],
  detector = new AuthDetector(),
): Promise<SmokeResult> {
  const detection = await detector.detectAuthState(page, { allowedHosts, selectors: {} });
  const status =
    detection.failure === 'REJECTED'
      ? 'LOGIN_REJECTED'
      : detection.failure === 'LOCKED'
        ? 'ACCOUNT_LOCKED'
        : detection.state === AuthState.TWO_FACTOR_REQUIRED
          ? 'TWO_FACTOR_REQUIRED'
          : [
                AuthState.CAPTCHA_REQUIRED,
                AuthState.EMAIL_VERIFICATION_REQUIRED,
                AuthState.DEVICE_CONFIRMATION_REQUIRED,
              ].includes(detection.state)
            ? 'CHALLENGE_REQUIRES_HUMAN'
            : 'SESSION_NOT_VERIFIED';
  return {
    phase: 'authentication',
    status,
    authState: detection.state,
    url: safePageUrl(page.url()),
  };
}

interface TotpConfiguration {
  secret: string;
  algorithm: 'sha1' | 'sha256' | 'sha512';
  digits: number;
  period: number;
}

class SafeCliError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'SafeCliError';
  }
}

/** Report a fixed code, never Playwright's message containing URLs or filled values. */
export function safeRuntimeErrorCode(error: unknown): string {
  if (error instanceof SafeCliError) return error.code;
  if (!(error instanceof Error)) return 'UNEXPECTED_RUNTIME_ERROR';
  if (error.name === 'TimeoutError') return 'BROWSER_TIMEOUT';
  const networkCode = /net::(ERR_[A-Z_]+)/.exec(error.message)?.[1];
  if (networkCode) return `BROWSER_${networkCode}`;
  if (error.name === 'FileSessionStoreError') return 'SESSION_STORE_UNAVAILABLE';
  if (error.name === 'BrowserRuntimeUnavailableError') return 'CHROMIUM_UNAVAILABLE';
  return 'UNEXPECTED_RUNTIME_ERROR';
}

const DEV_TO_ALIASES = new Set(['dev.to', 'devto']);
const DEV_TO_HOSTS = new Set(['dev.to']);
const INSTAGRAM_ALIASES = new Set(['instagram']);
const INSTAGRAM_HOSTS = new Set(['www.instagram.com']);
const THREADS_ALIASES = new Set(['threads']);
const THREADS_HOSTS = new Set(['www.threads.com']);
const X_ALIASES = new Set(['x', 'twitter', 'x(twitter)', 'x/twitter']);
const X_HOSTS = ['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com'];
const MAX_AUTH_FILE_BYTES = 1_000_000;
const MAX_AUTH_RECORDS = 1_000;
const MAX_AUTH_FIELD_CHARACTERS = 65_536;

type SmokeRecipeKey = 'devto' | 'instagram' | 'threads' | 'x';

/** RFC 4180-style parser with a tab delimiter and multiline quoted fields. */
export function parseTsv(input: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;

  const finishField = (): void => {
    row.push(field);
    field = '';
  };
  const finishRow = (): void => {
    finishField();
    rows.push(row);
    row = [];
  };

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    if (quoted) {
      if (char === '"') {
        if (input[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"' && field.length === 0) {
      quoted = true;
    } else if (char === '\t') {
      finishField();
    } else if (char === '\r' || char === '\n') {
      if (char === '\r' && input[index + 1] === '\n') index += 1;
      finishRow();
    } else {
      field += char;
    }
  }

  if (quoted) throw new SafeCliError('AUTH_FILE_UNCLOSED_QUOTE');
  if (field.length > 0 || row.length > 0) finishRow();
  return rows;
}

function normalizedHeader(value: string): string {
  return value
    .replace(/^\uFEFF/, '')
    .replace(/[Đđ]/g, 'd')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function requiredColumn(headers: readonly string[], expected: string): number {
  const normalizedExpected = normalizedHeader(expected);
  const index = headers.findIndex((header) => normalizedHeader(header) === normalizedExpected);
  if (index < 0) throw new SafeCliError('AUTH_FILE_HEADER_MISMATCH');
  return index;
}

function requiredColumnMatching(
  headers: readonly string[],
  predicate: (header: string) => boolean,
): number {
  const matches = headers
    .map((header, index) => ({ header: normalizedHeader(header), index }))
    .filter(({ header }) => predicate(header));
  if (matches.length !== 1) throw new SafeCliError('AUTH_FILE_HEADER_MISMATCH');
  return matches[0]!.index;
}

export function authRecordsFromTsv(input: string): AuthRecord[] {
  const rows = parseTsv(input);
  const headers = rows.shift();
  if (!headers) throw new SafeCliError('AUTH_FILE_EMPTY');
  const normalizedHeaders = headers.map(normalizedHeader);
  if (new Set(normalizedHeaders).size !== normalizedHeaders.length) {
    throw new SafeCliError('AUTH_FILE_DUPLICATE_HEADER');
  }
  const contentRows = rows.filter((values) => values.some((value) => value.length > 0));
  if (contentRows.length > MAX_AUTH_RECORDS) throw new SafeCliError('AUTH_FILE_TOO_MANY_ROWS');
  for (const values of contentRows) {
    if (values.length > headers.length) throw new SafeCliError('AUTH_FILE_ROW_TOO_WIDE');
    if (values.some((value) => value.length > MAX_AUTH_FIELD_CHARACTERS)) {
      throw new SafeCliError('AUTH_FILE_FIELD_TOO_LARGE');
    }
  }

  const columns = {
    sequence: requiredColumn(headers, 'STT'),
    platform: requiredColumn(headers, 'Social Network'),
    // Some spreadsheet exports replace Vietnamese header glyphs with `?`.
    // These two columns retain stable English tokens, so recognize them
    // without weakening validation for the credential columns.
    loginUrl: requiredColumnMatching(
      headers,
      (header) => header.startsWith('url ') && !header.includes('profile'),
    ),
    loginMethod: requiredColumnMatching(
      headers,
      (header) => header.includes('login') && !header.startsWith('url '),
    ),
    user: requiredColumn(headers, 'User'),
    password: requiredColumn(headers, 'Pass'),
    twoFactor: requiredColumn(headers, '2fa'),
    profileUrl: requiredColumn(headers, 'URL Profile'),
  };

  return contentRows
    .map((values, index): AuthRecord => ({
      rowNumber: index + 2,
      sequence: values[columns.sequence]?.trim() ?? '',
      platform: values[columns.platform]?.trim() ?? '',
      loginUrl: values[columns.loginUrl]?.trim() ?? '',
      loginMethod: values[columns.loginMethod]?.trim() ?? '',
      user: values[columns.user]?.trim() ?? '',
      // Password whitespace is significant and must not be normalized.
      password: values[columns.password] ?? '',
      twoFactor: values[columns.twoFactor]?.trim() ?? '',
      profileUrl: values[columns.profileUrl]?.trim() ?? '',
    }))
    .filter((record) => record.platform.length > 0);
}

function decodeBase32(value: string): Buffer {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const normalized = value.toUpperCase().replace(/[\s=-]/g, '');
  if (normalized.length < 16 || !/^[A-Z2-7]+$/.test(normalized)) {
    throw new SafeCliError('TOTP_SECRET_INVALID');
  }
  let bits = '';
  for (const char of normalized) {
    bits += alphabet.indexOf(char).toString(2).padStart(5, '0');
  }
  const bytes: number[] = [];
  for (let index = 0; index + 8 <= bits.length; index += 8) {
    bytes.push(Number.parseInt(bits.slice(index, index + 8), 2));
  }
  return Buffer.from(bytes);
}

function parseTotpConfiguration(value: string): TotpConfiguration {
  if (!value.toLowerCase().startsWith('otpauth://')) {
    return { secret: value, algorithm: 'sha1', digits: 6, period: 30 };
  }
  let uri: URL;
  try {
    uri = new URL(value);
  } catch {
    throw new SafeCliError('TOTP_URI_INVALID');
  }
  if (uri.protocol !== 'otpauth:' || uri.hostname.toLowerCase() !== 'totp') {
    throw new SafeCliError('TOTP_URI_UNSUPPORTED');
  }
  const secret = uri.searchParams.get('secret')?.trim() ?? '';
  const algorithmValue = (uri.searchParams.get('algorithm') ?? 'SHA1').toLowerCase();
  if (!['sha1', 'sha256', 'sha512'].includes(algorithmValue)) {
    throw new SafeCliError('TOTP_ALGORITHM_UNSUPPORTED');
  }
  const digitsValue = uri.searchParams.get('digits') ?? '6';
  const periodValue = uri.searchParams.get('period') ?? '30';
  if (!/^\d+$/.test(digitsValue) || !/^\d+$/.test(periodValue)) {
    throw new SafeCliError('TOTP_PARAMETERS_INVALID');
  }
  const digits = Number.parseInt(digitsValue, 10);
  const period = Number.parseInt(periodValue, 10);
  if (![6, 7, 8].includes(digits) || !Number.isInteger(period) || period < 15 || period > 120) {
    throw new SafeCliError('TOTP_PARAMETERS_INVALID');
  }
  return {
    secret,
    algorithm: algorithmValue as TotpConfiguration['algorithm'],
    digits,
    period,
  };
}

export function generateTotp(configuration: TotpConfiguration, timestampMs = Date.now()): string {
  const counter = Math.floor(timestampMs / 1000 / configuration.period);
  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac(configuration.algorithm, decodeBase32(configuration.secret))
    .update(counterBuffer)
    .digest();
  const offset = (digest.at(-1) ?? 0) & 0x0f;
  const binary = digest.readUInt32BE(offset) & 0x7fffffff;
  return String(binary % 10 ** configuration.digits).padStart(configuration.digits, '0');
}

function optionValue(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new SafeCliError('CLI_OPTION_VALUE_MISSING');
  return value;
}

function positiveInteger(value: string | undefined, fallback: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value)) throw new SafeCliError('CLI_NUMBER_INVALID');
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new SafeCliError('CLI_NUMBER_INVALID');
  }
  return parsed;
}

export function parseOptions(args: readonly string[]): CliOptions {
  const authFile = optionValue(args, '--auth-file');
  const platform = optionValue(args, '--platform');
  if (!platform) throw new SafeCliError('CLI_REQUIRED_OPTION_MISSING');
  const manualLogin = args.includes('--manual-login');
  const inspectSession = args.includes('--inspect-session');
  if (
    !authFile &&
    !(X_ALIASES.has(normalizedPlatform(platform)) && (manualLogin || inspectSession))
  ) {
    throw new SafeCliError('CLI_REQUIRED_OPTION_MISSING');
  }
  const accountLabel = optionValue(args, '--account-label') ?? 'account01';
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(accountLabel))
    throw new SafeCliError('CLI_ACCOUNT_LABEL_INVALID');
  const accountRef = optionValue(args, '--account-ref');
  const executeLiveLogin =
    args.includes('--execute-live-login') || inspectSession || (!authFile && manualLogin);
  if (authFile && executeLiveLogin && (!accountRef || !/^[a-f\d]{12}$/i.test(accountRef))) {
    throw new SafeCliError('CLI_ACCOUNT_REF_REQUIRED');
  }
  return {
    authFile: authFile ? resolve(authFile) : undefined,
    platform,
    ordinal: positiveInteger(optionValue(args, '--ordinal'), 1, 1_000),
    accountRef,
    executeLiveLogin,
    headless: args.includes('--headless'),
    requireTwoFactor: args.includes('--require-2fa'),
    timeoutMs: positiveInteger(optionValue(args, '--timeout-ms'), 60_000, 900_000),
    manualLogin,
    profilesDir: resolve(optionValue(args, '--profiles-dir') ?? 'profiles/social-login'),
    inspectSession,
    accountLabel,
  };
}

function normalizedPlatform(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, '');
}

function recipeKeyForPlatform(value: string): SmokeRecipeKey {
  const requested = normalizedPlatform(value);
  if (DEV_TO_ALIASES.has(requested)) return 'devto';
  if (INSTAGRAM_ALIASES.has(requested)) return 'instagram';
  if (THREADS_ALIASES.has(requested)) return 'threads';
  if (X_ALIASES.has(requested)) return 'x';
  throw new SafeCliError('PLATFORM_RECIPE_NOT_REVIEWED');
}

function recipeAliases(recipeKey: SmokeRecipeKey): ReadonlySet<string> {
  if (recipeKey === 'devto') return DEV_TO_ALIASES;
  if (recipeKey === 'instagram') return INSTAGRAM_ALIASES;
  if (recipeKey === 'x') return X_ALIASES;
  return THREADS_ALIASES;
}

function selectRecord(
  records: readonly AuthRecord[],
  options: CliOptions,
  recipeKey: SmokeRecipeKey,
): AuthRecord {
  const requested = normalizedPlatform(options.platform);
  const aliases = recipeAliases(recipeKey);
  if (!aliases.has(requested)) throw new SafeCliError('PLATFORM_RECIPE_NOT_REVIEWED');
  const candidates = records.filter((record) => {
    const platformMatches = aliases.has(normalizedPlatform(record.platform));
    const complete = record.user.length > 0 && record.password.length > 0;
    return (
      platformMatches && complete && (!options.requireTwoFactor || record.twoFactor.length > 0)
    );
  });
  const selected = options.executeLiveLogin
    ? candidates.find((record) => accountReference(record) === options.accountRef?.toLowerCase())
    : candidates[options.ordinal - 1];
  if (!selected) throw new SafeCliError('ACCOUNT_RECORD_NOT_FOUND');
  return selected;
}

function assertSupportedLoginMethod(record: AuthRecord, recipeKey: SmokeRecipeKey): void {
  const method = record.loginMethod.trim().toLowerCase().replace(/\s+/g, ' ');
  const supported =
    recipeKey === 'devto'
      ? method === 'gmail / google auth'
      : recipeKey === 'x'
        ? method === 'user + password' || X_ALIASES.has(normalizedPlatform(method))
        : method === 'user + password';
  if (!supported) throw new SafeCliError('LOGIN_METHOD_NOT_REVIEWED');
}

function validateHttpsHost(value: string, allowedHosts: ReadonlySet<string>): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new SafeCliError('LOGIN_URL_INVALID');
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    !allowedHosts.has(url.hostname.toLowerCase())
  ) {
    throw new SafeCliError('LOGIN_URL_NOT_ALLOWED');
  }
  return url;
}

function safePageUrl(value: string): string {
  try {
    const url = new URL(value);
    return url.origin;
  } catch {
    return 'invalid-url';
  }
}

async function firstVisible(page: Page, selector: string): Promise<Locator | undefined> {
  const matches = page.locator(selector);
  const count = await matches.count();
  for (let index = 0; index < count; index += 1) {
    const candidate = matches.nth(index);
    if (await candidate.isVisible().catch(() => false)) return candidate;
  }
  return undefined;
}

async function waitForFirstVisible(
  page: Page,
  selector: string,
  timeoutMs: number,
): Promise<Locator | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const match = await firstVisible(page, selector);
    if (match) return match;
    await page.waitForTimeout(250);
  }
  return undefined;
}

async function hasHumanChallenge(page: Page): Promise<boolean> {
  if (
    /just a moment|verify (that )?you are human|checking your browser|performing security verification/i.test(
      await page.title(),
    )
  )
    return true;
  return Boolean(
    await firstVisible(
      page,
      [
        'iframe[src*="challenges.cloudflare.com"]',
        'iframe[src*="recaptcha"]',
        'input[name="cf-turnstile-response"]',
        'input[name*="captcha" i]',
      ].join(','),
    ),
  );
}

async function settleAfterSubmit(page: Page, timeoutMs: number): Promise<void> {
  await page
    .waitForLoadState('domcontentloaded', { timeout: Math.min(timeoutMs, 20_000) })
    .catch(() => undefined);
  await page.waitForTimeout(1_250);
}

async function submitTwoFactor(
  page: Page,
  input: Locator,
  twoFactor: string,
  timeoutMs: number,
): Promise<void> {
  if (!twoFactor) throw new SafeCliError('TWO_FACTOR_SECRET_MISSING');
  const configuration = parseTotpConfiguration(twoFactor);
  const remainingSeconds =
    configuration.period - (Math.floor(Date.now() / 1_000) % configuration.period);
  if (remainingSeconds < 5) await page.waitForTimeout((remainingSeconds + 1) * 1_000);
  await input.fill(generateTotp(configuration));
  const form = input.locator('xpath=ancestor::form[1]');
  const submit = form.locator('input[type="submit"],button[type="submit"]').first();
  if (await submit.count()) await submit.click();
  else await input.press('Enter');
  await settleAfterSubmit(page, timeoutMs);
}

function pageHost(page: Page): string {
  try {
    return new URL(page.url()).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function assertCredentialHost(page: Page, expectedHosts: string | readonly string[]): void {
  const allowed = typeof expectedHosts === 'string' ? [expectedHosts] : expectedHosts;
  if (!allowed.includes(pageHost(page))) throw new SafeCliError('CREDENTIAL_HOST_MISMATCH');
}

async function runDevToGoogleAuthentication(
  page: Page,
  record: AuthRecord,
  timeoutMs: number,
): Promise<SmokeResult | undefined> {
  const googleButton = await firstVisible(page, 'form[action*="/users/auth/google_oauth2"] button');
  if (!googleButton) {
    return {
      phase: 'login-page',
      status: 'FORM_NOT_FOUND',
      url: safePageUrl(page.url()),
    };
  }
  await googleButton.click();
  await settleAfterSubmit(page, timeoutMs);
  // A persistent Google session can complete the redirect without entering credentials again.
  if (pageHost(page) === 'dev.to') return undefined;
  if (await hasHumanChallenge(page)) {
    return {
      phase: 'authentication',
      status: 'CHALLENGE_REQUIRES_HUMAN',
      url: safePageUrl(page.url()),
    };
  }

  assertCredentialHost(page, 'accounts.google.com');
  const email = await firstVisible(page, 'input[type="email"],input[name="identifier"]');
  if (!email) {
    return {
      phase: 'authentication',
      status: 'CHALLENGE_REQUIRES_HUMAN',
      url: safePageUrl(page.url()),
    };
  }
  await email.fill(record.user);
  const identifierNext = page.locator('#identifierNext button,#identifierNext').first();
  if (!(await identifierNext.count())) {
    return {
      phase: 'authentication',
      status: 'FORM_NOT_FOUND',
      url: safePageUrl(page.url()),
    };
  }
  await identifierNext.click();
  await settleAfterSubmit(page, timeoutMs);
  if (await hasHumanChallenge(page)) {
    return {
      phase: 'authentication',
      status: 'CHALLENGE_REQUIRES_HUMAN',
      url: safePageUrl(page.url()),
    };
  }

  assertCredentialHost(page, 'accounts.google.com');
  const password = await waitForFirstVisible(
    page,
    'input[type="password"][name="Passwd"],input[type="password"]',
    Math.min(timeoutMs, 12_000),
  );
  if (!password) {
    return inspectUnverifiedLogin(page, ['accounts.google.com', 'dev.to']);
  }
  await password.fill(record.password);
  const passwordNext = page.locator('#passwordNext button,#passwordNext').first();
  if (!(await passwordNext.count())) {
    return {
      phase: 'authentication',
      status: 'FORM_NOT_FOUND',
      url: safePageUrl(page.url()),
    };
  }
  await passwordNext.click();
  await settleAfterSubmit(page, timeoutMs);
  if (await hasHumanChallenge(page)) {
    return {
      phase: 'authentication',
      status: 'CHALLENGE_REQUIRES_HUMAN',
      url: safePageUrl(page.url()),
    };
  }

  if (pageHost(page) === 'accounts.google.com') {
    const twoFactorInput = await firstVisible(
      page,
      ['input[name="totpPin"]', 'input#totpPin', 'input[name*="totp" i]'].join(','),
    );
    if (twoFactorInput) {
      if (!record.twoFactor) {
        return {
          phase: 'authentication',
          status: 'TWO_FACTOR_REQUIRED',
          url: safePageUrl(page.url()),
        };
      }
      assertCredentialHost(page, 'accounts.google.com');
      const configuration = parseTotpConfiguration(record.twoFactor);
      const remainingSeconds =
        configuration.period - (Math.floor(Date.now() / 1_000) % configuration.period);
      if (remainingSeconds < 5) await page.waitForTimeout((remainingSeconds + 1) * 1_000);
      await twoFactorInput.fill(generateTotp(configuration));
      const twoFactorNext = page.locator('#totpNext button,#totpNext').first();
      if (await twoFactorNext.count()) await twoFactorNext.click();
      else await twoFactorInput.press('Enter');
      await settleAfterSubmit(page, timeoutMs);
    }
  }

  if (pageHost(page) === 'accounts.google.com') {
    // Previously approved DEV accounts normally redirect immediately. Any
    // account chooser, recovery check, or new consent surface needs a person.
    return {
      phase: 'authentication',
      status: 'CHALLENGE_REQUIRES_HUMAN',
      url: safePageUrl(page.url()),
    };
  }
  if (pageHost(page) !== 'dev.to') {
    return {
      phase: 'authentication',
      status: 'LOGIN_REJECTED',
      url: safePageUrl(page.url()),
    };
  }
  return undefined;
}

async function metaAuthenticationOutcome(
  page: Page,
  record: AuthRecord,
  timeoutMs: number,
  credentialHosts: readonly string[],
): Promise<SmokeResult | undefined> {
  if (await hasHumanChallenge(page)) {
    return {
      phase: 'authentication',
      status: 'CHALLENGE_REQUIRES_HUMAN',
      url: safePageUrl(page.url()),
    };
  }
  const twoFactorInput = await waitForFirstVisible(
    page,
    ['input[name*="totp" i]', 'input[data-testid*="totp" i]'].join(','),
    4_000,
  );
  if (twoFactorInput) {
    if (!record.twoFactor) {
      return {
        phase: 'authentication',
        status: 'TWO_FACTOR_REQUIRED',
        url: safePageUrl(page.url()),
      };
    }
    assertCredentialHost(page, credentialHosts);
    await submitTwoFactor(page, twoFactorInput, record.twoFactor, timeoutMs);
    if (await firstVisible(page, 'input[name*="totp" i],input[data-testid*="totp" i]')) {
      return {
        phase: 'authentication',
        status: 'TWO_FACTOR_REJECTED',
        url: safePageUrl(page.url()),
      };
    }
  }
  const path = (() => {
    try {
      return new URL(page.url()).pathname;
    } catch {
      return '';
    }
  })();
  if (/\/(checkpoint|challenge|security|two_factor)(\/|$)/i.test(path)) {
    return {
      phase: 'authentication',
      status: 'CHALLENGE_REQUIRES_HUMAN',
      url: safePageUrl(page.url()),
    };
  }
  return undefined;
}

async function hasSessionCookie(
  context: BrowserContext,
  allowedDomainSuffixes: readonly string[],
): Promise<boolean> {
  const cookies = await context.cookies();
  return cookies.some(
    (cookie) =>
      cookie.name === 'sessionid' &&
      allowedDomainSuffixes.some((suffix) => {
        const domain = cookie.domain.replace(/^\./, '').toLowerCase();
        const expected = suffix.toLowerCase();
        return domain === expected || domain.endsWith(`.${expected}`);
      }),
  );
}

async function runInstagramSmoke(
  context: BrowserContext,
  record: AuthRecord,
  timeoutMs: number,
): Promise<SmokeResult> {
  const loginUrl = validateHttpsHost('https://www.instagram.com/accounts/login/', INSTAGRAM_HOSTS);
  const page = await context.newPage();
  const response = await page.goto(loginUrl.href, {
    waitUntil: 'domcontentloaded',
    timeout: timeoutMs,
  });
  if (await hasHumanChallenge(page)) {
    return {
      phase: 'login-page',
      status: 'CHALLENGE_REQUIRES_HUMAN',
      url: safePageUrl(page.url()),
      statusCode: response?.status(),
    };
  }
  const user = await waitForFirstVisible(
    page,
    'form input[name="email"],form input[autocomplete*="username"]',
    Math.min(timeoutMs, 12_000),
  );
  const password = await waitForFirstVisible(
    page,
    'form input[name="pass"],form input[type="password"]',
    Math.min(timeoutMs, 12_000),
  );
  const submit = await waitForFirstVisible(
    page,
    'form button[type="submit"],form [role="button"],form input[type="submit"]',
    Math.min(timeoutMs, 12_000),
  );
  if (!user || !password || !submit) {
    return {
      phase: 'login-page',
      status: 'FORM_NOT_FOUND',
      url: safePageUrl(page.url()),
      statusCode: response?.status(),
    };
  }
  assertCredentialHost(page, 'www.instagram.com');
  await user.fill(record.user);
  await password.fill(record.password);
  await submit.click();
  await settleAfterSubmit(page, timeoutMs);
  const authenticationResult = await metaAuthenticationOutcome(page, record, timeoutMs, [
    'www.instagram.com',
  ]);
  if (authenticationResult) return authenticationResult;
  const sessionReady = await hasSessionCookie(context, ['instagram.com']);
  const remainingLogin = await firstVisible(
    page,
    'form input[name="email"],form input[name="pass"]',
  );
  if (!sessionReady || remainingLogin) {
    return inspectUnverifiedLogin(page, ['www.instagram.com']);
  }

  const editorResponse = await page.goto('https://www.instagram.com/create/select/', {
    waitUntil: 'domcontentloaded',
    timeout: timeoutMs,
  });
  await page.waitForTimeout(2_000);
  if (pageHost(page) !== 'www.instagram.com') {
    throw new SafeCliError('EDITOR_HOST_MISMATCH');
  }
  const upload = page
    .locator('input[type="file"][accept*="image" i],input[type="file"][accept*="video" i]')
    .first();
  const editorPath = new URL(page.url()).pathname;
  const editorSurface = await firstVisible(
    page,
    '[role="dialog"],[aria-label*="create new post" i],[aria-label*="new post" i]',
  );
  const editorReady =
    editorPath.startsWith('/create/') && (await upload.count()) > 0 && Boolean(editorSurface);
  const redirectedLogin = await firstVisible(
    page,
    'form input[name="email"],form input[name="pass"]',
  );
  const challenge = await hasHumanChallenge(page);
  return {
    phase: 'editor',
    status: redirectedLogin
      ? 'LOGIN_REJECTED'
      : challenge
        ? 'CHALLENGE_REQUIRES_HUMAN'
        : editorReady
          ? 'READY'
          : 'EDITOR_NOT_FOUND',
    url: safePageUrl(page.url()),
    statusCode: editorResponse?.status(),
  };
}

async function runThreadsSmoke(
  context: BrowserContext,
  record: AuthRecord,
  timeoutMs: number,
): Promise<SmokeResult> {
  const loginUrl = validateHttpsHost('https://www.threads.com/login', THREADS_HOSTS);
  const page = await context.newPage();
  const response = await page.goto(loginUrl.href, {
    waitUntil: 'domcontentloaded',
    timeout: timeoutMs,
  });
  if (await hasHumanChallenge(page)) {
    return {
      phase: 'login-page',
      status: 'CHALLENGE_REQUIRES_HUMAN',
      url: safePageUrl(page.url()),
      statusCode: response?.status(),
    };
  }
  const user = await waitForFirstVisible(
    page,
    'form input[autocomplete="username"],form input[type="text"]',
    Math.min(timeoutMs, 12_000),
  );
  const password = await waitForFirstVisible(
    page,
    'form input[autocomplete="current-password"],form input[type="password"]',
    Math.min(timeoutMs, 12_000),
  );
  const submit = await waitForFirstVisible(
    page,
    'form button[type="submit"],form [role="button"],form input[type="submit"]',
    Math.min(timeoutMs, 12_000),
  );
  if (!user || !password || !submit) {
    return {
      phase: 'login-page',
      status: 'FORM_NOT_FOUND',
      url: safePageUrl(page.url()),
      statusCode: response?.status(),
    };
  }
  assertCredentialHost(page, ['www.threads.com', 'www.instagram.com']);
  await user.fill(record.user);
  await password.fill(record.password);
  await submit.click();
  await settleAfterSubmit(page, timeoutMs);
  const authenticationResult = await metaAuthenticationOutcome(page, record, timeoutMs, [
    'www.threads.com',
    'www.instagram.com',
  ]);
  if (authenticationResult) return authenticationResult;
  const sessionReady = await hasSessionCookie(context, ['threads.com', 'instagram.com']);
  const remainingLogin = await firstVisible(
    page,
    'form input[autocomplete="username"],form input[autocomplete="current-password"]',
  );
  if (!sessionReady || remainingLogin) {
    return inspectUnverifiedLogin(page, ['www.threads.com', 'www.instagram.com']);
  }

  const editorResponse = await page.goto('https://www.threads.com/', {
    waitUntil: 'domcontentloaded',
    timeout: timeoutMs,
  });
  await page.waitForTimeout(2_000);
  if (pageHost(page) !== 'www.threads.com') throw new SafeCliError('EDITOR_HOST_MISMATCH');
  const redirectedLogin = await firstVisible(
    page,
    'form input[autocomplete="username"],form input[autocomplete="current-password"]',
  );
  const challenge = await hasHumanChallenge(page);
  if (redirectedLogin) {
    return {
      phase: 'editor',
      status: 'LOGIN_REJECTED',
      url: safePageUrl(page.url()),
      statusCode: editorResponse?.status(),
    };
  }
  if (challenge) {
    return {
      phase: 'editor',
      status: 'CHALLENGE_REQUIRES_HUMAN',
      url: safePageUrl(page.url()),
      statusCode: editorResponse?.status(),
    };
  }
  const editorPath = new URL(page.url()).pathname;
  const editorSelector = [
    '[contenteditable="true"][role="textbox"][data-lexical-editor="true"]',
    'textarea[placeholder*="start a thread" i]',
    '[data-testid="composer-text-input"][contenteditable="true"]',
  ].join(',');
  let composer = await firstVisible(page, editorSelector);
  if (!composer) {
    const startThread = page.getByText(/^Start a thread$/i).first();
    if (await startThread.isVisible().catch(() => false)) {
      await startThread.click();
      composer = await waitForFirstVisible(page, editorSelector, Math.min(timeoutMs, 8_000));
    }
  }
  return {
    phase: 'editor',
    status: editorPath === '/' && composer ? 'READY' : 'EDITOR_NOT_FOUND',
    url: safePageUrl(page.url()),
    statusCode: editorResponse?.status(),
  };
}

async function runDevToSmoke(
  context: BrowserContext,
  record: AuthRecord,
  timeoutMs: number,
): Promise<SmokeResult> {
  // The supplied TSV has blank or malformed URLs on some valid DEV rows.
  // A reviewed recipe always uses its canonical host instead of letting the
  // credential file steer navigation.
  const canonicalLoginUrl = validateHttpsHost('https://dev.to/enter', DEV_TO_HOSTS);
  const page = await context.newPage();
  const response = await page.goto(canonicalLoginUrl.href, {
    waitUntil: 'domcontentloaded',
    timeout: timeoutMs,
  });
  if (await hasHumanChallenge(page)) {
    return {
      phase: 'login-page',
      status: 'CHALLENGE_REQUIRES_HUMAN',
      url: safePageUrl(page.url()),
      statusCode: response?.status(),
    };
  }

  const loginMethod = record.loginMethod.trim().toLowerCase().replace(/\s+/g, ' ');
  if (loginMethod !== 'gmail / google auth') throw new SafeCliError('LOGIN_METHOD_NOT_REVIEWED');
  const googleResult = await runDevToGoogleAuthentication(page, record, timeoutMs);
  if (googleResult) return googleResult;

  const editorResponse = await page.goto('https://dev.to/new', {
    waitUntil: 'domcontentloaded',
    timeout: timeoutMs,
  });
  await page.waitForTimeout(2_000);
  if (pageHost(page) !== 'dev.to') throw new SafeCliError('EDITOR_HOST_MISMATCH');
  if (await hasHumanChallenge(page)) {
    return {
      phase: 'editor',
      status: 'CHALLENGE_REQUIRES_HUMAN',
      url: safePageUrl(page.url()),
      statusCode: editorResponse?.status(),
    };
  }
  const editor = await firstVisible(
    page,
    [
      '#article-form-title',
      '#article_body_markdown',
      'textarea[name="article[body_markdown]"]',
      '[data-testid*="article-form" i]',
    ].join(','),
  );
  const redirectedLogin = await firstVisible(page, 'form#new_user input[name="user[email]"]');
  return {
    phase: 'editor',
    status: redirectedLogin ? 'LOGIN_REJECTED' : editor ? 'READY' : 'EDITOR_NOT_FOUND',
    url: safePageUrl(page.url()),
    statusCode: editorResponse?.status(),
  };
}

export function accountReference(record: AuthRecord): string {
  const input: BinaryLike = [
    normalizedPlatform(record.platform),
    record.loginMethod.trim().toLowerCase(),
    record.user.trim().toLowerCase(),
  ].join('\u0000');
  return createHash('sha256').update(input).digest('hex').slice(0, 12);
}

/** One sanctioned login attempt; never solve a CAPTCHA or repeat a rejected password/code. */
export async function runXSmoke(
  context: BrowserContext,
  record: AuthRecord,
  timeoutMs: number,
): Promise<SmokeResult> {
  let page = context
    .pages()
    .find(
      (candidate) =>
        !candidate.isClosed() &&
        pageHost(candidate) === 'x.com' &&
        new URL(candidate.url()).pathname === '/i/flow/login',
    );
  if (!page) {
    page = await context.newPage();
    await page.goto('https://x.com/i/flow/login', {
      waitUntil: 'domcontentloaded',
      timeout: timeoutMs,
    });
  }
  const deadline = Date.now() + timeoutMs;
  let identifierSubmitted = false;
  let passwordSubmitted = false;
  let otpSubmitted = false;
  const detector = new AuthDetector();
  const adapter = { allowedHosts: X_HOSTS, selectors: {} };
  while (Date.now() < deadline) {
    assertCredentialHost(page, X_HOSTS);
    const authenticated = await inspectStoredSession(page, 'x');
    if (authenticated) return authenticated;
    const detection = await detector.detectAuthState(page, adapter);
    if (
      detection.failure ||
      [
        AuthState.CAPTCHA_REQUIRED,
        AuthState.EMAIL_VERIFICATION_REQUIRED,
        AuthState.DEVICE_CONFIRMATION_REQUIRED,
      ].includes(detection.state) ||
      /\/account\/(access|locked|suspended)/i.test(new URL(page.url()).pathname)
    ) {
      return inspectUnverifiedLogin(page, X_HOSTS);
    }
    const password = await firstVisible(page, 'input[name="password"][type="password"]');
    if (password && !passwordSubmitted) {
      const login = page.getByRole('button', { name: /^(Log in|Đăng nhập)$/i });
      if ((await login.count()) !== 1 || !(await login.isVisible()))
        return { phase: 'authentication', status: 'FORM_NOT_FOUND', url: safePageUrl(page.url()) };
      await password.fill(record.password);
      passwordSubmitted = true;
      await login.click();
    } else if (detection.state === AuthState.TWO_FACTOR_REQUIRED) {
      const surfaces = (await page.locator('[role="dialog"],main').allInnerTexts())
        .join('\n')
        .slice(0, 16000);
      // Email/SMS codes and generic verification inputs are never treated as an authenticator code.
      if (
        otpSubmitted ||
        !record.twoFactor ||
        !/authenticat(?:or|ion) app|code generator|ứng dụng xác thực/i.test(surfaces) ||
        /(?:sent|send|emailed).*(?:email|phone|sms)|text message/i.test(surfaces)
      ) {
        return inspectUnverifiedLogin(page, X_HOSTS);
      }
      const otp = await firstVisible(
        page,
        'input[autocomplete="one-time-code"],input[data-testid="ocfEnterTextTextInput"]',
      );
      const next = page.getByRole('button', { name: /^(Next|Verify|Tiếp theo|Xác minh)$/i });
      if (!otp || (await next.count()) !== 1 || !(await next.isVisible()))
        return { phase: 'authentication', status: 'FORM_NOT_FOUND', url: safePageUrl(page.url()) };
      const config = parseTotpConfiguration(record.twoFactor);
      const remaining = config.period - (Math.floor(Date.now() / 1000) % config.period);
      if (remaining < 5) await page.waitForTimeout((remaining + 1) * 1000);
      let code: string | undefined = generateTotp(config);
      try {
        await otp.fill(code);
        otpSubmitted = true;
        await next.click();
      } finally {
        code = undefined;
        config.secret = '';
        await otp.fill('', { timeout: 1000 }).catch(() => undefined);
      }
    } else if (!identifierSubmitted) {
      const identifier = await firstVisible(
        page,
        'input[autocomplete="username"],input[name="text"][type="text"]',
      );
      if (identifier) {
        const next = page.getByRole('button', { name: /^(Next|Tiếp theo)$/i });
        if ((await next.count()) !== 1 || !(await next.isVisible()))
          return { phase: 'login-page', status: 'FORM_NOT_FOUND', url: safePageUrl(page.url()) };
        await identifier.fill(record.user);
        identifierSubmitted = true;
        await next.click();
      }
    } else if (!passwordSubmitted && (await firstVisible(page, 'input[name="text"]'))) {
      const surfaces = (await page.locator('[role="dialog"],main').allInnerTexts())
        .join('\n')
        .slice(0, 16000);
      if (
        /phone number or username|enter your (?:phone|username)|confirm (?:your )?(?:phone|username)|unusual login|số điện thoại hoặc tên người dùng/i.test(
          surfaces,
        )
      ) {
        // Additional identity/device confirmation needs the owner; no guessed identifiers.
        return {
          phase: 'authentication',
          status: 'CHALLENGE_REQUIRES_HUMAN',
          authState: AuthState.UNKNOWN_AUTH_CHALLENGE,
          url: safePageUrl(page.url()),
        };
      }
    }
    await page.waitForTimeout(Math.min(1500, Math.max(1, deadline - Date.now())));
  }
  return inspectUnverifiedLogin(page, X_HOSTS);
}

/** Positive editor + account UI evidence, before any password submission. */
export async function inspectStoredSession(
  page: Page,
  recipe: SmokeRecipeKey,
): Promise<SmokeResult | undefined> {
  if (await hasHumanChallenge(page)) return undefined;
  const host = pageHost(page);
  if (
    recipe === 'x' &&
    X_HOSTS.includes(host) &&
    new URL(page.url()).pathname === '/home' &&
    (await page.context().cookies(['https://x.com', 'https://twitter.com'])).some(
      (cookie) => cookie.name === 'auth_token',
    ) &&
    (await firstVisible(page, '[data-testid="SideNav_AccountSwitcher_Button"]')) &&
    (await firstVisible(page, '[data-testid="AppTabBar_Home_Link"]')) &&
    !(await firstVisible(page, 'input[type="password"]'))
  ) {
    return {
      phase: 'authentication',
      status: 'READY',
      authState: AuthState.AUTHENTICATED,
      url: safePageUrl(page.url()),
    };
  }
  if (
    recipe === 'devto' &&
    host === 'dev.to' &&
    new URL(page.url()).pathname === '/new' &&
    (await firstVisible(page, '#article-form-title')) &&
    (await firstVisible(page, '#article_body_markdown,textarea[name="article[body_markdown]"]')) &&
    (await firstVisible(
      page,
      '#nav-profile-image,#topbar__user__nav,[data-testid="header-user-menu-trigger"]',
    ))
  ) {
    return { phase: 'editor', status: 'READY', url: safePageUrl(page.url()) };
  }
  if (
    recipe === 'instagram' &&
    host === 'www.instagram.com' &&
    (await hasSessionCookie(page.context(), ['instagram.com'])) &&
    (await firstVisible(page, 'a[href="/direct/inbox/"]')) &&
    !(await firstVisible(page, 'input[type="password"]'))
  ) {
    return { phase: 'authentication', status: 'READY', url: safePageUrl(page.url()) };
  }
  if (
    recipe === 'threads' &&
    host === 'www.threads.com' &&
    (await hasSessionCookie(page.context(), ['threads.com', 'instagram.com'])) &&
    (await firstVisible(page, 'a[href="/activity"],[aria-label="Profile"]')) &&
    !(await firstVisible(page, 'input[type="password"]'))
  ) {
    return { phase: 'authentication', status: 'READY', url: safePageUrl(page.url()) };
  }
  return undefined;
}

/** Allow a saved X session's account UI to hydrate, without entering or submitting credentials. */
export async function waitForXStoredSession(
  page: Page,
  timeoutMs: number,
): Promise<SmokeResult | undefined> {
  const deadline = Date.now() + Math.min(timeoutMs, 15000);
  while (!page.isClosed()) {
    const result = await inspectStoredSession(page, 'x');
    if (result) return result;
    const unresolved = await inspectUnverifiedLogin(page, X_HOSTS);
    if (
      [
        'LOGIN_REJECTED',
        'ACCOUNT_LOCKED',
        'CHALLENGE_REQUIRES_HUMAN',
        'TWO_FACTOR_REQUIRED',
      ].includes(unresolved.status)
    )
      return undefined;
    if (
      unresolved.authState === AuthState.LOGIN_REQUIRED &&
      (await firstVisible(page, 'input[autocomplete="username"],input[name="password"]'))
    )
      return undefined;
    if (Date.now() >= deadline) return undefined;
    await page.waitForTimeout(Math.min(1500, deadline - Date.now()));
  }
  return undefined;
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const recipeKey = recipeKeyForPlatform(options.platform);
  let record: AuthRecord;
  if (options.authFile) {
    const file = await stat(options.authFile);
    if (!file.isFile() || file.size > MAX_AUTH_FILE_BYTES)
      throw new SafeCliError('AUTH_FILE_SIZE_INVALID');
    let source = await readFile(options.authFile, 'utf8');
    record = selectRecord(authRecordsFromTsv(source), options, recipeKey);
    source = '';
  } else {
    // Local manual login needs only a stable label. No CSV or password is requested or copied.
    record = {
      rowNumber: 0,
      sequence: '',
      platform: 'x',
      loginMethod: 'MANUAL',
      user: options.accountLabel,
      password: '',
      twoFactor: '',
      loginUrl: '',
      profileUrl: '',
    };
  }
  if ([record.user, record.password, record.twoFactor].some((value) => value.includes('\uFFFD'))) {
    throw new SafeCliError('CREDENTIAL_ENCODING_INVALID');
  }
  if (options.authFile) assertSupportedLoginMethod(record, recipeKey);
  const host =
    recipeKey === 'x'
      ? 'x.com'
      : recipeKey === 'devto'
        ? 'dev.to'
        : recipeKey === 'instagram'
          ? 'www.instagram.com'
          : 'www.threads.com';
  const reference = accountReference(record);
  if (!options.executeLiveLogin) {
    console.log(
      JSON.stringify({
        status: 'DRY_RUN',
        platform: recipeKey,
        accountRef: reference,
        host,
        loginMethod: record.loginMethod,
        hasTwoFactor: record.twoFactor.length > 0,
      }),
    );
    return;
  }

  const allowedHosts =
    recipeKey === 'x'
      ? X_HOSTS
      : recipeKey === 'devto'
        ? ['dev.to', 'accounts.google.com']
        : recipeKey === 'instagram'
          ? ['instagram.com']
          : ['threads.com', 'instagram.com'];
  const networkGuard = new BrowserNetworkGuard();
  let proxy: BrowserNetworkProxy | undefined;
  const session = new SessionManager(options.profilesDir);
  const identity = { platform: recipeKey, account: reference };
  let stage = 'browser-start';
  let navigationStatusCode: number | undefined;
  try {
    if (options.inspectSession && options.manualLogin)
      throw new SafeCliError('INSPECT_AND_MANUAL_FLAGS_CONFLICT');
    if (options.manualLogin && options.headless)
      throw new SafeCliError('MANUAL_LOGIN_REQUIRES_VISIBLE_BROWSER');
    // Normal runtime env loading; never print values. The CSV itself is not copied into the profile.
    if (!process.env.BROWSER_SESSION_ENCRYPTION_KEY) {
      try {
        process.loadEnvFile();
      } catch {
        /* An explicitly supplied env key can be used without .env. */
      }
    }
    const snapshots = await createPrivateFileSessionStore(
      options.profilesDir,
      process.env.BROWSER_SESSION_ENCRYPTION_KEY,
    );
    const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined;
    await assertChromiumInstalled(executablePath);
    proxy = await networkGuard.startProxy();
    const page = await session.open(identity, {
      headless: options.headless,
      ...(executablePath ? { executablePath } : { channel: 'chromium' }),
      proxy: { server: proxy.server },
      args: ['--disable-dev-shm-usage', ...proxy.chromiumArgs],
    });
    const context = session.getContext();
    const observeNavigation = (observedPage: Page): void => {
      observedPage.on('response', (response) => {
        if (response.request().isNavigationRequest() && response.frame().parentFrame() === null) {
          navigationStatusCode = response.status();
        }
      });
    };
    for (const openedPage of context.pages()) observeNavigation(openedPage);
    context.on('page', observeNavigation);
    await networkGuard.install(context, allowedHosts);
    const stored = await snapshots.load(session.getProfilePath(), identity);
    const sessionCookies = stored.cookies.filter(
      (cookie) => cookie.expires === undefined || cookie.expires === -1,
    );
    if (sessionCookies.length > 0) await context.addCookies(sessionCookies);
    context.setDefaultTimeout(Math.min(options.timeoutMs, 30_000));
    context.setDefaultNavigationTimeout(options.timeoutMs);
    stage = 'session-preflight';
    await page.goto(
      recipeKey === 'x'
        ? options.inspectSession
          ? 'https://x.com/home'
          : 'https://x.com/i/flow/login'
        : recipeKey === 'devto'
          ? 'https://dev.to/new'
          : recipeKey === 'instagram'
            ? 'https://www.instagram.com/'
            : 'https://www.threads.com/',
      { waitUntil: 'domcontentloaded', timeout: options.timeoutMs },
    );
    if (recipeKey === 'x') await page.waitForTimeout(1500);
    let result =
      options.inspectSession && recipeKey === 'x'
        ? await waitForXStoredSession(page, options.timeoutMs)
        : await inspectStoredSession(page, recipeKey);
    const reusedSession = Boolean(result);
    if (!result && options.inspectSession) {
      result = await inspectUnverifiedLogin(page, [
        host,
        'accounts.google.com',
        'www.instagram.com',
      ]);
    }
    if (!result && !options.manualLogin && (await hasHumanChallenge(page))) {
      result = {
        phase: 'login-page',
        status: 'CHALLENGE_REQUIRES_HUMAN',
        url: safePageUrl(page.url()),
      };
    }
    if (!result && options.manualLogin) {
      console.log(
        JSON.stringify({
          platform: recipeKey,
          accountRef: reference,
          status: 'MANUAL_LOGIN_REQUIRED',
          profilePath: session.getProfilePath(),
          message:
            'Đăng nhập trong Chromium này, hoàn thành xác thực và mở editor. Session được lưu khi có bằng chứng đã đăng nhập.',
        }),
      );
      await waitForManualIntervention({
        ...identity,
        type: 'LOGIN',
        timeout: options.timeoutMs,
        check: async () => {
          for (const active of context.pages()) {
            const verified = await inspectStoredSession(active, recipeKey);
            if (verified) {
              result = verified;
              return true;
            }
          }
          return false;
        },
      });
    } else if (!result) {
      stage = 'authentication';
      result =
        recipeKey === 'devto'
          ? await runDevToSmoke(context, record, options.timeoutMs)
          : recipeKey === 'instagram'
            ? await runInstagramSmoke(context, record, options.timeoutMs)
            : recipeKey === 'x'
              ? await runXSmoke(context, record, options.timeoutMs)
              : await runThreadsSmoke(context, record, options.timeoutMs);
    }
    if (!result) throw new SafeCliError('SESSION_NOT_VERIFIED');
    if (result.status === 'READY') {
      let verified = false;
      for (const active of context.pages()) {
        if (!active.isClosed() && (await inspectStoredSession(active, recipeKey))) {
          verified = true;
          break;
        }
      }
      if (!verified) result = { ...result, status: 'SESSION_NOT_VERIFIED' };
    }
    const sessionSaved = result.status === 'READY';
    if (sessionSaved && !options.inspectSession)
      await snapshots.save(
        session.getProfilePath(),
        identity,
        await captureAllowedStorageState(context, allowedHosts),
      );
    console.log(
      JSON.stringify({
        platform: recipeKey,
        accountRef: reference,
        host,
        profilePath: session.getProfilePath(),
        reusedSession,
        sessionSaved: sessionSaved && !options.inspectSession,
        mode: options.inspectSession ? 'SESSION_CHECK_ONLY' : 'LOGIN',
        ...result,
      }),
    );
    if (result.status !== 'READY') process.exitCode = 2;
  } catch (error) {
    console.error(
      JSON.stringify({
        status: 'ERROR',
        platform: recipeKey,
        accountRef: reference,
        stage,
        navigationStatusCode,
        errorCode: safeRuntimeErrorCode(error),
        errorType: error instanceof Error ? error.name : 'UnknownError',
      }),
    );
    process.exitCode = 1;
  } finally {
    record.password = '';
    record.twoFactor = '';
    await session.close();
    await proxy?.close().catch(() => undefined);
  }
}

if (require.main === module) {
  void main().catch((error: unknown) => {
    console.error(
      JSON.stringify({
        status: 'ERROR',
        errorCode: safeRuntimeErrorCode(error),
        errorType: error instanceof Error ? error.name : 'UnknownError',
      }),
    );
    process.exitCode = 1;
  });
}
