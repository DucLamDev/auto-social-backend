import { chmod, mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type { BrowserContext, Page } from 'playwright';

/**
 * Descriptor of the evidence captured when a browser publish attempt failed or
 * could not be verified. The screenshot/HTML/trace files stay on the server
 * disk (never in the database or logs); only this lightweight pointer is
 * attached to the job so an operator can locate them.
 */
export interface BrowserDiagnosticsArtifact {
  readonly incidentId: string;
  readonly directory: string;
  readonly screenshot: boolean;
  readonly html: boolean;
  readonly trace: boolean;
  readonly capturedAt: string;
}

const DEFAULT_SUBDIR = 'social-publisher-browser-diagnostics';

interface TracingLike {
  start?: (options: unknown) => Promise<void>;
  stop?: (options?: { path: string }) => Promise<void>;
}

function tracingOf(context: BrowserContext | undefined): TracingLike | undefined {
  return (context as unknown as { tracing?: TracingLike } | undefined)?.tracing;
}

export function browserDiagnosticsRoot(configuredDir?: string): string {
  return configuredDir && configuredDir.trim()
    ? configuredDir.trim()
    : join(tmpdir(), DEFAULT_SUBDIR);
}

/** Start a Playwright trace if the context supports it. Never throws. */
export async function beginBrowserTrace(context: BrowserContext): Promise<boolean> {
  const tracing = tracingOf(context);
  if (!tracing || typeof tracing.start !== 'function') return false;
  try {
    await tracing.start({ screenshots: true, snapshots: true, sources: false });
    return true;
  } catch {
    return false;
  }
}

/** Stop a trace without saving it (the normal success path). Never throws. */
export async function discardBrowserTrace(
  context: BrowserContext,
  started: boolean,
): Promise<void> {
  if (!started) return;
  const tracing = tracingOf(context);
  if (!tracing || typeof tracing.stop !== 'function') return;
  await tracing.stop().catch(() => undefined);
}

export interface CaptureBrowserDiagnosticsOptions {
  page?: Page;
  context?: BrowserContext;
  rootDir?: string;
  /** Whether beginBrowserTrace() started a trace that this capture should save. */
  traceStarted?: boolean;
  retentionHours?: number;
}

/**
 * Captures a full-page screenshot, the page HTML and (when a trace was started)
 * the Playwright trace into a fresh private incident directory. Returns the
 * artifact descriptor, or undefined when nothing could be captured. Never
 * throws: diagnostics must not turn a recoverable publish outcome into a crash.
 *
 * When `traceStarted` is true the active trace is always stopped here (saved on
 * success, otherwise discarded), so the caller must treat the trace as consumed
 * after calling this function.
 */
export async function captureBrowserDiagnostics(
  options: CaptureBrowserDiagnosticsOptions,
): Promise<BrowserDiagnosticsArtifact | undefined> {
  const { page, context, rootDir, traceStarted = false, retentionHours = 72 } = options;

  // Probe the screenshot capability first so mock/placeholder pages (unit tests)
  // short-circuit before any filesystem directory is created.
  let screenshotBytes: Buffer | undefined;
  if (page && typeof page.screenshot === 'function') {
    screenshotBytes = await page
      .screenshot({ fullPage: true, type: 'png' })
      .then((value) => (Buffer.isBuffer(value) ? value : undefined))
      .catch(() => undefined);
  }
  let htmlContent: string | undefined;
  if (page && typeof page.content === 'function') {
    htmlContent = await page.content().catch(() => undefined);
  }

  const canSaveTrace =
    traceStarted && !!context && typeof tracingOf(context)?.stop === 'function';

  if (!screenshotBytes && htmlContent === undefined && !canSaveTrace) return undefined;

  const root = browserDiagnosticsRoot(rootDir);
  let directory: string;
  try {
    await mkdir(root, { recursive: true, mode: 0o700 });
    await chmod(root, 0o700).catch(() => undefined);
    directory = await mkdtemp(join(root, 'incident-'));
    await chmod(directory, 0o700).catch(() => undefined);
  } catch {
    // Still stop the trace so an open tracing session is not leaked.
    if (canSaveTrace && context) await discardBrowserTrace(context, true);
    return undefined;
  }

  let screenshot = false;
  let html = false;
  let trace = false;

  if (screenshotBytes) {
    screenshot = await writeFile(join(directory, 'screenshot.png'), screenshotBytes, {
      mode: 0o600,
    })
      .then(() => true)
      .catch(() => false);
  }
  if (htmlContent !== undefined) {
    html = await writeFile(join(directory, 'page.html'), htmlContent, { mode: 0o600 })
      .then(() => true)
      .catch(() => false);
  }
  if (canSaveTrace && context) {
    const tracing = tracingOf(context);
    trace = await tracing!
      .stop!({ path: join(directory, 'trace.zip') })
      .then(() => true)
      .catch(() => false);
  }

  void pruneBrowserDiagnostics(root, retentionHours);

  return {
    incidentId: basename(directory),
    directory,
    screenshot,
    html,
    trace,
    capturedAt: new Date().toISOString(),
  };
}

/** Best-effort removal of incident directories older than the retention window. */
export async function pruneBrowserDiagnostics(
  root: string,
  retentionHours: number,
): Promise<void> {
  if (!Number.isFinite(retentionHours) || retentionHours <= 0) return;
  const cutoff = Date.now() - retentionHours * 3_600_000;
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith('incident-')) continue;
    const full = join(root, entry.name);
    const info = await stat(full).catch(() => undefined);
    if (info && info.mtimeMs < cutoff) {
      await rm(full, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}
