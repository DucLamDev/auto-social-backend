import { createHash, createHmac, type BinaryLike } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from 'playwright';
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
  authFile: string;
  platform: string;
  ordinal: number;
  accountRef?: string;
  executeLiveLogin: boolean;
  headless: boolean;
  requireTwoFactor: boolean;
  timeoutMs: number;
}

interface SmokeResult {
  phase: 'login-page' | 'authentication' | 'editor';
  status:
    | 'READY'
    | 'CHALLENGE_REQUIRES_HUMAN'
    | 'EDITOR_NOT_FOUND'
    | 'FORM_NOT_FOUND'
    | 'LOGIN_REJECTED'
    | 'TWO_FACTOR_REJECTED'
    | 'TWO_FACTOR_REQUIRED';
  url: string;
  statusCode?: number;
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

const DEV_TO_ALIASES = new Set(['dev.to', 'devto']);
const DEV_TO_HOSTS = new Set(['dev.to']);
const INSTAGRAM_ALIASES = new Set(['instagram']);
const INSTAGRAM_HOSTS = new Set(['www.instagram.com']);
const THREADS_ALIASES = new Set(['threads']);
const THREADS_HOSTS = new Set(['www.threads.com']);
const MAX_AUTH_FILE_BYTES = 1_000_000;
const MAX_AUTH_RECORDS = 1_000;
const MAX_AUTH_FIELD_CHARACTERS = 65_536;

type SmokeRecipeKey = 'devto' | 'instagram' | 'threads';

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

function parseOptions(args: readonly string[]): CliOptions {
  const authFile = optionValue(args, '--auth-file');
  const platform = optionValue(args, '--platform');
  if (!authFile || !platform) throw new SafeCliError('CLI_REQUIRED_OPTION_MISSING');
  const accountRef = optionValue(args, '--account-ref');
  const executeLiveLogin = args.includes('--execute-live-login');
  if (executeLiveLogin && (!accountRef || !/^[a-f\d]{12}$/i.test(accountRef))) {
    throw new SafeCliError('CLI_ACCOUNT_REF_REQUIRED');
  }
  return {
    authFile: resolve(authFile),
    platform,
    ordinal: positiveInteger(optionValue(args, '--ordinal'), 1, 1_000),
    accountRef,
    executeLiveLogin,
    headless: args.includes('--headless'),
    requireTwoFactor: args.includes('--require-2fa'),
    timeoutMs: positiveInteger(optionValue(args, '--timeout-ms'), 60_000, 120_000),
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
  throw new SafeCliError('PLATFORM_RECIPE_NOT_REVIEWED');
}

function recipeAliases(recipeKey: SmokeRecipeKey): ReadonlySet<string> {
  if (recipeKey === 'devto') return DEV_TO_ALIASES;
  if (recipeKey === 'instagram') return INSTAGRAM_ALIASES;
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
    recipeKey === 'devto' ? method === 'gmail / google auth' : method === 'user + password';
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
    return {
      phase: 'authentication',
      status: 'LOGIN_REJECTED',
      url: safePageUrl(page.url()),
    };
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
    return {
      phase: 'authentication',
      status: 'LOGIN_REJECTED',
      url: safePageUrl(page.url()),
    };
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
    return {
      phase: 'authentication',
      status: 'LOGIN_REJECTED',
      url: safePageUrl(page.url()),
    };
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

function accountReference(record: AuthRecord): string {
  const input: BinaryLike = [
    record.rowNumber,
    record.sequence,
    record.platform,
    record.loginMethod,
    record.user,
    record.profileUrl,
  ].join('\u0000');
  return createHash('sha256').update(input).digest('hex').slice(0, 12);
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const file = await stat(options.authFile);
  if (!file.isFile() || file.size > MAX_AUTH_FILE_BYTES) {
    throw new SafeCliError('AUTH_FILE_SIZE_INVALID');
  }
  const source = await readFile(options.authFile, 'utf8');
  const recipeKey = recipeKeyForPlatform(options.platform);
  const record = selectRecord(authRecordsFromTsv(source), options, recipeKey);
  assertSupportedLoginMethod(record, recipeKey);
  const host =
    recipeKey === 'devto'
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
    recipeKey === 'devto'
      ? ['dev.to', 'accounts.google.com']
      : recipeKey === 'instagram'
        ? ['instagram.com']
        : ['threads.com', 'instagram.com'];
  const networkGuard = new BrowserNetworkGuard();
  let proxy: BrowserNetworkProxy | undefined;
  let browser: Browser | undefined;
  try {
    proxy = await networkGuard.startProxy();
    browser = await chromium.launch({
      headless: options.headless,
      proxy: { server: proxy.server },
      args: ['--disable-dev-shm-usage', ...proxy.chromiumArgs],
    });
    const context = await browser.newContext({
      acceptDownloads: false,
      serviceWorkers: 'block',
    });
    await networkGuard.install(context, allowedHosts);
    context.setDefaultTimeout(Math.min(options.timeoutMs, 30_000));
    const result =
      recipeKey === 'devto'
        ? await runDevToSmoke(context, record, options.timeoutMs)
        : recipeKey === 'instagram'
          ? await runInstagramSmoke(context, record, options.timeoutMs)
          : await runThreadsSmoke(context, record, options.timeoutMs);
    console.log(
      JSON.stringify({
        platform: recipeKey,
        accountRef: reference,
        host,
        ...result,
      }),
    );
    if (result.status !== 'READY') process.exitCode = 2;
  } finally {
    await browser?.close().catch(() => undefined);
    await proxy?.close().catch(() => undefined);
  }
}

if (require.main === module) {
  void main().catch((error: unknown) => {
    console.error(
      JSON.stringify({
        status: 'ERROR',
        errorCode: error instanceof SafeCliError ? error.code : 'UNEXPECTED_RUNTIME_ERROR',
        errorType: error instanceof Error ? error.name : 'UnknownError',
      }),
    );
    process.exitCode = 1;
  });
}
