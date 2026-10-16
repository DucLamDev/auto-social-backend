import { mkdtemp, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type { BrowserContext, Page } from 'playwright';
import {
  beginBrowserTrace,
  captureBrowserDiagnostics,
  discardBrowserTrace,
  pruneBrowserDiagnostics,
} from './browser-diagnostics';

describe('browser diagnostics', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'diag-test-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('returns false when the context does not support tracing', async () => {
    await expect(beginBrowserTrace({} as unknown as BrowserContext)).resolves.toBe(false);
  });

  it('starts tracing when the context supports it', async () => {
    const start = jest.fn().mockResolvedValue(undefined);
    await expect(
      beginBrowserTrace({ tracing: { start } } as unknown as BrowserContext),
    ).resolves.toBe(true);
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('captures nothing and writes no files for a page without screenshot/content', async () => {
    const page = { url: () => 'https://example.com' } as unknown as Page;
    const artifact = await captureBrowserDiagnostics({ page, rootDir: root });
    expect(artifact).toBeUndefined();
    await expect(readdir(root)).resolves.toHaveLength(0);
  });

  it('writes a screenshot and page HTML into a private incident directory', async () => {
    const page = {
      screenshot: jest.fn().mockResolvedValue(Buffer.from([0x89, 0x50, 0x4e, 0x47])),
      content: jest.fn().mockResolvedValue('<html>hi</html>'),
    } as unknown as Page;

    const artifact = await captureBrowserDiagnostics({ page, rootDir: root });

    expect(artifact).toBeDefined();
    expect(artifact?.screenshot).toBe(true);
    expect(artifact?.html).toBe(true);
    expect(artifact?.trace).toBe(false);
    expect(artifact?.incidentId).toMatch(/^incident-/);
    const files = await readdir(artifact!.directory);
    expect(files.sort()).toEqual(['page.html', 'screenshot.png']);
    await expect(readFile(join(artifact!.directory, 'page.html'), 'utf8')).resolves.toBe(
      '<html>hi</html>',
    );
  });

  it('saves the Playwright trace into the incident directory when one was started', async () => {
    const stop = jest.fn(async ({ path }: { path: string }) => {
      await writeFile(path, 'trace-bytes');
    });
    const context = { tracing: { stop } } as unknown as BrowserContext;
    const page = {
      screenshot: jest.fn().mockResolvedValue(Buffer.from([1])),
      content: jest.fn().mockResolvedValue('<html></html>'),
    } as unknown as Page;

    const artifact = await captureBrowserDiagnostics({
      page,
      context,
      rootDir: root,
      traceStarted: true,
    });

    expect(artifact?.trace).toBe(true);
    expect(stop).toHaveBeenCalledTimes(1);
    const files = await readdir(artifact!.directory);
    expect(files).toContain('trace.zip');
  });

  it('discards an active trace without saving it', async () => {
    const stop = jest.fn().mockResolvedValue(undefined);
    await discardBrowserTrace({ tracing: { stop } } as unknown as BrowserContext, true);
    expect(stop).toHaveBeenCalledWith();
  });

  it('does not stop tracing when none was started', async () => {
    const stop = jest.fn().mockResolvedValue(undefined);
    await discardBrowserTrace({ tracing: { stop } } as unknown as BrowserContext, false);
    expect(stop).not.toHaveBeenCalled();
  });

  it('prunes incident directories older than the retention window', async () => {
    const old = await mkdtemp(join(root, 'incident-'));
    const longAgoSeconds = Date.now() / 1000 - 1000 * 3600;
    await utimes(old, longAgoSeconds, longAgoSeconds);
    const fresh = await mkdtemp(join(root, 'incident-'));

    await pruneBrowserDiagnostics(root, 72);

    const remaining = await readdir(root);
    expect(remaining).toContain(basename(fresh));
    expect(remaining).not.toContain(basename(old));
  });
});
