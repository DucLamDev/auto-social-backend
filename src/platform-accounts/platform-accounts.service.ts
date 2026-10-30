import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { AccountStatus, PlatformMode, Prisma } from '@prisma/client';
import { CredentialsService } from '../credentials/credentials.service';
import { PrismaService } from '../database/prisma.service';
import { CreatePlatformAccountDto } from './dto/create-platform-account.dto';
import { BrowserRecipeRegistry } from '../connectors/browser/browser-recipe.registry';
import {
  assertBrowserProfileSettings,
  BrowserProfileSettingError,
} from '../connectors/browser/browser-context-profile';
import { hasUsableBrowserStorageState } from '../connectors/browser/browser-session-readiness';
import { RedisService } from '../queue/redis.service';
import { RedisLockLease } from '../queue/redis-lock-lease';
import { sha256 } from '../common/utils/crypto.utils';

const safeAccountSelect = {
  id: true,
  platformId: true,
  name: true,
  username: true,
  externalId: true,
  settings: true,
  enabled: true,
  status: true,
  lastTestedAt: true,
  createdAt: true,
  updatedAt: true,
  platform: {
    select: {
      slug: true,
      name: true,
      connectorKey: true,
      groupKey: true,
      defaultSettings: true,
      mode: true,
      availability: true,
      capability: true,
    },
  },
  credential: { select: { status: true, expiresAt: true, updatedAt: true } },
  oauthToken: { select: { scopes: true, expiresAt: true, updatedAt: true } },
} satisfies Prisma.PlatformAccountSelect;

const BROWSER_EDITABLE_SETTINGS = new Set([
  // Chrome extension delivery, managed through PUT /extension/accounts/:id.
  'delivery',
  'extensionEngine',
  'extensionTargetUrl',
  'extensionAutoSubmit',
  'forumPath',
  'threadPrefixId',
  'automationPermissionAttested',
  'browserAutoSubmit',
  'browserAutoTotp',
  'browserProxy',
  'browserLocale',
  'browserTimezone',
  'browserViewport',
  'rateLimit',
  'rateWindowSeconds',
]);

// Changing these invalidates the last connection test: a session captured
// through another egress proxy or browser profile must be re-verified.
const BROWSER_NAVIGATION_SETTINGS = new Set([
  'forumPath',
  'browserProxy',
  'browserLocale',
  'browserTimezone',
  'browserViewport',
]);

/**
 * API/OAuth accounts keep their connection data server-side; operators may
 * only change how posts go out. Anything else must go through the credential
 * or OAuth flow.
 */
export function apiPublishingSettings(settings: Record<string, unknown>): Record<string, unknown> {
  const allowed = new Set(['publishImmediately', 'rateLimit', 'rateWindowSeconds']);
  const unknownKeys = Object.keys(settings).filter((key) => !allowed.has(key));
  if (unknownKeys.length) {
    throw new BadRequestException(`Only publishImmediately, rateLimit and rateWindowSeconds can be changed here: ${unknownKeys.join(', ')}`);
  }
  if ('publishImmediately' in settings && typeof settings.publishImmediately !== 'boolean') {
    throw new BadRequestException('publishImmediately must be true or false');
  }
  for (const key of ['rateLimit', 'rateWindowSeconds'] as const) {
    const value = settings[key];
    if (value !== undefined && (!Number.isSafeInteger(value) || (value as number) < 1)) {
      throw new BadRequestException(`${key} must be a positive integer`);
    }
  }
  return settings;
}

function asSettings(value: Prisma.JsonValue): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value
    : {};
}

function changedSettingKeys(
  current: Record<string, unknown>,
  patch: Record<string, unknown>,
): string[] {
  return Object.keys(patch).filter((key) => (
    JSON.stringify(current[key]) !== JSON.stringify(patch[key])
  ));
}

function browserRecipeFromDefaults(value: Prisma.JsonValue): string {
  const recipe = asSettings(value).browserRecipe;
  if (typeof recipe !== 'string' || !recipe.trim()) {
    throw new BadRequestException('Browser-assisted platform has no server-bound browser recipe');
  }
  return recipe.trim().toLowerCase();
}

function assertBrowserEditableSettings(settings: Record<string, unknown>): void {
  const unknown = Object.keys(settings).filter((key) => !BROWSER_EDITABLE_SETTINGS.has(key));
  if (unknown.length) {
    throw new BadRequestException(`Unsupported browser setting: ${unknown.join(', ')}`);
  }
  if (settings.forumPath !== undefined) {
    if (typeof settings.forumPath !== 'string' || settings.forumPath.length > 500) {
      throw new BadRequestException('forumPath must be a string of at most 500 characters');
    }
  }
  if (settings.threadPrefixId !== undefined) {
    if (
      typeof settings.threadPrefixId !== 'string'
      || settings.threadPrefixId.length > 30
      || (settings.threadPrefixId !== '' && !/^\d+$/.test(settings.threadPrefixId))
    ) {
      throw new BadRequestException('threadPrefixId must be empty or numeric');
    }
  }
  for (const key of ['automationPermissionAttested', 'browserAutoSubmit', 'browserAutoTotp'] as const) {
    if (settings[key] !== undefined && typeof settings[key] !== 'boolean') {
      throw new BadRequestException(`${key} must be a boolean`);
    }
  }
  try {
    assertBrowserProfileSettings(settings);
  } catch (error) {
    if (error instanceof BrowserProfileSettingError) throw new BadRequestException(error.message);
    throw error;
  }
  for (const [key, maximum] of [['rateLimit', 1_000], ['rateWindowSeconds', 86_400]] as const) {
    const value = settings[key];
    if (
      value !== undefined
      && (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > maximum)
    ) {
      throw new BadRequestException(`${key} must be an integer between 1 and ${maximum}`);
    }
  }
}

@Injectable()
export class PlatformAccountsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly credentials: CredentialsService,
    private readonly browserRecipes?: BrowserRecipeRegistry,
    private readonly redis?: RedisService,
  ) {}

  async list(ownerId: string) {
    const accounts = await this.prisma.platformAccount.findMany({
      where: { ownerId },
      select: safeAccountSelect,
      orderBy: { name: 'asc' },
    });
    return Promise.all(accounts.map((account) => this.withBrowserSessionConfigured(account)));
  }

  async get(ownerId: string, id: string) {
    const account = await this.prisma.platformAccount.findFirstOrThrow({
      where: { id, ownerId },
      select: safeAccountSelect,
    });
    return this.withBrowserSessionConfigured(account);
  }

  async create(ownerId: string, dto: CreatePlatformAccountDto) {
    if (dto.settings && 'extensionSession' in dto.settings) throw new BadRequestException('Configure the Chrome session through the extension session endpoint');
    const platform = await this.prisma.platform.findUniqueOrThrow({ where: { slug: dto.platformSlug } });
    const defaultSettings = platform.defaultSettings !== null
      && typeof platform.defaultSettings === 'object'
      && !Array.isArray(platform.defaultSettings)
      ? platform.defaultSettings as Record<string, unknown>
      : {};
    const extensionDelivery = dto.settings?.delivery === 'extension';
    if (extensionDelivery && platform.mode === PlatformMode.OFFICIAL_API) {
      throw new BadRequestException('This platform uses its official API');
    }
    const browserSettings = platform.mode === PlatformMode.BROWSER_ASSISTED && !extensionDelivery
      ? this.browserSettings(platform.defaultSettings, dto.settings ?? {})
      : undefined;
    if (platform.mode === PlatformMode.BROWSER_ASSISTED && dto.credential) {
      throw new BadRequestException(
        'Browser credentials cannot be submitted through the API; capture a login session instead',
      );
    }
    const enabled = dto.enabled ?? true;
    const account = await this.prisma.platformAccount.create({
      data: {
        ownerId,
        platformId: platform.id,
        name: dto.name.trim(),
        username: dto.username?.trim(),
        externalId: dto.externalId?.trim(),
        settings: (browserSettings ?? { ...defaultSettings, ...(dto.settings ?? {}) }) as Prisma.InputJsonObject,
        enabled,
        status:
          !enabled
            ? AccountStatus.DISABLED
            : platform.mode === PlatformMode.MANUAL && !extensionDelivery
            ? AccountStatus.CONNECTED
            : AccountStatus.RECONNECT_REQUIRED,
      },
      select: { id: true },
    });
    if (dto.credential) await this.credentials.upsert(account.id, dto.credential);
    return this.get(ownerId, account.id);
  }

  async updateCredential(
    ownerId: string,
    id: string,
    credential: Record<string, unknown>,
    settings?: Record<string, unknown>,
  ) {
    if (settings && 'extensionSession' in settings) throw new BadRequestException('Configure the Chrome session through the extension session endpoint');
    await this.prisma.$transaction(async (transaction) => {
      const account = await transaction.platformAccount.findFirstOrThrow({
        where: { id, ownerId },
        select: { id: true, settings: true, platform: { select: { mode: true } } },
      });
      if (account.platform?.mode === PlatformMode.BROWSER_ASSISTED) {
        throw new BadRequestException(
          'Browser session credentials can only be changed by the login capture flow',
        );
      }
      const currentSettings = account.settings
        && typeof account.settings === 'object'
        && !Array.isArray(account.settings)
        ? account.settings as Record<string, unknown>
        : {};
      await this.credentials.upsert(id, credential, undefined, transaction);
      await transaction.platformAccount.update({
        where: { id },
        data: {
          ...(settings
            ? { settings: { ...currentSettings, ...settings } as Prisma.InputJsonObject }
            : {}),
          status: AccountStatus.RECONNECT_REQUIRED,
          lastTestedAt: null,
        },
      });
    });
    return this.get(ownerId, id);
  }

  /**
   * Settings are deliberately updated independently from credentials. In
   * particular, a UI edit must never replace the encrypted Playwright
   * storageState with an empty credential object.
   */
  async updateSettings(ownerId: string, id: string, settings: Record<string, unknown>) {
    await this.prisma.$transaction(async (transaction) => {
      const account = await transaction.platformAccount.findFirstOrThrow({
        where: { id, ownerId },
        include: {
          platform: { select: { mode: true, defaultSettings: true } },
        },
      });
      if (account.platform.mode !== PlatformMode.BROWSER_ASSISTED) {
        await transaction.platformAccount.update({
          where: { id },
          data: { settings: { ...asSettings(account.settings), ...apiPublishingSettings(settings) } as Prisma.InputJsonObject },
        });
        return;
      }
      if (Object.prototype.hasOwnProperty.call(settings, 'browserRecipe')) {
        throw new BadRequestException('browserRecipe is controlled by the platform catalog');
      }
      const currentSettings = asSettings(account.settings);
      const nextSettings = this.browserSettings(account.platform.defaultSettings, {
        ...currentSettings,
        ...settings,
        // The server-owned recipe is supplied by browserSettings(), never by
        // account data or this request.
        browserRecipe: undefined,
      });
      const changedKeys = changedSettingKeys(currentSettings, settings);
      const connectionMustBeRetested = changedKeys.some((key) => (
        BROWSER_NAVIGATION_SETTINGS.has(key)
      ));

      await transaction.platformAccount.update({
        where: { id },
        data: {
          settings: nextSettings as Prisma.InputJsonObject,
          ...(connectionMustBeRetested
            ? {
                status: account.enabled
                  ? AccountStatus.RECONNECT_REQUIRED
                  : AccountStatus.DISABLED,
                lastTestedAt: null,
              }
            : {}),
        },
      });
    });
    return this.get(ownerId, id);
  }

  private browserSettings(
    defaultSettings: Prisma.JsonValue,
    requested: Record<string, unknown>,
  ): Record<string, unknown> {
    const recipeKey = browserRecipeFromDefaults(defaultSettings);
    const { browserRecipe: _ignoredBrowserRecipe, ...editable } = requested;
    if (_ignoredBrowserRecipe !== undefined && _ignoredBrowserRecipe !== recipeKey) {
      throw new BadRequestException('browserRecipe is controlled by the platform catalog');
    }
    assertBrowserEditableSettings(editable);
    const merged = {
      ...asSettings(defaultSettings),
      ...editable,
      browserRecipe: recipeKey,
    };
    // startUrl is a deterministic validator implemented by reviewed code. It
    // validates required paths without navigating or accepting a user URL.
    if (!this.browserRecipes) throw new Error('Browser recipe registry is unavailable');
    this.browserRecipes.get(recipeKey).startUrl({
      id: 'settings-validation',
      settings: merged,
      credentials: {},
    });
    return merged;
  }

  private async withBrowserSessionConfigured<T extends {
    id: string;
    platform: { mode: PlatformMode };
    credential: unknown;
  }>(account: T): Promise<T & { browserSessionConfigured?: boolean }> {
    if (!account.platform || account.platform.mode !== PlatformMode.BROWSER_ASSISTED) return account;
    if (!account.credential) return { ...account, browserSessionConfigured: false };
    try {
      const credential = await this.credentials.resolve(account.id);
      return { ...account, browserSessionConfigured: hasUsableBrowserStorageState(credential) };
    } catch {
      return { ...account, browserSessionConfigured: false };
    }
  }

  async setEnabled(ownerId: string, id: string, enabled: boolean) {
    const account = await this.prisma.platformAccount.findFirstOrThrow({
      where: { id, ownerId },
      include: {
        platform: { select: { mode: true } },
      },
    });
    if (!enabled) {
      await this.prisma.platformAccount.update({
        where: { id },
        data: {
          enabled: false,
          status: AccountStatus.DISABLED,
          lastTestedAt: null,
          ...(asSettings(account.settings).extensionAutoConnect === true ? { settings: { ...asSettings(account.settings), extensionAutoConnect: false } as Prisma.InputJsonObject } : {}),
        },
      });
      return this.get(ownerId, id);
    }
    // Enabling is not an authentication event. Every automatic connector must
    // pass a fresh connection test (or browser login capture) after a disable;
    // timestamps and stored state cannot prove a remote session is still live.
    const canConnect = account.platform.mode === PlatformMode.MANUAL;
    await this.prisma.platformAccount.update({
      where: { id },
      data: {
        enabled: true,
        status: canConnect ? AccountStatus.CONNECTED : AccountStatus.RECONNECT_REQUIRED,
        ...(!canConnect ? { lastTestedAt: null } : {}),
      },
    });
    return this.get(ownerId, id);
  }

  async revokeBrowserSession(ownerId: string, id: string) {
    if (!this.redis) throw new Error('Browser session lock service is unavailable');
    const lockKey = `lock:browser-session:${sha256(id)}`;
    const lock = await this.redis.acquireLock(lockKey, 60_000);
    if (!lock) {
      throw new ConflictException(
        'The browser session is currently in use; retry revoking it after the active task finishes',
      );
    }
    const lease = new RedisLockLease(this.redis, lockKey, lock, 60_000);
    lease.start();
    try {
      await this.prisma.$transaction(async (transaction) => {
        const account = await transaction.platformAccount.findFirstOrThrow({
          where: { id, ownerId },
          select: { id: true, enabled: true, platform: { select: { mode: true } } },
        });
        if (account.platform.mode !== PlatformMode.BROWSER_ASSISTED) {
          throw new BadRequestException('This account does not use a captured browser session');
        }
        if (!await lease.verify()) {
          throw new ConflictException(
            'Browser session ownership changed before revocation; retry the operation',
          );
        }
        await this.credentials.revoke(id, transaction);
        await transaction.platformAccount.update({
          where: { id },
          data: {
            status: account.enabled
              ? AccountStatus.RECONNECT_REQUIRED
              : AccountStatus.DISABLED,
            lastTestedAt: null,
          },
        });
      });
    } finally {
      await lease.stop();
      await this.redis.releaseLock(lockKey, lock);
    }
    return this.get(ownerId, id);
  }
}
