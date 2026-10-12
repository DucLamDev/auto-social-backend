import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AccountStatus } from '@prisma/client';
import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { chromium, type Browser, type BrowserContext, type BrowserContextOptions, type Page } from 'playwright';
import { sha256 } from '../../common/utils/crypto.utils';
import { PrismaService } from '../../database/prisma.service';
import { RedisService } from '../../queue/redis.service';
import { RedisLockLease } from '../../queue/redis-lock-lease';
import { ConnectorAccountsService } from '../connector-accounts.service';
import { BrowserChallengeDetector } from './browser-challenge.detector';
import { BrowserNetworkGuard, type BrowserNetworkProxy } from './browser-network-guard.service';
import { assertPublicBrowserUrl, safeBrowserActionUrl } from './browser-navigation-safety';
import { BrowserPublishRecipe } from './browser-automation.types';
import { BrowserRecipeRegistry } from './browser-recipe.registry';
import { hasUsableBrowserStorageState } from './browser-session-readiness';
import { BrowserSessionStateStore } from './browser-session-state.store';

export interface BrowserLoginCaptureResult {
  accountId: string;
  browserRecipe: string;
  editorUrl?: string;
  message: string;
}

@Injectable()
export class BrowserLoginCaptureService {
  private readonly logger = new Logger(BrowserLoginCaptureService.name);
  private readonly executablePath?: string;

  constructor(
    config: ConfigService,
    private readonly accounts: ConnectorAccountsService,
    private readonly recipes: BrowserRecipeRegistry,
    private readonly sessions: BrowserSessionStateStore,
    private readonly challenges: BrowserChallengeDetector,
    private readonly networkGuard: BrowserNetworkGuard,
    private readonly redis: RedisService,
    private readonly prisma: PrismaService,
  ) {
    this.executablePath = config.get<string>('PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH') || undefined;
  }

  /**
   * Opens a real headed browser. Authentication happens only in that browser;
   * this process never prompts for, receives, or stores the account password.
   */
  async capture(
    accountId: string,
    waitForUser: (signal: AbortSignal) => Promise<void>,
  ): Promise<BrowserLoginCaptureResult> {
    const loaded = await this.accounts.loadForBrowserLoginCapture(accountId);
    if (loaded.connectorKey !== 'browser-assisted') {
      throw new Error('The selected account does not use a browser-assisted connector');
    }
    if (loaded.enabled === false) {
      throw new Error('The selected browser-assisted account is disabled');
    }
    const recipeKey = loaded.account.settings.browserRecipe;
    if (typeof recipeKey !== 'string' || !recipeKey.trim()) {
      throw new Error('The account has no built-in browserRecipe setting');
    }
    const recipe = this.recipes.get(recipeKey.trim().toLowerCase());
    const lockKey = `lock:browser-session:${sha256(accountId)}`;
    const lockTtlMs = 16 * 60_000;
    const lock = await this.redis.acquireLock(lockKey, lockTtlMs);
    if (!lock) throw new Error('Another browser task is already using this account');
    const lease = new RedisLockLease(this.redis, lockKey, lock, lockTtlMs, {
      onLost: () => {
        this.logger.error(JSON.stringify({
          platformAccountId: accountId,
          browserRecipe: recipe.key,
          event: 'BROWSER_LOGIN_LOCK_LEASE_LOST',
        }));
      },
      onCallbackError: (error) => {
        this.logger.warn(JSON.stringify({
          platformAccountId: accountId,
          browserRecipe: recipe.key,
          event: 'BROWSER_LOGIN_LOCK_RENEWAL_ERROR',
          errorType: error instanceof Error ? error.name : 'UnknownError',
        }));
      },
    });
    lease.start();

    let browser: Browser | undefined;
    let context: BrowserContext | undefined;
    let networkProxy: BrowserNetworkProxy | undefined;
    const abort = new AbortController();
    try {
      const startUrl = recipe.startUrl(loaded.account);
      await assertPublicBrowserUrl(startUrl, recipe.allowedHosts);
      const state = await this.sessions.load(accountId, loaded.account.credentials.storageState);
      await this.assertChromiumInstalled();
      networkProxy = await this.networkGuard.startProxy();
      browser = await chromium.launch({
        headless: false,
        ...(this.executablePath ? { executablePath: this.executablePath } : {}),
        proxy: { server: networkProxy.server },
        args: ['--disable-dev-shm-usage', ...networkProxy.chromiumArgs],
      });
      context = await browser.newContext({
        acceptDownloads: false,
        serviceWorkers: 'block',
        storageState: state as Exclude<BrowserContextOptions['storageState'], string | undefined>,
      });
      await this.networkGuard.install(context, recipe.allowedHosts);
      const initialPage = await context.newPage();
      await initialPage.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: 90_000 });

      const detected = this.waitForEditor(context, recipe, abort.signal);
      await Promise.race([detected, waitForUser(abort.signal)]);
      abort.abort();
      const editorPage = await this.findEditorPage(context, recipe);
      if (!editorPage) {
        const activePage = context.pages().find((page) => !page.isClosed()) ?? initialPage;
        const challenge = await this.challenges.detect(activePage);
        if (challenge) throw new Error(`${challenge.kind}: ${challenge.message}`);
        throw new Error('Login was not captured because the expected editor is not ready');
      }

      const challenge = await this.challenges.detect(editorPage);
      if (challenge) throw new Error(`${challenge.kind}: ${challenge.message}`);
      const captured = await context.storageState({ indexedDB: true });
      if (!hasUsableBrowserStorageState({ storageState: captured })) {
        throw new Error(
          'Login state is missing; sign in completely before finishing browser capture',
        );
      }
      // storageState() is read-only. Verify after capture, immediately before
      // persisting it, so an expired login owner cannot overwrite a newer one.
      if (!await lease.verify()) {
        throw new Error('Browser session ownership changed; login state was not saved');
      }
      await this.sessions.save(accountId, captured);
      const connected = await this.prisma.platformAccount.updateMany({
        where: { id: accountId, enabled: true },
        data: { status: AccountStatus.CONNECTED, lastTestedAt: new Date() },
      });
      if (connected.count !== 1) {
        throw new Error('The browser-assisted account was disabled while login was being captured');
      }
      return {
        accountId,
        browserRecipe: recipe.key,
        editorUrl: safeBrowserActionUrl(editorPage.url()),
        message: 'Login session captured and encrypted successfully',
      };
    } finally {
      abort.abort();
      await context?.close().catch(() => undefined);
      await browser?.close().catch(() => undefined);
      await networkProxy?.close().catch(() => undefined);
      await lease.stop();
      await this.redis.releaseLock(lockKey, lock).catch(() => undefined);
    }
  }

  private async waitForEditor(
    context: BrowserContext,
    recipe: BrowserPublishRecipe,
    signal: AbortSignal,
  ): Promise<void> {
    const deadline = Date.now() + 15 * 60_000;
    while (!signal.aborted && Date.now() < deadline) {
      if (await this.findEditorPage(context, recipe)) return;
      await new Promise<void>((resolve) => setTimeout(resolve, 500));
    }
    if (!signal.aborted) throw new Error('Login capture timed out after 15 minutes');
  }

  private async findEditorPage(
    context: BrowserContext,
    recipe: BrowserPublishRecipe,
  ): Promise<Page | undefined> {
    for (const page of [...context.pages()].reverse()) {
      if (!page.isClosed() && await recipe.isEditorReady(page).catch(() => false)) return page;
    }
    return undefined;
  }

  private async assertChromiumInstalled(): Promise<void> {
    const executablePath = this.executablePath ?? chromium.executablePath();
    try {
      await access(executablePath, constants.F_OK);
    } catch {
      throw new Error(
        `Chromium executable was not found at '${executablePath}'. `
        + 'Run "pnpm browser:install" in social-publisher-backend, '
        + 'or set PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH to a valid Chromium executable.',
      );
    }
  }
}
