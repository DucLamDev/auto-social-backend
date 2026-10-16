import { Injectable } from '@nestjs/common';
import { CredentialsService } from '../../credentials/credentials.service';
import { BrowserStorageState } from './browser-automation.types';

const MAX_STORAGE_STATE_BYTES = 2 * 1024 * 1024;
const EMPTY_STORAGE_STATE: BrowserStorageState = { cookies: [], origins: [] };

@Injectable()
export class BrowserSessionStateStore {
  constructor(private readonly credentials: CredentialsService) {}

  load(accountId: string, seed?: unknown): Promise<BrowserStorageState> {
    if (!accountId.trim()) throw new Error('Platform account id is required for browser state');
    return Promise.resolve(seed === undefined ? { ...EMPTY_STORAGE_STATE } : this.normalize(seed));
  }

  async save(accountId: string, state: unknown, requireActive = false): Promise<void> {
    const storageState = this.normalize(state);
    if (requireActive) {
      await this.credentials.merge(accountId, { storageState }, { requireActive: true });
      return;
    }
    await this.credentials.merge(accountId, { storageState });
  }

  normalize(value: unknown): BrowserStorageState {
    return BrowserSessionStateStore.normalize(value);
  }

  static normalize(value: unknown): BrowserStorageState {
    let candidate = value;
    if (typeof candidate === 'string') {
      if (Buffer.byteLength(candidate, 'utf8') > MAX_STORAGE_STATE_BYTES) {
        throw new Error('Browser storage state exceeds 2 MiB');
      }
      try {
        candidate = JSON.parse(candidate) as unknown;
      } catch {
        throw new Error('Browser storage state must be valid JSON');
      }
    }
    const serialized = JSON.stringify(candidate);
    if (!serialized || Buffer.byteLength(serialized, 'utf8') > MAX_STORAGE_STATE_BYTES) {
      throw new Error('Browser storage state exceeds 2 MiB');
    }
    const parsed = JSON.parse(serialized) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Browser storage state must be an object');
    }
    const record = parsed as Record<string, unknown>;
    if (!Array.isArray(record.cookies) || !Array.isArray(record.origins)) {
      throw new Error('Browser storage state must contain cookies and origins arrays');
    }
    for (const cookie of record.cookies) {
      if (!cookie || typeof cookie !== 'object' || Array.isArray(cookie)) {
        throw new Error('Browser storage state contains an invalid cookie');
      }
      const item = cookie as Record<string, unknown>;
      for (const key of ['name', 'value', 'domain', 'path']) {
        if (typeof item[key] !== 'string') throw new Error(`Browser cookie ${key} must be a string`);
      }
    }
    for (const origin of record.origins) {
      if (!origin || typeof origin !== 'object' || Array.isArray(origin)) {
        throw new Error('Browser storage state contains an invalid origin');
      }
      const item = origin as Record<string, unknown>;
      if (typeof item.origin !== 'string' || !Array.isArray(item.localStorage)) {
        throw new Error('Browser storage origin is invalid');
      }
    }
    return parsed as BrowserStorageState;
  }

}
