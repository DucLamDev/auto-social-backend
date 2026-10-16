import {
  accountReference,
  authRecordsFromTsv,
  generateTotp,
  inspectStoredSession,
  inspectUnverifiedLogin,
  parseOptions,
  parseTsv,
  safeRuntimeErrorCode,
  waitForXStoredSession,
} from './social-auth-smoke';
import type { Page } from 'playwright';
import { AuthState } from '../src/auth/auth.types';
import { AuthDetector } from '../src/auth/auth-detector';

describe('social auth smoke helpers', () => {
  it('waits for delayed X account UI before rejecting a saved session, without filling credentials', async () => {
    let polls = 0;
    const waitForTimeout = jest.fn(() => {
      polls++;
      return Promise.resolve();
    });
    const page = {
      url: () => 'https://x.com/home',
      title: () => Promise.resolve('Home / X'),
      isClosed: () => false,
      context: () => ({
        cookies: () => Promise.resolve([{ name: 'auth_token', value: 'fixture-only' }]),
      }),
      waitForTimeout,
      locator: (selector: string) => ({
        count: () => Promise.resolve(polls >= 2 && selector.includes('data-testid') ? 1 : 0),
        nth: () => ({ isVisible: () => Promise.resolve(true) }),
        allInnerTexts: () => Promise.resolve([]),
      }),
    } as unknown as Page;
    await expect(waitForXStoredSession(page, 10000)).resolves.toMatchObject({ status: 'READY' });
    expect(waitForTimeout).toHaveBeenCalledTimes(2);
    expect(waitForTimeout).toHaveBeenCalledWith(1500);
  });
  it('supports manual X login and a stable session check without a CSV or credential', () => {
    const login = parseOptions([
      '--platform',
      'x',
      '--manual-login',
      '--account-label',
      'account02',
    ]);
    const check = parseOptions([
      '--platform',
      'x',
      '--inspect-session',
      '--account-label',
      'account02',
    ]);
    expect(login).toMatchObject({
      authFile: undefined,
      manualLogin: true,
      executeLiveLogin: true,
      accountLabel: 'account02',
    });
    expect(check).toMatchObject({
      authFile: undefined,
      inspectSession: true,
      executeLiveLogin: true,
      accountLabel: 'account02',
    });
    expect(() => parseOptions(['--platform', 'x', '--execute-live-login'])).toThrow(
      'CLI_REQUIRED_OPTION_MISSING',
    );
    expect(() => parseOptions(['--platform', 'instagram', '--manual-login'])).toThrow(
      'CLI_REQUIRED_OPTION_MISSING',
    );
    expect(() =>
      parseOptions(['--platform', 'x', '--manual-login', '--account-label', '../other']),
    ).toThrow('CLI_ACCOUNT_LABEL_INVALID');
    expect(() =>
      parseOptions(['--auth-file', 'fixture.csv', '--platform', 'x', '--execute-live-login']),
    ).toThrow('CLI_ACCOUNT_REF_REQUIRED');
  });
  it.each([
    [false, true, false, false],
    [true, false, false, false],
    [true, true, true, false],
    [true, true, false, true],
  ])(
    'requires an X auth cookie, account UI, and no password prompt: %s/%s/%s',
    async (cookie, accountUi, password, ready) => {
      const context = {
        cookies: () =>
          Promise.resolve(cookie ? [{ name: 'auth_token', value: 'fixture-only' }] : []),
      };
      const page = {
        url: () => 'https://x.com/home',
        title: () => Promise.resolve('Home / X'),
        context: () => context,
        locator: (selector: string) => ({
          count: () =>
            Promise.resolve(
              (accountUi && selector.includes('data-testid')) ||
                (password && selector.includes('password'))
                ? 1
                : 0,
            ),
          nth: () => ({ isVisible: () => Promise.resolve(true) }),
        }),
      } as unknown as Page;
      const result = await inspectStoredSession(page, 'x');
      expect(Boolean(result)).toBe(ready);
      if (ready)
        expect(result).toMatchObject({ status: 'READY', authState: AuthState.AUTHENTICATED });
    },
  );
  it.each([
    [{ state: AuthState.UNKNOWN_AUTH_CHALLENGE }, 'SESSION_NOT_VERIFIED'],
    [{ state: AuthState.LOGIN_REQUIRED }, 'SESSION_NOT_VERIFIED'],
    [{ state: AuthState.DEVICE_CONFIRMATION_REQUIRED }, 'CHALLENGE_REQUIRES_HUMAN'],
    [{ state: AuthState.UNKNOWN_AUTH_CHALLENGE, failure: 'REJECTED' }, 'LOGIN_REJECTED'],
    [{ state: AuthState.UNKNOWN_AUTH_CHALLENGE, failure: 'LOCKED' }, 'ACCOUNT_LOCKED'],
  ])(
    'distinguishes inconclusive login evidence from an explicit rejection: %s',
    async (detection, status) => {
      const page = {
        url: () => 'https://accounts.google.com/signin?private-fixture=hidden',
      } as unknown as Page;
      const detector = {
        detectAuthState: jest.fn().mockResolvedValue(detection),
      } as unknown as AuthDetector;
      await expect(
        inspectUnverifiedLogin(page, ['accounts.google.com'], detector),
      ).resolves.toMatchObject({ status, url: 'https://accounts.google.com' });
    },
  );
  it('classifies network failures without returning private error messages', () => {
    const error = new Error(
      'page.goto: net::ERR_CONNECTION_RESET at https://example.com/?token=private-fixture',
    );
    expect(safeRuntimeErrorCode(error)).toBe('BROWSER_ERR_CONNECTION_RESET');
    expect(safeRuntimeErrorCode(new Error('filled private-password'))).toBe(
      'UNEXPECTED_RUNTIME_ERROR',
    );
    const timeout = new Error('private-fixture');
    timeout.name = 'TimeoutError';
    expect(safeRuntimeErrorCode(timeout)).toBe('BROWSER_TIMEOUT');
  });
  it('keeps a profile identity stable when CSV order or a profile URL changes', () => {
    const record = {
      rowNumber: 2,
      sequence: '1',
      platform: 'dev.to',
      loginUrl: '',
      loginMethod: 'Gmail / Google Auth',
      user: 'fixture-user',
      password: '',
      twoFactor: '',
      profileUrl: 'https://dev.to/old',
    };
    expect(accountReference(record)).toBe(
      accountReference({
        ...record,
        rowNumber: 42,
        sequence: '99',
        profileUrl: 'https://dev.to/new',
      }),
    );
    expect(accountReference(record)).not.toBe(
      accountReference({ ...record, user: 'different-fixture' }),
    );
  });

  it('requires authenticated account UI before treating a stored DEV editor as ready', async () => {
    let hasAccountUi = false;
    const locator = (selector: string) => ({
      count: () =>
        Promise.resolve(
          selector.includes('article') || (hasAccountUi && selector.includes('nav-profile'))
            ? 1
            : 0,
        ),
      nth: () => ({ isVisible: () => Promise.resolve(true) }),
    });
    const page = {
      url: () => 'https://dev.to/new',
      title: () => Promise.resolve('New post'),
      locator,
    } as unknown as Page;
    await expect(inspectStoredSession(page, 'devto')).resolves.toBeUndefined();
    hasAccountUi = true;
    await expect(inspectStoredSession(page, 'devto')).resolves.toMatchObject({ status: 'READY' });
  });
  it('parses tab-delimited records with quoted tabs, quotes, and newlines', () => {
    const source = ['A\tB\tC', '1\t"two\tparts"\t"line one', 'line ""two"""', '2\tplain\t'].join(
      '\r\n',
    );

    expect(parseTsv(source)).toEqual([
      ['A', 'B', 'C'],
      ['1', 'two\tparts', 'line one\r\nline "two"'],
      ['2', 'plain', ''],
    ]);
  });

  it('loads the expected auth columns without exposing optional trailing cells', () => {
    const source = [
      'STT\tSocial Network\tURL Đăng nhập\tPhương thức Login\tUser\tPass\t2fa\tURL Profile\tIndex\tMô tả Nền tảng',
      '1\tdev.to\thttps://dev.to/enter\tGmail / Google Auth\tuser-value\t" pass-value "\tTOTP-VALUE\thttps://dev.to/profile\t\t"multi',
      'line"',
      '2\t\t\t\t\t\t\t\t\t',
    ].join('\n');

    const records = authRecordsFromTsv(source);

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      sequence: '1',
      platform: 'dev.to',
      loginUrl: 'https://dev.to/enter',
      loginMethod: 'Gmail / Google Auth',
      user: 'user-value',
      password: ' pass-value ',
      twoFactor: 'TOTP-VALUE',
      profileUrl: 'https://dev.to/profile',
    });
  });

  it('accepts the mojibake header names produced by the supplied TSV export', () => {
    const source = [
      'STT\tSocial Network\tURL ??ng nh?p\tPh??ng th?c Login\tUser\tPass\t2fa\tURL Profile\tIndex\tMô Tả Nền tảng',
      '1\tdev.to\thttps://dev.to/enter\tGmail / Google Auth\tuser-value\tpass-value\t\t\t\t',
    ].join('\n');

    expect(authRecordsFromTsv(source)).toHaveLength(1);
  });

  it('matches the RFC 6238 SHA-1 test vector', () => {
    expect(
      generateTotp(
        {
          secret: '',
          algorithm: 'sha1',
          digits: 8,
          period: 30,
        },
        59_000,
      ),
    ).toBe('94287082');
  });

  it('rejects records wider than the declared header', () => {
    const source = [
      'STT\tSocial Network\tURL Login\tLogin\tUser\tPass\t2fa\tURL Profile',
      '1\tdev.to\thttps://dev.to\tEmail\tuser\tpass\t\t\textra-cell',
    ].join('\n');

    expect(() => authRecordsFromTsv(source)).toThrow('AUTH_FILE_ROW_TOO_WIDE');
  });
});
