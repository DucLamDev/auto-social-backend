import { chmod, lstat, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import type { BrowserContext } from 'playwright';
import { ConfigService } from '@nestjs/config';
import { CredentialEncryptionService } from '../credentials/credential-encryption.service';
import { BrowserSessionStateStore } from '../connectors/browser/browser-session-state.store';
import { hostnameMatches } from '../connectors/browser/browser-navigation-safety';
import type { BrowserStorageState } from '../connectors/browser/browser-automation.types';
import type { AuthIdentity } from './auth.types';

export class FileSessionStoreError extends Error {
  constructor() {
    super('Encrypted browser session is unavailable or invalid');
    this.name = 'FileSessionStoreError';
  }
}

/** Separate local keystore: never rotate or depend on the backend credential key. */
export async function createPrivateFileSessionStore(
  root: string,
  configuredKey?: string,
): Promise<FileSessionStore> {
  let key: Buffer | undefined;
  try {
    await mkdir(root, { recursive: true, mode: 0o700 });
    if ((await lstat(root)).isSymbolicLink()) throw new FileSessionStoreError();
    await chmod(root, 0o700);
    if (configuredKey) {
      key = Buffer.from(configuredKey, 'base64');
    } else {
      const path = join(root, '.session-key');
      try {
        key = randomBytes(32);
        await writeFile(path, key, { mode: 0o600, flag: 'wx' });
      } catch (error) {
        key?.fill(0);
        key = undefined;
        if (!(error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST'))
          throw new FileSessionStoreError();
      }
      const info = await lstat(path);
      if (
        !info.isFile() ||
        info.isSymbolicLink() ||
        info.size !== 32 ||
        (process.platform !== 'win32' && (info.mode & 0o077) !== 0)
      )
        throw new FileSessionStoreError();
      key?.fill(0);
      key = await readFile(path);
    }
    if (key.length !== 32) throw new FileSessionStoreError();
    return new FileSessionStore(
      new CredentialEncryptionService(
        new ConfigService({
          CREDENTIAL_ENCRYPTION_KEY: key.toString('base64'),
          CREDENTIAL_ENCRYPTION_KEY_VERSION: 'browser-local-v1',
        }),
      ),
    );
  } finally {
    key?.fill(0);
  }
}

/** Only explicit HTTPS origins are inspected. Authenticator extension pages/storage are excluded. */
export async function captureAllowedStorageState(
  context: BrowserContext,
  allowedHosts: readonly string[],
): Promise<BrowserStorageState> {
  const cookies = await context.cookies(allowedHosts.map((host) => `https://${host}`));
  const origins: BrowserStorageState['origins'] = [];
  const seen = new Set<string>();
  for (const page of context.pages()) {
    if (page.isClosed()) continue;
    let url: URL;
    try {
      url = new URL(page.url());
    } catch {
      continue;
    }
    if (
      url.protocol !== 'https:' ||
      !hostnameMatches(url.hostname, allowedHosts) ||
      seen.has(url.origin)
    )
      continue;
    const localStorage = await page.evaluate(() => {
      const values: Array<{ name: string; value: string }> = [];
      for (let index = 0; index < window.localStorage.length; index++) {
        const name = window.localStorage.key(index);
        if (name !== null) values.push({ name, value: window.localStorage.getItem(name) ?? '' });
      }
      return values;
    });
    origins.push({ origin: url.origin, localStorage });
    seen.add(url.origin);
  }
  return BrowserSessionStateStore.normalize({ cookies, origins });
}

/** Snapshot is encrypted, identity-bound and stored inside a private browser profile. */
export class FileSessionStore {
  constructor(
    private readonly encryption: Pick<CredentialEncryptionService, 'encrypt' | 'decrypt'>,
  ) {}

  async load(profilePath: string, identity: AuthIdentity): Promise<BrowserStorageState> {
    const file = join(profilePath, 'session.enc');
    try {
      const info = await lstat(file);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 3 * 1024 * 1024)
        throw new FileSessionStoreError();
      const decrypted = this.encryption.decrypt(await readFile(file, 'utf8'));
      if (decrypted.platform !== identity.platform || decrypted.account !== identity.account)
        throw new FileSessionStoreError();
      return BrowserSessionStateStore.normalize(decrypted.storageState);
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
        return { cookies: [], origins: [] };
      throw new FileSessionStoreError();
    }
  }

  async save(
    profilePath: string,
    identity: AuthIdentity,
    state: BrowserStorageState,
  ): Promise<void> {
    const ciphertext = this.encryption.encrypt({
      ...identity,
      storageState: BrowserSessionStateStore.normalize(state),
    });
    const file = join(profilePath, 'session.enc');
    const temporary = join(profilePath, `.session-${randomUUID()}.tmp`);
    await writeFile(temporary, ciphertext, { mode: 0o600, flag: 'wx' });
    await rename(temporary, file);
    await chmod(file, 0o600);
  }
}
