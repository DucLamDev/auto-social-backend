import 'reflect-metadata';
import { mkdir, chmod, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { AuthDetector } from '../src/auth/auth-detector';
import { AuthManager } from '../src/auth/auth-manager';
import { AuthState } from '../src/auth/auth.types';
import { SessionManager } from '../src/auth/session-manager';
import { vozAuthSelectors } from '../src/platforms/voz-forums/auth.selectors';
import { BrowserNetworkGuard } from '../src/connectors/browser/browser-network-guard.service';
import { assertPublicBrowserUrl } from '../src/connectors/browser/browser-navigation-safety';
import { assertChromiumInstalled } from '../src/connectors/browser/browser-chromium';

/** Anonymous GET-only live probe. Never imports application config, loads account
 * credentials, submits forms, solves a challenge, or writes to the database. */
async function main(): Promise<void> {
  const target = 'https://voz.vn/login/';
  const allowedHosts = ['voz.vn'];
  const identity = { platform: 'voz-forums', account: 'live-smoke-anonymous' };
  const artifactRoot = resolve('tmp/auth-live-smoke');
  const session = new SessionManager(resolve(artifactRoot, 'profiles'));
  const guard = new BrowserNetworkGuard();
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
  await mkdir(artifactRoot, { recursive: true, mode: 0o700 });
  await chmod(artifactRoot, 0o700);
  let proxy: Awaited<ReturnType<BrowserNetworkGuard['startProxy']>> | undefined;
  try {
    await assertChromiumInstalled(executablePath);
    await assertPublicBrowserUrl(target, allowedHosts);
    proxy = await guard.startProxy();
    const page = await session.open(identity, { headless: true,
      ...(executablePath ? { executablePath } : { channel: 'chromium' }),
      proxy: { server: proxy.server }, args: ['--disable-dev-shm-usage', ...proxy.chromiumArgs],
      timeout: 30_000,
    });
    const context = session.getContext();
    context.setDefaultTimeout(5000);
    context.setDefaultNavigationTimeout(30_000);
    await guard.install(context, allowedHosts);
    const submittedRequests: string[] = [];
    // A smoke probe can only GET/HEAD; even page-initiated state-changing requests are blocked.
    await context.route('**/*', async (route) => {
      if (!['GET', 'HEAD'].includes(route.request().method())) {
        submittedRequests.push(route.request().method());
        await route.abort('blockedbyclient');
      } else await route.fallback();
    });
    const response = await page.goto(target, { waitUntil: 'domcontentloaded' });
    // Let ordinary navigation/DOM settle once, without retrying the challenge or changing identity.
    await page.waitForTimeout(1500);
    const adapter = { allowedHosts, selectors: vozAuthSelectors };
    const detected = await new AuthDetector().detectAuthState(page, adapter);
    const manager = new AuthManager();
    const result = await manager.ensureAuthenticated({ ...identity, adapter,
      getPage: () => page, interactive: false, skipAuthBlocked: true,
      // Dedicated anonymous probe runs once in this process; no backend account lease is tested here.
      verifyOwnership: () => Promise.resolve(true),
      makeVisible: () => Promise.reject(new Error('Anonymous smoke must stay read-only/headless')),
      timeout: 10_000, captchaTimeout: 10_000,
      screenshotDir: resolve(artifactRoot, 'screenshots'),
    });
    const passed = !result.authenticated && result.reason === 'SKIPPED'
      && [AuthState.LOGIN_REQUIRED, AuthState.CAPTCHA_REQUIRED, AuthState.TWO_FACTOR_REQUIRED,
        AuthState.EMAIL_VERIFICATION_REQUIRED, AuthState.DEVICE_CONFIRMATION_REQUIRED, AuthState.SESSION_EXPIRED].includes(detected.state);
    const report = {
      timestamp: new Date().toISOString(), case: 'live-anonymous-login-required',
      target, httpStatus: response?.status() ?? null,
      fixture: false, accountCredentialsUsed: false, backendLeaseTested: false,
      authenticated: result.authenticated, detectedState: detected.state,
      recoveryReason: result.reason, runtimeState: result.runtimeState,
      screenshot: result.screenshot ?? null, blockedNonReadRequests: submittedRequests.length,
      result: passed ? 'PASS' : 'INCONCLUSIVE',
    };
    await writeFile(resolve(artifactRoot, 'report.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
    console.log(JSON.stringify(report, null, 2));
    if (!passed) process.exitCode = 1;
  } catch (error) {
    console.error(JSON.stringify({ case: 'live-anonymous-login-required', result: 'FAILED',
      errorType: error instanceof Error ? error.name : 'UnknownError',
      // Omit raw network/Playwright details; they can contain session data.
      message: 'Không hoàn thành live probe; kiểm tra runtime/network. Không có thao tác login hoặc publish.',
    }));
    process.exitCode = 1;
  } finally {
    await session.close();
    await proxy?.close();
  }
}

void main();
