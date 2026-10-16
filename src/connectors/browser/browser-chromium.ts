import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { chromium } from 'playwright';

/**
 * Raised when the Chromium binary that Playwright needs is not present. It is a
 * distinct type so the publish path can surface an actionable operator message
 * instead of hiding a missing runtime behind a generic automation failure.
 */
export class BrowserRuntimeUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BrowserRuntimeUnavailableError';
  }
}

/**
 * Verifies the Chromium executable exists before a browser launch is attempted.
 * Both the headed login-capture flow and the headless publish flow call this so
 * a missing binary produces a clear "run pnpm browser:install" message rather
 * than an opaque launch error.
 */
export async function assertChromiumInstalled(executablePath?: string): Promise<void> {
  const resolved = executablePath ?? chromium.executablePath();
  try {
    await access(resolved, constants.F_OK);
  } catch {
    throw new BrowserRuntimeUnavailableError(
      `Chromium executable was not found at '${resolved}'. `
        + 'Run "pnpm browser:install" in social-publisher-backend, '
        + 'or set PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH to a valid Chromium executable.',
    );
  }
}
