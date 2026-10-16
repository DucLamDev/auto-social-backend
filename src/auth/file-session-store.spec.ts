import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrowserContext, Page } from 'playwright';
import { ConfigService } from '@nestjs/config';
import { CredentialEncryptionService } from '../credentials/credential-encryption.service';
import {
  FileSessionStore,
  captureAllowedStorageState,
  createPrivateFileSessionStore,
} from './file-session-store';

describe('Encrypted local browser session snapshot', () => {
  const identity = { platform: 'devto', account: 'fixture-account' };
  const state = {
    cookies: [{ name: 'session', value: 'fixture-cookie', domain: 'dev.to', path: '/' }],
    origins: [],
  };
  let directory: string;
  let store: FileSessionStore;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'file-session-fixture-'));
    const config = {
      get: (name: string, fallback?: string) =>
        name === 'CREDENTIAL_ENCRYPTION_KEY' ? Buffer.alloc(32, 42).toString('base64') : fallback,
    } as unknown as ConfigService;
    store = new FileSessionStore(new CredentialEncryptionService(config));
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('saves an encrypted private snapshot and restores the same identity', async () => {
    await store.save(directory, identity, state);
    expect(await readFile(join(directory, 'session.enc'), 'utf8')).not.toContain('fixture-cookie');
    expect((await stat(join(directory, 'session.enc'))).mode & 0o777).toBe(0o600);
    await expect(store.load(directory, identity)).resolves.toEqual(state);
  });
  it('does not transfer a session to another account', async () => {
    await store.save(directory, identity, state);
    await expect(
      store.load(directory, { ...identity, account: 'different-account' }),
    ).rejects.toThrow('unavailable or invalid');
  });
  it('creates a private local key and reuses it across separate runs', async () => {
    const first = await createPrivateFileSessionStore(directory);
    await first.save(directory, identity, state);
    const second = await createPrivateFileSessionStore(directory);
    await expect(second.load(directory, identity)).resolves.toEqual(state);
    expect((await stat(join(directory, '.session-key'))).mode & 0o777).toBe(0o600);
  });
  it('does not generate a key file when a dedicated environment key is provided', async () => {
    const configured = await createPrivateFileSessionStore(
      directory,
      Buffer.alloc(32, 11).toString('base64'),
    );
    await configured.save(directory, identity, state);
    await expect(stat(join(directory, '.session-key'))).rejects.toHaveProperty('code', 'ENOENT');
    await expect(createPrivateFileSessionStore(directory, 'invalid-key')).rejects.toThrow();
  });
  it('returns empty state for a fresh profile, but fails closed on corruption', async () => {
    await expect(store.load(directory, identity)).resolves.toEqual({ cookies: [], origins: [] });
    await writeFile(join(directory, 'session.enc'), 'invalid-ciphertext', { mode: 0o600 });
    await expect(store.load(directory, identity)).rejects.toThrow('unavailable or invalid');
  });
  it('never reads extension/local/unrelated storage when capturing an allowed session', async () => {
    const extensionEvaluate = jest.fn();
    const otherEvaluate = jest.fn();
    const allowedEvaluate = jest
      .fn()
      .mockResolvedValue([{ name: 'fixture-key', value: 'fixture-localStorage' }]);
    const page = (url: string, evaluate: jest.Mock) =>
      ({ isClosed: () => false, url: () => url, evaluate }) as unknown as Page;
    const cookies = jest.fn().mockResolvedValue(state.cookies);
    const context = {
      cookies,
      pages: () => [
        page('chrome-extension://fixture/options', extensionEvaluate),
        page('https://unrelated.example.com/', otherEvaluate),
        page('https://dev.to/new', allowedEvaluate),
      ],
    } as unknown as BrowserContext;
    await expect(
      captureAllowedStorageState(context, ['dev.to', 'accounts.google.com']),
    ).resolves.toEqual({
      cookies: state.cookies,
      origins: [
        {
          origin: 'https://dev.to',
          localStorage: [{ name: 'fixture-key', value: 'fixture-localStorage' }],
        },
      ],
    });
    expect(cookies).toHaveBeenCalledWith(['https://dev.to', 'https://accounts.google.com']);
    expect(extensionEvaluate).not.toHaveBeenCalled();
    expect(otherEvaluate).not.toHaveBeenCalled();
  });
});
