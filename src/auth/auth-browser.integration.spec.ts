import { mkdtemp, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Page } from 'playwright';
import { SessionManager } from './session-manager';
import { AuthManager } from './auth-manager';
import { AuthDetector } from './auth-detector';
import { AuthState, type PlatformAuthAdapter } from './auth.types';
import { generateTotp } from './totp-provider';
import { captureAllowedStorageState, createPrivateFileSessionStore } from './file-session-store';
import { inspectStoredSession, runXSmoke } from '../../scripts/social-auth-smoke';

// Uses an existing browser only. No browser download and no real platform traffic.
const executablePath = process.env.AUTH_TEST_CHROMIUM_EXECUTABLE_PATH;
const browserSuite = executablePath ? describe : describe.skip;
browserSuite('Auth recovery with real Chromium and synthetic HTTPS fixtures', () => {
  let directory: string;
  let session: SessionManager;
  let page: Page;
  const identity = { platform: 'fixture', account: 'account01' };
  const adapter: PlatformAuthAdapter = { allowedHosts: ['fixture.example.com'], selectors: {
    loggedIn: ['#signed-in'], otpInput: '#otp', otpSubmit: '#verify',
  } };
  const open = async (cookies: Parameters<import('playwright').BrowserContext['addCookies']>[0] = []) => {
    session = new SessionManager(join(directory, 'profiles'));
    page = await session.open(identity, { headless: true, executablePath }, cookies);
    await page.route('https://fixture.example.com/**', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<title>Fixture</title><main id="root"></main>' }));
    await page.goto('https://fixture.example.com/editor');
  };
  beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'auth-fixture-')); await open(); });
  afterEach(async () => { await session.close(); await rm(directory, { recursive: true, force: true }); });

  it('persists cookies and localStorage across Chromium restarts with the same profile', async () => {
    await session.getContext().addCookies([{ name: 'fixture-session', value: 'test-value', domain: 'fixture.example.com', path: '/', secure: true }]);
    await page.evaluate(() => localStorage.setItem('fixture-session', 'authenticated'));
    const captured = await session.getContext().cookies();
    await session.close();
    await open(captured);
    expect(await page.evaluate(() => localStorage.getItem('fixture-session'))).toBe('authenticated');
    expect((await session.getContext().cookies()).some((cookie) => cookie.name === 'fixture-session')).toBe(true);
  });
  it('runs the X identifier/password steps once, then recognizes the restored fixture session', async () => {
    const home = '<title>Home / X</title><button data-testid="SideNav_AccountSwitcher_Button">Fixture account</button><a data-testid="AppTabBar_Home_Link" href="/home">Home</a>';
    await session.getContext().route('https://x.com/**', (route) => route.fulfill({
      status: 200, contentType: 'text/html', body: new URL(route.request().url()).pathname === '/home' ? home : `
        <title>Sign in / X</title><main><h1>Sign in to X</h1><input name="text" type="text" autocomplete="username"><button id="next">Next</button></main>
        <script>document.querySelector('#next').onclick = () => {
          localStorage.setItem('identifier-count', String(Number(localStorage.getItem('identifier-count') || 0) + 1));
          document.querySelector('main').innerHTML = '<h1>Enter your password</h1><input name="password" type="password"><button id="login">Log in</button>';
          document.querySelector('#login').onclick = () => {
            localStorage.setItem('password-count', String(Number(localStorage.getItem('password-count') || 0) + 1));
            document.cookie = 'auth_token=fixture-session; Secure; Path=/; SameSite=Lax';
            location.assign('/home');
          };
        };</script>`,
    }));
    const result = await runXSmoke(session.getContext(), { rowNumber: 1, sequence: '1', platform: 'X (Twitter)', loginMethod: 'User + Password',
      user: 'fixture-user', password: 'fixture-password', twoFactor: '', loginUrl: '', profileUrl: '' }, 15000);
    expect(result).toMatchObject({ status: 'READY', authState: AuthState.AUTHENTICATED });
    const xPage = session.getContext().pages().find((candidate) => candidate.url() === 'https://x.com/home')!;
    expect(await xPage.evaluate(() => [localStorage.getItem('identifier-count'), localStorage.getItem('password-count')])).toEqual(['1', '1']);
    const store = await createPrivateFileSessionStore(join(directory, 'profiles'));
    await store.save(session.getProfilePath(), identity, await captureAllowedStorageState(session.getContext(), ['x.com']));
    const profilePath = session.getProfilePath();
    await session.close();
    await open((await store.load(profilePath, identity)).cookies);
    await session.getContext().route('https://x.com/**', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: home }));
    await page.goto('https://x.com/home');
    await expect(inspectStoredSession(page, 'x')).resolves.toMatchObject({ status: 'READY' });
  });
  it('saves a manual login and restores its session-only cookie using a fresh store instance', async () => {
    await page.locator('#root').evaluate((element) => {
      element.innerHTML = '<button id="login">Manual login fixture</button>';
      element.querySelector('#login')!.addEventListener('click', () => {
        document.cookie = 'manual-session=fixture-authenticated; Path=/; Secure; SameSite=Lax';
        localStorage.setItem('manual-account', 'fixture-account');
        element.innerHTML = '<div id="signed-in">Signed in</div>';
      });
    });
    await page.locator('#login').click();
    expect((await new AuthDetector().detectAuthState(page, adapter)).state).toBe(AuthState.AUTHENTICATED);
    const root = join(directory, 'profiles');
    const firstStore = await createPrivateFileSessionStore(root);
    await firstStore.save(session.getProfilePath(), identity,
      await captureAllowedStorageState(session.getContext(), adapter.allowedHosts));
    const profile = session.getProfilePath();
    await session.close();
    const secondStore = await createPrivateFileSessionStore(root);
    const saved = await secondStore.load(profile, identity);
    await open(saved.cookies);
    expect((await session.getContext().cookies()).find((cookie) => cookie.name === 'manual-session')?.value)
      .toBe('fixture-authenticated');
    expect(await page.evaluate(() => localStorage.getItem('manual-account'))).toBe('fixture-account');
    expect(await page.locator('#login').count()).toBe(0);
  });
  it('auto-resumes after a user completes a synthetic CAPTCHA fixture', async () => {
    await page.locator('#root').evaluate((element) => { element.innerHTML = '<h1>Verify you are human</h1><div data-sitekey="test"></div>'; });
    const notify = jest.fn((message: string) => {
      if (message.includes('Trình duyệt đang mở')) {
        void page.locator('#root').evaluate((element) => { element.innerHTML = '<div id="signed-in">Signed in</div>'; });
      }
    });
    const manager = new AuthManager(new AuthDetector(), notify, jest.fn());
    const result = await manager.ensureAuthenticated({ ...identity, adapter, getPage: () => page,
      makeVisible: () => Promise.resolve(), verifyOwnership: () => Promise.resolve(true), interactive: true,
      timeout: 5000, captchaTimeout: 5000,
    });
    expect(result.authenticated).toBe(true);
  });
  it('submits a manually supplied OTP once and resumes after a verified fixture response', async () => {
    await page.locator('#root').evaluate((element) => {
      element.innerHTML = '<h1>Two-factor authentication</h1><input id="otp" autocomplete="one-time-code"><button id="verify">Verify</button>';
      element.querySelector('#verify')!.addEventListener('click', () => {
        if ((element.querySelector('#otp') as HTMLInputElement).value === '123456') element.innerHTML = '<div id="signed-in">Signed in</div>';
      });
    });
    const log = jest.fn();
    const manager = new AuthManager(new AuthDetector(), jest.fn(), log, () => Promise.resolve('123456'));
    expect((await manager.ensureAuthenticated({ ...identity, adapter, getPage: () => page,
      makeVisible: () => Promise.resolve(), verifyOwnership: () => Promise.resolve(true), interactive: true,
      timeout: 5000, captchaTimeout: 5000,
    })).authenticated).toBe(true);
    expect(JSON.stringify(log.mock.calls)).not.toContain('123456');
  });
  it('captures only a masked private screenshot on unknown auth failure', async () => {
    await page.locator('#root').evaluate((element) => { element.innerHTML = '<input type="password" value="test-password"><input id="otp" value="123456"><pre>test-token</pre>'; });
    const screenshot = jest.spyOn(page, 'screenshot');
    const manager = new AuthManager(new AuthDetector(), jest.fn(), jest.fn());
    const result = await manager.ensureAuthenticated({ ...identity, adapter, getPage: () => page,
      makeVisible: () => Promise.resolve(), verifyOwnership: () => Promise.resolve(true), interactive: false,
      screenshotDir: join(directory, 'screenshots'),
    });
    expect(result.authenticated).toBe(false);
    expect(result.screenshot).toMatch(/\.png$/);
    expect((await stat(result.screenshot!)).mode & 0o777).toBe(0o600);
    expect(screenshot).toHaveBeenCalledWith(expect.objectContaining({ mask: expect.any(Array) as unknown }));
    expect(result.state).toBe(AuthState.TWO_FACTOR_REQUIRED);
  });
  it('ignores draft text mentioning challenges in the editor', async () => {
    await page.locator('#root').evaluate((element) => {
      element.innerHTML = '<form action="/post"><textarea>CAPTCHA verification code security check</textarea><div contenteditable>verify your email</div></form><div id="signed-in">Signed in</div>';
    });
    expect(await new AuthDetector().detectAuthState(page, adapter)).toEqual({ state: AuthState.AUTHENTICATED });
  });

  it('generates an owner-configured TOTP and resumes publishing in a headless fixture', async () => {
    await page.locator('#root').evaluate((element) => {
      element.innerHTML = '<h1>Authenticator code</h1><input id="otp" autocomplete="one-time-code"><button id="verify">Verify</button>';
      element.querySelector('#verify')!.addEventListener('click', () => {
        if ((element.querySelector('#otp') as HTMLInputElement).value === '050471') {
          element.innerHTML = '<div id="signed-in">Signed in</div><textarea id="post"></textarea><button id="publish">Publish fixture</button>';
          element.querySelector('#publish')!.addEventListener('click', () => {
            element.innerHTML = '<div id="published">Fixture post published</div>';
          });
        }
      });
    });
    const log = jest.fn();
    // Public RFC 6238 vector, not a real account seed; no external verification service.
    const otpProvider = () => Promise.resolve(generateTotp('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', 1111111111000));
    const makeVisible = jest.fn();
    const manager = new AuthManager(new AuthDetector(), jest.fn(), log);
    const result = await manager.ensureAuthenticated({ ...identity, adapter, getPage: () => page,
      makeVisible, verifyOwnership: () => Promise.resolve(true), interactive: false, otpProvider,
      timeout: 5000, captchaTimeout: 5000,
    });
    expect(result.authenticated).toBe(true);
    expect(makeVisible).not.toHaveBeenCalled();
    expect(JSON.stringify(log.mock.calls)).not.toContain('050471');
    await page.locator('#post').fill('Synthetic test content');
    await page.locator('#publish').click();
    expect(await page.locator('#published').isVisible()).toBe(true);
  });
});
