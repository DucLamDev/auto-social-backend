import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  chromium,
  type Browser,
  type BrowserContext,
  type BrowserContextOptions,
  type Page,
} from 'playwright';
import { sha256 } from '../../common/utils/crypto.utils';
import { RedisService } from '../../queue/redis.service';
import { RedisLockLease } from '../../queue/redis-lock-lease';
import { ConnectorAccount, PostPayload } from '../core/connector.types';
import {
  BrowserAutomationResult,
  BrowserChallenge,
  BrowserConnectionInspection,
  BrowserPublishRecipe,
} from './browser-automation.types';
import { BrowserChallengeDetector } from './browser-challenge.detector';
import { assertChromiumInstalled, BrowserRuntimeUnavailableError } from './browser-chromium';
import {
  BrowserProfileSettingError,
  browserContextOptions,
  browserProxyName,
  resolveBrowserContextProfile,
} from './browser-context-profile';
import {
  beginBrowserTrace,
  captureBrowserDiagnostics,
  discardBrowserTrace,
  type BrowserDiagnosticsArtifact,
} from './browser-diagnostics';
import { assertPublicBrowserUrl, safeBrowserActionUrl } from './browser-navigation-safety';
import { BrowserSessionStateStore } from './browser-session-state.store';
import {
  BrowserNetworkGuard,
  BrowserProxyConfigurationError,
  type BrowserNetworkProxy,
} from './browser-network-guard.service';
import { BrowserMediaPreparationService } from './browser-media-preparation.service';
import { BrowserSubmissionAuthorizationService } from './browser-submission-authorization.service';
import { AuthManager } from '../../auth/auth-manager';
import { AuthDetector } from '../../auth/auth-detector';
import { AuthState, AccountRuntimeState } from '../../auth/auth.types';
import { SessionManager } from '../../auth/session-manager';
import { browserAuthAdapter } from '../../platforms/browser-auth.adapter';
import { createAccountTotpProvider } from '../../auth/totp-provider';

export interface BrowserRunOptions {
  interactive?: boolean;
  skipAuthBlocked?: boolean;
  signal?: AbortSignal;
  /** Login must report failure if its encrypted session snapshot cannot be saved. */
  requireSessionSave?: boolean;
  /** Set only by an explicit login operation, never by automatic publishing recovery. */
  allowSessionReactivation?: boolean;
}

@Injectable()
export class BrowserAutomationService {
  readonly authManager = new AuthManager();
  private readonly recoveryEnabled: boolean;
  private readonly profilesDir: string;
  private readonly authTimeout: number;
  private readonly captchaTimeout: number;
  private readonly authAttempts: number;
  private readonly authScreenshotsDir: string;
  private readonly readTotpSecret: (name: string) => unknown;
  private readonly logger = new Logger(BrowserAutomationService.name);
  private readonly enabled: boolean;
  private readonly headless: boolean;
  private readonly timeoutMs: number;
  private readonly executablePath?: string;
  private readonly diagnosticsEnabled: boolean;
  private readonly diagnosticsDir?: string;
  private readonly diagnosticsRetentionHours: number;

  /** NEEDS_ACTION reasons where on-disk failure evidence helps an operator. */
  private static readonly DIAGNOSTIC_REASONS: ReadonlySet<string> = new Set([
    'EDITOR_NOT_FOUND',
    'SUBMISSION_UNCERTAIN',
    'AUTOMATION_FAILED',
    'CAPTCHA_REQUIRED',
    'SECURITY_CHECK_REQUIRED',
  ]);

  constructor(
    config: ConfigService,
    private readonly sessions: BrowserSessionStateStore,
    private readonly challenges: BrowserChallengeDetector,
    private readonly redis: RedisService,
    private readonly networkGuard: BrowserNetworkGuard,
    private readonly media: BrowserMediaPreparationService,
    private readonly submitAuthorization: BrowserSubmissionAuthorizationService,
  ) {
    this.recoveryEnabled = config.get<boolean>('BROWSER_AUTH_RECOVERY_ENABLED', false);
    this.readTotpSecret = (name) => config.get<unknown>(name);
    this.profilesDir = config.get<string>('BROWSER_PROFILES_DIR', 'profiles');
    this.authTimeout = config.get<number>('AUTH_WAIT_TIMEOUT', 300_000);
    this.captchaTimeout = config.get<number>('CAPTCHA_WAIT_TIMEOUT', 300_000);
    this.authAttempts = config.get<number>('MAX_AUTH_ATTEMPTS', 3);
    this.authScreenshotsDir = config.get<string>('AUTH_SCREENSHOTS_DIR', 'logs/screenshots');
    this.enabled = config.get<boolean>('BROWSER_AUTOMATION_ENABLED', false);
    this.headless = config.get<boolean>('BROWSER_AUTOMATION_HEADLESS', true);
    this.timeoutMs = config.get<number>('BROWSER_AUTOMATION_TIMEOUT_MS', 90_000);
    this.executablePath = config.get<string>('PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH') || undefined;
    this.diagnosticsEnabled = config.get<boolean>('BROWSER_DIAGNOSTICS_ENABLED', true);
    this.diagnosticsDir = config.get<string>('BROWSER_DIAGNOSTICS_DIR') || undefined;
    this.diagnosticsRetentionHours = config.get<number>('BROWSER_DIAGNOSTICS_RETENTION_HOURS', 72);
  }

  async publish(
    account: ConnectorAccount,
    post: PostPayload,
    recipe: BrowserPublishRecipe,
    options: BrowserRunOptions = {},
  ): Promise<BrowserAutomationResult> {
    if (!this.enabled) {
      return this.needsAction(
        'AUTOMATION_DISABLED',
        'Browser automation is disabled by the server configuration',
        recipe.startUrl(account),
      );
    }
    return this.withSession(account, recipe, async (initialPage, lease, recover) => {
      let page = initialPage;
      const challenge = await this.detectChallenge(page, recipe);
      if (challenge) return this.challengeResult(challenge, page.url());
      if (!(await recipe.isEditorReady(page))) {
        return this.needsAction(
          'EDITOR_NOT_FOUND',
          'The platform editor changed or is unavailable; the automation did not submit anything',
          page.url(),
        );
      }
      return this.media.withPreparedImages(recipe, post, async (mediaFiles) => {
        try {
          await recipe.prepare({ account, page, post, mediaFiles });
        } catch {
          return this.needsAction(
            'EDITOR_NOT_FOUND',
            'The platform editor could not be prepared; the automation did not submit anything',
            page.url(),
          );
        }
        const challengeAfterPreparation = await this.detectChallenge(page, recipe);
        if (challengeAfterPreparation) {
          if (!recover) return this.challengeResult(challengeAfterPreparation, page.url());
          const recovered = await recover();
          if ('status' in recovered) return recovered;
          page = recovered;
          // Challenge navigation/relaunch can discard the draft. Re-prepare once, before submit.
          await recipe.prepare({ account, page, post, mediaFiles });
          const repeated = await this.detectChallenge(page, recipe);
          if (repeated) return this.challengeResult(repeated, page.url());
        }
        if (
          recipe.finalSubmitPolicy === 'AUTOMATED' &&
          recipe.requiresAutomationPermissionAttestation &&
          account.settings.automationPermissionAttested !== true
        ) {
          return this.needsAction(
            'SUBMISSION_CONFIRMATION_REQUIRED',
            'The account owner or administrator must explicitly attest that this platform permits browser automation before final submission',
            page.url(),
          );
        }
        if (
          recipe.finalSubmitPolicy === 'HUMAN_REQUIRED' ||
          account.settings.browserAutoSubmit !== true
        ) {
          return this.needsAction(
            'SUBMISSION_CONFIRMATION_REQUIRED',
            recipe.finalSubmitPolicy === 'HUMAN_REQUIRED'
              ? 'The platform policy requires the account owner to perform the final publish action'
              : 'The account is configured to pause before the final publish action',
            page.url(),
          );
        }
        if (!await lease.verify()) {
          return this.needsAction(
            'AUTOMATION_BUSY',
            'Browser session ownership changed before submission; nothing was submitted',
            page.url(),
          );
        }
        const authorization = await this.submitAuthorization.inspect(account.id, recipe.key);
        if (!authorization.authorized) {
          if (authorization.reason === 'LOGIN_REQUIRED') {
            return {
              ...this.needsAction(authorization.reason, authorization.message, page.url()),
              accountReconnectRequired: authorization.reconnectRequired === true,
              challengeKind: 'LOGIN_REQUIRED' as const,
            };
          }
          return this.needsAction(authorization.reason, authorization.message, page.url());
        }
        // Authorization can involve database and credential reads. Re-check
        // the token-owned lease after that work, immediately before the first
        // provider-side effect, so an old browser owner cannot submit after a
        // replacement worker has acquired this account session.
        if (!await lease.verify()) {
          return this.needsAction(
            'AUTOMATION_BUSY',
            'Browser session ownership changed before submission; nothing was submitted',
            page.url(),
          );
        }
        try {
          const result = await recipe.submit({ account, page, post, mediaFiles });
          return {
            status: 'PUBLISHED',
            externalId: result.externalId,
            url: result.url,
            metadata: { ...(result.metadata ?? {}), browserRecipe: recipe.key },
          };
        } catch {
          // Once a recipe enters submit(), a click may already have crossed the
          // provider boundary. Never retry automatically or claim it failed.
          const challengeAfterSubmit = await this.detectChallenge(page, recipe).catch(() => undefined);
          return {
            ...this.needsAction(
              'SUBMISSION_UNCERTAIN',
              challengeAfterSubmit
                ? 'The final browser submission could not be verified and the platform requested account verification; check the platform and reconnect before retrying'
                : 'The final browser submission could not be verified; check the platform before retrying',
              page.url(),
            ),
            ...(challengeAfterSubmit
              ? {
                  accountReconnectRequired: true,
                  challengeKind: challengeAfterSubmit.kind,
                }
              : {}),
            reconciliationRequired: true,
            submissionUncertain: true,
          };
        }
      });
    }, options);
  }

  async login(account: ConnectorAccount, recipe: BrowserPublishRecipe, options: BrowserRunOptions = {}): Promise<BrowserConnectionInspection> {
    return this.inspect(account, recipe, { ...options, interactive: true, requireSessionSave: true, allowSessionReactivation: true });
  }

  async inspect(
    account: ConnectorAccount,
    recipe: BrowserPublishRecipe,
    options: BrowserRunOptions = { skipAuthBlocked: true },
  ): Promise<BrowserConnectionInspection> {
    if (!this.enabled) {
      return {
        ready: false,
        actionUrl: safeBrowserActionUrl(recipe.startUrl(account)),
        message: 'Browser automation is disabled by the server configuration',
      };
    }
    const result = await this.withSession(account, recipe, async (page) => {
      const challenge = await this.detectChallenge(page, recipe);
      if (challenge) {
        return {
          ready: false,
          challenge,
          actionUrl: safeBrowserActionUrl(page.url()),
          message: challenge.message,
        };
      }
      const ready = await recipe.isEditorReady(page);
      return {
        ready,
        actionUrl: safeBrowserActionUrl(page.url()),
        message: ready
          ? 'The encrypted browser session is signed in and the editor is ready'
          : 'The expected editor was not found; the platform UI may have changed',
      };
    }, options);
    if ('status' in result) {
      return {
        ready: false,
        actionUrl: result.actionUrl,
        message: result.message,
        ...(result.challengeKind
          ? {
              challenge: {
                kind: result.challengeKind,
                message: result.message,
              },
            }
          : {}),
      };
    }
    return result;
  }

  private async withSession<T>(
    account: ConnectorAccount,
    recipe: BrowserPublishRecipe,
    operation: (page: Page, lease: RedisLockLease, recover?: () => Promise<Page | ReturnType<BrowserAutomationService['needsAction']>>) => Promise<T>,
    options: BrowserRunOptions = {},
  ): Promise<T | ReturnType<BrowserAutomationService['needsAction']>> {
    const lockKey = `lock:browser-session:${sha256(account.id)}`;
    const lockTtlMs = this.timeoutMs + 30_000;
    const lock = await this.redis.acquireLock(lockKey, lockTtlMs);
    if (!lock) {
      return this.needsAction(
        'AUTOMATION_BUSY',
        'Another browser task is already using this platform account',
        recipe.startUrl(account),
      );
    }
    const lease = new RedisLockLease(this.redis, lockKey, lock, lockTtlMs, {
      onLost: () => {
        this.logger.error(JSON.stringify({
          platformAccountId: account.id,
          browserRecipe: recipe.key,
          event: 'BROWSER_SESSION_LOCK_LEASE_LOST',
        }));
      },
      onCallbackError: (error) => {
        this.logger.warn(JSON.stringify({
          platformAccountId: account.id,
          browserRecipe: recipe.key,
          event: 'BROWSER_SESSION_LOCK_RENEWAL_ERROR',
          errorType: error instanceof Error ? error.name : 'UnknownError',
        }));
      },
    });
    lease.start();

    let browser: Browser | undefined;
    let context: BrowserContext | undefined;
    let networkProxy: BrowserNetworkProxy | undefined;
    let page: Page | undefined;
    let traceStarted = false;
    let persistRefreshedState = false;
    const persistent = this.recoveryEnabled ? new SessionManager(this.profilesDir) : undefined;
    const interactive = options.interactive ?? (process.stdin.isTTY === true && process.stdout.isTTY === true);
    try {
      const startUrl = recipe.startUrl(account);
      await assertPublicBrowserUrl(startUrl, recipe.allowedHosts);
      let state;
      try {
        state = await this.sessions.load(account.id, account.credentials.storageState);
      } catch {
        return this.challengeResult(
          {
            kind: 'LOGIN_REQUIRED',
            message: 'The encrypted browser session is missing or invalid; capture a new login session',
          },
          startUrl,
        );
      }
      // Same locale/timezone/viewport and egress proxy as the login capture, so
      // the owner's captured session is replayed from a consistent environment.
      const profile = resolveBrowserContextProfile(account.settings);
      const proxyName = browserProxyName(account.settings);
      // Verify the runtime before launching so a missing binary surfaces an
      // actionable message instead of a generic launch failure.
      await assertChromiumInstalled(this.executablePath);
      networkProxy = await this.networkGuard.startProxy(proxyName);
      const launchOptions = {
        headless: interactive && !options.skipAuthBlocked ? false : this.headless,
        timeout: Math.min(this.timeoutMs, 60_000),
        // The full Chromium build in new headless mode: the same engine and
        // binary as the headed login capture (and as the preflight checks),
        // instead of the separate headless-shell build.
        ...(this.executablePath ? { executablePath: this.executablePath } : { channel: 'chromium' }),
        proxy: { server: networkProxy.server },
        args: ['--disable-dev-shm-usage', ...networkProxy.chromiumArgs],
      };
      if (persistent) {
        page = await persistent.open({ platform: recipe.key, account: account.id }, {
          ...launchOptions, ...browserContextOptions(profile),
        }, state.cookies);
        context = persistent.getContext();
      } else {
        browser = await chromium.launch(launchOptions);
        context = await browser.newContext({
          ...browserContextOptions(profile),
          acceptDownloads: false,
          serviceWorkers: 'block',
          storageState: state as Exclude<BrowserContextOptions['storageState'], string | undefined>,
        });
      }
      context.setDefaultTimeout(Math.min(this.timeoutMs, 30_000));
      context.setDefaultNavigationTimeout(this.timeoutMs);
      await this.networkGuard.install(context, recipe.allowedHosts);
      // Recovery may handle passwords/OTP. No tracing or DOM snapshots for this entire session.
      if (this.diagnosticsEnabled && !persistent) traceStarted = await beginBrowserTrace(context);
      page ??= await context.newPage();
      await page.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: this.timeoutMs });
      const recover = persistent ? async () => {
        const result = await this.authManager.ensureAuthenticated({
          platform: recipe.key, account: account.id, adapter: browserAuthAdapter(recipe),
          getPage: () => persistent.getPage(), verifyOwnership: () => lease.verify(),
          makeVisible: async () => {
            if (!await lease.verify()) throw new Error('Account lease lost');
            await persistent.makeVisible((newContext) => this.networkGuard.install(newContext, recipe.allowedHosts), startUrl);
            context = persistent.getContext();
            context.setDefaultTimeout(Math.min(this.timeoutMs, 30_000));
            context.setDefaultNavigationTimeout(this.timeoutMs);
          },
          interactive, skipAuthBlocked: options.skipAuthBlocked, signal: options.signal,
          timeout: this.authTimeout, captchaTimeout: this.captchaTimeout, maxAttempts: this.authAttempts,
          screenshotDir: this.authScreenshotsDir,
          otpProvider: createAccountTotpProvider(account.id, account.settings, this.readTotpSecret),
        });
        page = persistent.getPage();
        if (!result.authenticated) {
          return { ...this.challengeResult({
            kind: result.state === AuthState.AUTHENTICATED ? 'UNKNOWN_AUTH_CHALLENGE' : result.state,
            message: `Authentication paused: ${result.reason ?? 'FAILED'}`,
          }, page.url()), authRecovery: result };
        }
        if (!await recipe.isEditorReady(page)) {
          await assertPublicBrowserUrl(startUrl, recipe.allowedHosts);
          await page.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: this.timeoutMs });
          const checked = await new AuthDetector().detectAuthState(page, browserAuthAdapter(recipe));
          if (checked.state !== AuthState.AUTHENTICATED) return this.challengeResult({ kind: 'LOGIN_REQUIRED', message: 'Session did not remain authenticated' }, page.url());
        }
        return page;
      } : undefined;
      if (recover) {
        const ready = await recover();
        if ('status' in ready) return ready;
        page = ready;
      }
      let result = await operation(page, lease, recover);
      if (this.diagnosticsEnabled && !persistent && this.isDiagnosticWorthy(result)) {
        const artifact = await this.captureIncident(page, context, traceStarted, account.id, recipe.key);
        traceStarted = false; // the trace, if any, was consumed by the capture
        result = this.attachDiagnostics(result, artifact);
      }
      persistRefreshedState = this.shouldPersistRefreshedState(result);
      if (options.requireSessionSave && persistRefreshedState) {
        persistRefreshedState = false;
        const captured = await context.storageState({ indexedDB: true });
        if (!await lease.verify()) throw new Error('Account lease lost before saving session');
        await this.sessions.save(account.id, captured, this.recoveryEnabled && !options.allowSessionReactivation);
      }
      return result;
    } catch (error) {
      if (persistent) this.authManager.accounts.set(`${recipe.key}/${account.id}`, AccountRuntimeState.FAILED);
      // Configuration problems an operator can fix: show their (secret-free) message.
      const operatorActionable =
        error instanceof BrowserRuntimeUnavailableError
        || error instanceof BrowserProxyConfigurationError
        || error instanceof BrowserProfileSettingError;
      this.logger.warn(
        JSON.stringify({
          platformAccountId: account.id,
          browserRecipe: recipe.key,
          event: 'BROWSER_AUTOMATION_PAUSED',
          errorType: error instanceof Error ? error.name : 'UnknownError',
        }),
      );
      let artifact: BrowserDiagnosticsArtifact | undefined;
      if (this.diagnosticsEnabled && !persistent && page && !operatorActionable) {
        artifact = await this.captureIncident(page, context, traceStarted, account.id, recipe.key);
        traceStarted = false;
      }
      return this.attachDiagnostics(
        this.needsAction(
          'AUTOMATION_FAILED',
          operatorActionable
            ? error.message
            : 'The browser task stopped safely before publication could be confirmed',
          recipe.startUrl(account),
        ),
        artifact,
      );
    } finally {
      if (traceStarted && context) {
        await discardBrowserTrace(context, true).catch(() => undefined);
      }
      if (context && persistRefreshedState) {
        try {
          const state = await context.storageState({ indexedDB: true });
          // Capturing state is read-only. Check ownership after capture and as
          // close as possible to the write to avoid an expired owner replacing
          // a newer session.
          if (await lease.verify()) await this.sessions.save(account.id, state, this.recoveryEnabled && !options.allowSessionReactivation);
        } catch (error) {
          this.logger.warn(
            JSON.stringify({
              platformAccountId: account.id,
              browserRecipe: recipe.key,
              event: 'BROWSER_STATE_SAVE_FAILED',
              errorType: error instanceof Error ? error.name : 'UnknownError',
            }),
          );
        }
      }
      await context?.close().catch(() => undefined);
      await persistent?.close();
      await browser?.close().catch(() => undefined);
      await networkProxy?.close().catch(() => undefined);
      await lease.stop();
      await this.redis.releaseLock(lockKey, lock).catch((error: unknown) => {
        this.logger.warn(
          JSON.stringify({
            platformAccountId: account.id,
            browserRecipe: recipe.key,
            event: 'BROWSER_LOCK_RELEASE_FAILED',
            errorType: error instanceof Error ? error.name : 'UnknownError',
          }),
        );
      });
    }
  }

  private challengeResult(
    challenge: BrowserChallenge,
    url: string,
  ): Extract<BrowserAutomationResult, { status: 'NEEDS_ACTION' }> {
    return {
      ...this.needsAction(challenge.kind, challenge.message, url),
      accountReconnectRequired: true,
      challengeKind: challenge.kind,
    };
  }

  private async detectChallenge(page: Page, recipe: BrowserPublishRecipe): Promise<BrowserChallenge | undefined> {
    if (!this.recoveryEnabled) return this.challenges.detect(page);
    const detected = await new AuthDetector().detectAuthState(page, browserAuthAdapter(recipe));
    if (detected.state === AuthState.AUTHENTICATED) return undefined;
    return { kind: detected.state, message: detected.failure ?? `Authentication required: ${detected.state}` };
  }

  private shouldPersistRefreshedState(result: unknown): boolean {
    if (!result || typeof result !== 'object' || Array.isArray(result)) return false;
    const record = result as Record<string, unknown>;
    return record.status === 'PUBLISHED' || record.ready === true;
  }

  private isDiagnosticWorthy(result: unknown): boolean {
    if (!result || typeof result !== 'object') return false;
    const record = result as Record<string, unknown>;
    return (
      record.status === 'NEEDS_ACTION' &&
      typeof record.reason === 'string' &&
      BrowserAutomationService.DIAGNOSTIC_REASONS.has(record.reason)
    );
  }

  private attachDiagnostics<T>(result: T, artifact?: BrowserDiagnosticsArtifact): T {
    if (!artifact || !result || typeof result !== 'object') return result;
    return { ...(result as Record<string, unknown>), diagnostics: artifact } as T;
  }

  private captureIncident(
    page: Page | undefined,
    context: BrowserContext | undefined,
    traceStarted: boolean,
    accountId: string,
    recipeKey: string,
  ): Promise<BrowserDiagnosticsArtifact | undefined> {
    return captureBrowserDiagnostics({
      page,
      context,
      rootDir: this.diagnosticsDir,
      traceStarted,
      retentionHours: this.diagnosticsRetentionHours,
    })
      .then((artifact) => {
        if (artifact) {
          this.logger.warn(
            JSON.stringify({
              platformAccountId: accountId,
              browserRecipe: recipeKey,
              event: 'BROWSER_DIAGNOSTICS_CAPTURED',
              incidentId: artifact.incidentId,
              directory: artifact.directory,
              screenshot: artifact.screenshot,
              html: artifact.html,
              trace: artifact.trace,
            }),
          );
        }
        return artifact;
      })
      .catch(() => undefined);
  }

  private needsAction(
    reason: Extract<BrowserAutomationResult, { status: 'NEEDS_ACTION' }>['reason'],
    message: string,
    url?: string,
  ): Extract<BrowserAutomationResult, { status: 'NEEDS_ACTION' }> {
    return {
      status: 'NEEDS_ACTION',
      reason,
      message,
      ...(url && safeBrowserActionUrl(url) ? { actionUrl: safeBrowserActionUrl(url) } : {}),
    };
  }
}
