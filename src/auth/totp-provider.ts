import { createHmac } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

export type OtpProvider = (signal: AbortSignal) => Promise<string>;
type TotpAlgorithm = 'SHA1' | 'SHA256' | 'SHA512';

export class TotpConfigurationError extends Error {
  constructor() {
    super('TOTP configuration is missing or invalid; configure the account secret securely');
    this.name = 'TotpConfigurationError';
  }
}

interface TotpConfig {
  secret: string;
  algorithm: TotpAlgorithm;
  digits: 6 | 8;
  period: number;
}

function parseConfig(value: string): TotpConfig {
  const config: TotpConfig = { secret: value, algorithm: 'SHA1', digits: 6, period: 30 };
  if (value.toLowerCase().startsWith('otpauth://')) {
    try {
      const uri = new URL(value);
      if (uri.protocol !== 'otpauth:' || uri.hostname !== 'totp' || uri.username || uri.password) throw new TotpConfigurationError();
      config.secret = uri.searchParams.get('secret') ?? '';
      const algorithm = (uri.searchParams.get('algorithm') ?? 'SHA1').toUpperCase();
      const digits = Number(uri.searchParams.get('digits') ?? 6);
      const period = Number(uri.searchParams.get('period') ?? 30);
      if (!['SHA1', 'SHA256', 'SHA512'].includes(algorithm) || ![6, 8].includes(digits)
        || !Number.isSafeInteger(period) || period < 15 || period > 120) throw new TotpConfigurationError();
      config.algorithm = algorithm as TotpAlgorithm;
      config.digits = digits as 6 | 8;
      config.period = period;
    } catch { throw new TotpConfigurationError(); }
  }
  return config;
}

function decodeBase32(secret: string): Buffer {
  const text = secret.replace(/\s/g, '').toUpperCase();
  if (text.length > 256 || !/^[A-Z2-7]+={0,6}$/.test(text)) throw new TotpConfigurationError();
  const letters = text.replace(/=+$/, '');
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const bytes: number[] = [];
  let bits = 0;
  let value = 0;
  for (const letter of letters) {
    value = (value << 5) | alphabet.indexOf(letter);
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((value >>> bits) & 255);
      value &= (1 << bits) - 1;
    }
  }
  // Reject noncanonical trailing bits and accept legacy 80-bit authenticator seeds.
  if (value !== 0 || bytes.length < 10 || bytes.length > 128 || ![0, 2, 4, 5, 7].includes(letters.length % 8)) {
    bytes.fill(0);
    throw new TotpConfigurationError();
  }
  const decoded = Buffer.from(bytes);
  bytes.fill(0);
  return decoded;
}

/** RFC 6238. The seed is supplied by the account owner; no extension/browser secret is read. */
export function generateTotp(value: string, timeMs = Date.now()): string {
  if (!Number.isSafeInteger(timeMs) || timeMs < 0) throw new TotpConfigurationError();
  const config = parseConfig(value);
  const key = decodeBase32(config.secret);
  const counter = Buffer.alloc(8);
  let digest: Buffer | undefined;
  try {
    counter.writeBigUInt64BE(BigInt(Math.floor(timeMs / 1000 / config.period)));
    digest = createHmac(config.algorithm.toLowerCase(), key).update(counter).digest();
    const offset = digest[digest.length - 1]! & 15;
    const number = digest.readUInt32BE(offset) & 0x7fffffff;
    return String(number % (10 ** config.digits)).padStart(config.digits, '0');
  } finally {
    key.fill(0);
    counter.fill(0);
    digest?.fill(0);
    config.secret = '';
  }
}

export function accountTotpEnvironmentKey(accountId: string): string {
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(accountId)) throw new TotpConfigurationError();
  return `BROWSER_TOTP_SECRET_${accountId.replace(/-/g, '_').toUpperCase()}`;
}

/** The env name is derived from the account UUID, so account JSON cannot reference another account's secret. */
export function createAccountTotpProvider(
  accountId: string,
  settings: Record<string, unknown>,
  readSecret: (name: string) => unknown,
): OtpProvider | undefined {
  if (settings.browserAutoTotp !== true) return undefined;
  const name = accountTotpEnvironmentKey(accountId);
  return async (signal) => {
    if (signal.aborted) throw new Error('TOTP request cancelled');
    let secret: string | undefined;
    let config: TotpConfig | undefined;
    try {
      const loaded = readSecret(name);
      if (typeof loaded !== 'string' || !loaded.trim()) throw new TotpConfigurationError();
      secret = loaded.trim();
      config = parseConfig(secret);
      const periodMs = config.period * 1000;
      const remaining = periodMs - (Date.now() % periodMs);
      // Use one current time window only. Do not try neighboring codes or retry a rejection.
      if (remaining < 5000) await delay(remaining + 100, undefined, { signal });
      if (signal.aborted) throw new Error('TOTP request cancelled');
      return generateTotp(secret);
    } finally {
      secret = undefined;
      if (config) config.secret = '';
    }
  };
}
