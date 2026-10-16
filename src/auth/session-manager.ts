import { chmod, lstat, mkdir, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { chromium, type BrowserContext, type Page } from 'playwright';
import type { AuthIdentity } from './auth.types';

type PersistentOptions = NonNullable<Parameters<typeof chromium.launchPersistentContext>[1]>;

/** Callers hold the existing distributed account lease for this object's lifetime. */
export class SessionManager {
  private context?: BrowserContext;
  private page?: Page;
  private options?: PersistentOptions;
  private profilePath?: string;
  private readonly root: string;

  constructor(root = resolve('profiles')) { this.root = resolve(root); }

  async open(identity: AuthIdentity, options: PersistentOptions,
    sessionCookies: Parameters<BrowserContext['addCookies']>[0] = []): Promise<Page> {
    if (this.context) throw new Error('Persistent profile already open');
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    if ((await lstat(this.root)).isSymbolicLink()) throw new Error('Profile root cannot be a symlink');
    await chmod(this.root, 0o700);
    const key = createHash('sha256').update(`${identity.platform}\0${identity.account}`).digest('hex');
    this.profilePath = join(await realpath(this.root), key);
    await mkdir(this.profilePath, { mode: 0o700, recursive: true });
    if ((await lstat(this.profilePath)).isSymbolicLink()) throw new Error('Profile cannot be a symlink');
    await chmod(this.profilePath, 0o700);
    this.options = { ...options, acceptDownloads: false, serviceWorkers: 'block',
      // Retain user-installed extensions. Do not remove automation flags.
      ignoreDefaultArgs: ['--disable-extensions'],
    };
    this.context = await chromium.launchPersistentContext(this.profilePath, this.options);
    // Chromium can discard session-only cookies when it exits. Restore only those
    // from the encrypted session store; persistent cookies remain owned by Chromium.
    const cookies = sessionCookies.filter((cookie) => cookie.expires === undefined || cookie.expires === -1);
    if (cookies.length > 0) await this.context.addCookies(cookies);
    this.page = this.context.pages().find((page) => !page.isClosed()) ?? await this.context.newPage();
    return this.page;
  }

  getContext(): BrowserContext {
    if (!this.context) throw new Error('Persistent profile is not open');
    return this.context;
  }

  getPage(): Page {
    if (!this.page) throw new Error('Persistent page is not open');
    return this.page;
  }

  getProfilePath(): string {
    if (!this.profilePath) throw new Error('Persistent profile is not open');
    return this.profilePath;
  }

  /** Chromium cannot change headless in place. Reopen the same profile, never rotate it. */
  async makeVisible(install: (context: BrowserContext) => Promise<void>, safeUrl: string): Promise<Page> {
    if (!this.options || !this.profilePath) throw new Error('Persistent profile is not open');
    if (!this.options.headless) return this.getPage();
    const sessionCookies = (await this.getContext().cookies()).filter((cookie) => cookie.expires === -1);
    await this.context?.close();
    this.context = undefined;
    this.options = { ...this.options, headless: false };
    this.context = await chromium.launchPersistentContext(this.profilePath, this.options);
    if (sessionCookies.length > 0) await this.context.addCookies(sessionCookies);
    await install(this.context);
    this.page = this.context.pages().find((page) => !page.isClosed()) ?? await this.context.newPage();
    await this.page.goto(safeUrl, { waitUntil: 'domcontentloaded' });
    return this.page;
  }

  async close(): Promise<void> {
    await this.context?.close().catch(() => undefined);
    this.context = undefined;
    this.page = undefined;
  }
}
