/**
 * Stable per-account browser context. The login-capture browser and every
 * later publish run use the same locale, timezone and viewport so a session the
 * account owner captured by hand is replayed from a consistent environment.
 *
 * This is deliberately *consistency*, not disguise: it never spoofs the user
 * agent, hides automation flags or randomizes fingerprints. Bypassing a
 * platform's anti-bot controls is out of scope for browser-assisted publishing.
 */
export interface BrowserContextProfile {
  readonly locale: string;
  readonly timezoneId: string;
  readonly viewport: { readonly width: number; readonly height: number };
}

export const DEFAULT_BROWSER_CONTEXT_PROFILE: BrowserContextProfile = {
  locale: 'vi-VN',
  timezoneId: 'Asia/Ho_Chi_Minh',
  viewport: { width: 1366, height: 768 },
};

/** Admin-configured proxy names (values live only in the BROWSER_PROXIES secret). */
export const BROWSER_PROXY_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

const LOCALE_PATTERN = /^[a-z]{2,3}(?:-[A-Z]{2})?$/;
const VIEWPORT_PATTERN = /^(\d{3,4})x(\d{3,4})$/;
const VIEWPORT_LIMITS = { minWidth: 800, maxWidth: 2560, minHeight: 600, maxHeight: 1600 };

/** Thrown for an invalid profile/proxy setting; the message is safe to show operators. */
export class BrowserProfileSettingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BrowserProfileSettingError';
  }
}

function isBlank(value: unknown): boolean {
  return value === undefined || value === null || value === '';
}

function parseLocale(value: unknown): string {
  if (typeof value !== 'string' || !LOCALE_PATTERN.test(value)) {
    throw new BrowserProfileSettingError('browserLocale must look like "vi-VN" or "en"');
  }
  return value;
}

function parseTimezone(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 64) {
    throw new BrowserProfileSettingError('browserTimezone must be an IANA timezone such as "Asia/Ho_Chi_Minh"');
  }
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
  } catch {
    throw new BrowserProfileSettingError('browserTimezone must be an IANA timezone such as "Asia/Ho_Chi_Minh"');
  }
  return value;
}

function parseViewport(value: unknown): { width: number; height: number } {
  const match = typeof value === 'string' ? VIEWPORT_PATTERN.exec(value) : null;
  const width = Number(match?.[1]);
  const height = Number(match?.[2]);
  if (
    !match
    || width < VIEWPORT_LIMITS.minWidth
    || width > VIEWPORT_LIMITS.maxWidth
    || height < VIEWPORT_LIMITS.minHeight
    || height > VIEWPORT_LIMITS.maxHeight
  ) {
    throw new BrowserProfileSettingError(
      `browserViewport must be "WIDTHxHEIGHT" within ${VIEWPORT_LIMITS.minWidth}-${VIEWPORT_LIMITS.maxWidth} x `
        + `${VIEWPORT_LIMITS.minHeight}-${VIEWPORT_LIMITS.maxHeight}`,
    );
  }
  return { width, height };
}

function parseProxyName(value: unknown): string {
  if (typeof value !== 'string' || !BROWSER_PROXY_NAME_PATTERN.test(value)) {
    throw new BrowserProfileSettingError(
      'browserProxy must be the name of a proxy configured by the administrator',
    );
  }
  return value;
}

/** Validates the profile/proxy keys of an account settings patch. Blank means "use the default". */
export function assertBrowserProfileSettings(settings: Record<string, unknown>): void {
  if (!isBlank(settings.browserLocale)) parseLocale(settings.browserLocale);
  if (!isBlank(settings.browserTimezone)) parseTimezone(settings.browserTimezone);
  if (!isBlank(settings.browserViewport)) parseViewport(settings.browserViewport);
  if (!isBlank(settings.browserProxy)) parseProxyName(settings.browserProxy);
}

export function resolveBrowserContextProfile(
  settings: Record<string, unknown>,
): BrowserContextProfile {
  const fallback = DEFAULT_BROWSER_CONTEXT_PROFILE;
  return {
    locale: isBlank(settings.browserLocale) ? fallback.locale : parseLocale(settings.browserLocale),
    timezoneId: isBlank(settings.browserTimezone)
      ? fallback.timezoneId
      : parseTimezone(settings.browserTimezone),
    viewport: isBlank(settings.browserViewport)
      ? { ...fallback.viewport }
      : parseViewport(settings.browserViewport),
  };
}

/** Name of the admin-configured egress proxy for this account, if any. */
export function browserProxyName(settings: Record<string, unknown>): string | undefined {
  return isBlank(settings.browserProxy) ? undefined : parseProxyName(settings.browserProxy);
}

/** Playwright context options for a profile. `locale` also drives Accept-Language. */
export function browserContextOptions(profile: BrowserContextProfile): {
  locale: string;
  timezoneId: string;
  viewport: { width: number; height: number };
} {
  return {
    locale: profile.locale,
    timezoneId: profile.timezoneId,
    viewport: { width: profile.viewport.width, height: profile.viewport.height },
  };
}
