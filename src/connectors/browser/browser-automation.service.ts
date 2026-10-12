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
import { assertPublicBrowserUrl, safeBrowserActionUrl } from './browser-navigation-safety';
import { BrowserSessionStateStore } from './browser-session-state.store';
import { BrowserNetworkGuard, type BrowserNetworkProxy } from './browser-network-guard.service';
import { BrowserMediaPreparationService } from './browser-media-preparation.service';
import { BrowserSubmissionAuthorizationService } from './browser-submission-authorization.service';

@Injectable()
export class BrowserAutomationService {
  private readonly logger = new Logger(BrowserAutomationService.name);
  private readonly enabled: boolean;
  private readonly headless: boolean;
  private readonly timeoutMs: number;
  private readonly executablePath?: string;

  constructor(
    config: ConfigService,
    private readonly sessions: BrowserSessionStateStore,
    private readonly challenges: BrowserChallengeDetector,
    private readonly redis: RedisService,
    private readonly networkGuard: BrowserNetworkGuard,
    private readonly media: BrowserMediaPreparationService,
    private readonly submitAuthorization: BrowserSubmissionAuthorizationService,
  ) {
    this.enabled = config.get<boolean>('BROWSER_AUTOMATION_ENABLED', false);
    this.headless = config.get<boolean>('BROWSER_AUTOMATION_HEADLESS', true);
    this.timeoutMs = config.get<number>('BROWSER_AUTOMATION_TIMEOUT_MS', 90_000);
    this.executablePath = config.get<string>('PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH') || undefined;
  }

  async publish(
    account: ConnectorAccount,
    post: PostPayload,
    recipe: BrowserPublishRecipe,
  ): Promise<BrowserAutomationResult> {
    if (!this.enabled) {
      return this.needsAction(
        'AUTOMATION_DISABLED',
        'Browser automation is disabled by the server configuration',
        recipe.startUrl(account),
      );
    }
    return this.withSession(account, recipe, async (page, lease) => {
      const challenge = await this.challenges.detect(page);
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
        const challengeAfterPreparation = await this.challenges.detect(page);
        if (challengeAfterPreparation)
          return this.challengeResult(challengeAfterPreparation, page.url());
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
          const challengeAfterSubmit = await this.challenges.detect(page).catch(() => undefined);
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
    });
  }

  async inspect(
    account: ConnectorAccount,
    recipe: BrowserPublishRecipe,
  ): Promise<BrowserConnectionInspection> {
    if (!this.enabled) {
      return {
        ready: false,
        actionUrl: safeBrowserActionUrl(recipe.startUrl(account)),
        message: 'Browser automation is disabled by the server configuration',
      };
    }
    const result = await this.withSession(account, recipe, async (page) => {
      const challenge = await this.challenges.detect(page);
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
    });
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
    operation: (page: Page, lease: RedisLockLease) => Promise<T>,
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
    let persistRefreshedState = false;
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
      networkProxy = await this.networkGuard.startProxy();
      browser = await chromium.launch({
        headless: this.headless,
        timeout: Math.min(this.timeoutMs, 60_000),
        ...(this.executablePath ? { executablePath: this.executablePath } : {}),
        proxy: { server: networkProxy.server },
        args: ['--disable-dev-shm-usage', ...networkProxy.chromiumArgs],
      });
      context = await browser.newContext({
        acceptDownloads: false,
        serviceWorkers: 'block',
        storageState: state as Exclude<BrowserContextOptions['storageState'], string | undefined>,
      });
      context.setDefaultTimeout(Math.min(this.timeoutMs, 30_000));
      context.setDefaultNavigationTimeout(this.timeoutMs);
      await this.networkGuard.install(context, recipe.allowedHosts);
      const page = await context.newPage();
      await page.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: this.timeoutMs });
      const result = await operation(page, lease);
      persistRefreshedState = this.shouldPersistRefreshedState(result);
      return result;
    } catch (error) {
      this.logger.warn(
        JSON.stringify({
          platformAccountId: account.id,
          browserRecipe: recipe.key,
          event: 'BROWSER_AUTOMATION_PAUSED',
          errorType: error instanceof Error ? error.name : 'UnknownError',
        }),
      );
      return this.needsAction(
        'AUTOMATION_FAILED',
        'The browser task stopped safely before publication could be confirmed',
        recipe.startUrl(account),
      );
    } finally {
      if (context && persistRefreshedState) {
        try {
          const state = await context.storageState({ indexedDB: true });
          // Capturing state is read-only. Check ownership after capture and as
          // close as possible to the write to avoid an expired owner replacing
          // a newer session.
          if (await lease.verify()) await this.sessions.save(account.id, state);
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

  private shouldPersistRefreshedState(result: unknown): boolean {
    if (!result || typeof result !== 'object' || Array.isArray(result)) return false;
    const record = result as Record<string, unknown>;
    return record.status === 'PUBLISHED' || record.ready === true;
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
