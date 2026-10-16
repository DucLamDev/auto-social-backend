import { isIP } from 'node:net';

export type NodeEnvironment = 'development' | 'test' | 'production';

export interface Environment {
  NODE_ENV: NodeEnvironment;
  PORT: number;
  LOG_LEVEL: 'error' | 'warn' | 'info' | 'debug' | 'verbose';
  FRONTEND_URL: string;
  DATABASE_URL: string;
  REDIS_URL: string;
  RABBITMQ_URL: string;
  RABBITMQ_PREFETCH: number;
  JWT_ACCESS_SECRET: string;
  JWT_REFRESH_SECRET: string;
  CREDENTIAL_ENCRYPTION_KEY: string;
  AI_DEFAULT_PROVIDER: 'openai' | 'deepseek' | 'gemini';
  AI_TIMEOUT_MS: number;
  OPENAI_API_KEY?: string;
  OPENAI_MODEL?: string;
  OPENAI_TIMEOUT_MS: number;
  DEEPSEEK_API_KEY?: string;
  DEEPSEEK_MODEL?: string;
  GEMINI_API_KEY?: string;
  GEMINI_MODEL?: string;
  GEMINI_FALLBACK_MODEL?: string;
  S3_ENDPOINT: string;
  S3_PUBLIC_URL: string;
  S3_REGION: string;
  S3_ACCESS_KEY: string;
  S3_SECRET_KEY: string;
  S3_BUCKET: string;
  OAUTH_REDIRECT_BASE_URL: string;
  BROWSER_AUTOMATION_ENABLED: boolean;
  BROWSER_AUTOMATION_HEADLESS: boolean;
  BROWSER_AUTOMATION_TIMEOUT_MS: number;
  BROWSER_AUTH_RECOVERY_ENABLED: boolean;
  AUTH_WAIT_TIMEOUT: number;
  CAPTCHA_WAIT_TIMEOUT: number;
  MAX_AUTH_ATTEMPTS: number;
  PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH?: string;
}

const REQUIRED_IN_PRODUCTION = [
  'FRONTEND_URL',
  'DATABASE_URL',
  'REDIS_URL',
  'RABBITMQ_URL',
  'JWT_ACCESS_SECRET',
  'JWT_REFRESH_SECRET',
  'CREDENTIAL_ENCRYPTION_KEY',
  'S3_ENDPOINT',
  'S3_PUBLIC_URL',
  'S3_REGION',
  'S3_ACCESS_KEY',
  'S3_SECRET_KEY',
  'S3_BUCKET',
  'OAUTH_REDIRECT_BASE_URL',
] as const;

const PLACEHOLDER_FRAGMENTS = ['change_me', 'changeme', 'replace-with'];

function parseHttpUrl(value: unknown, key: string): URL {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${key} must be a URL`);
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${key} must be an absolute URL`);
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error(`${key} must use http or https`);
  if (parsed.username || parsed.password) throw new Error(`${key} must not contain credentials`);
  return parsed;
}

function parsePositiveInteger(value: unknown, key: string, fallback: number): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${key} must be a positive integer`);
  }
  return parsed;
}

function parseBoolean(value: unknown, key: string, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true') return true;
    if (normalized === 'false') return false;
  }
  throw new Error(`${key} must be true or false`);
}

function isPrivateOrLocalHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return true;
  if (isIP(host) === 0 && !host.includes('.')) return true;
  if (host === '::' || host === '::1') return true;
  if (host.startsWith('fc') || host.startsWith('fd') || /^fe[89ab]/.test(host) || host.startsWith('ff')) return true;
  if (host.startsWith('2001:db8:')) return true;
  if (host.startsWith('::ffff:')) return isPrivateOrLocalHost(host.slice(7));
  if (host === '0.0.0.0') return true;
  const octets = host.split('.').map(Number);
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  return octets[0] === 0
    || octets[0] === 10
    || octets[0] === 127
    || (octets[0] === 100 && (octets[1] ?? 0) >= 64 && (octets[1] ?? 0) <= 127)
    || (octets[0] === 169 && octets[1] === 254)
    || (octets[0] === 172 && (octets[1] ?? 0) >= 16 && (octets[1] ?? 0) <= 31)
    || (octets[0] === 192 && (octets[1] === 0 || octets[1] === 168))
    || (octets[0] === 198 && (octets[1] === 18 || octets[1] === 19))
    || (octets[0] ?? 0) >= 224;
}

function validatePublicHttpsUrl(value: unknown, key: string): void {
  const parsed = parseHttpUrl(value, key);
  if (parsed.protocol !== 'https:') throw new Error(`${key} must use https in production`);
  if (isPrivateOrLocalHost(parsed.hostname)) throw new Error(`${key} must use a public hostname in production`);
}

export function validateEnvironment(raw: Record<string, unknown>): Record<string, unknown> {
  const envValue = typeof raw.NODE_ENV === 'string' ? raw.NODE_ENV : 'development';
  const env = envValue as NodeEnvironment;
  if (!['development', 'test', 'production'].includes(env)) {
    throw new Error('NODE_ENV must be development, test, or production');
  }
  const port = Number(raw.PORT ?? 3001);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT is invalid');
  const rabbitmqPrefetch = parsePositiveInteger(raw.RABBITMQ_PREFETCH, 'RABBITMQ_PREFETCH', 10);
  const browserAutomationEnabled = parseBoolean(raw.BROWSER_AUTOMATION_ENABLED, 'BROWSER_AUTOMATION_ENABLED', false);
  const authRecoveryEnabled = parseBoolean(raw.BROWSER_AUTH_RECOVERY_ENABLED, 'BROWSER_AUTH_RECOVERY_ENABLED', false);
  const authWaitTimeout = parsePositiveInteger(raw.AUTH_WAIT_TIMEOUT, 'AUTH_WAIT_TIMEOUT', 300_000);
  const captchaWaitTimeout = parsePositiveInteger(raw.CAPTCHA_WAIT_TIMEOUT, 'CAPTCHA_WAIT_TIMEOUT', 300_000);
  const maxAuthAttempts = parsePositiveInteger(raw.MAX_AUTH_ATTEMPTS, 'MAX_AUTH_ATTEMPTS', 3);
  if (authWaitTimeout > 900_000 || captchaWaitTimeout > 900_000) {
    throw new Error('Authentication wait timeouts must not exceed 900000');
  }
  if (maxAuthAttempts > 3) throw new Error('MAX_AUTH_ATTEMPTS must not exceed 3');
  const browserAutomationHeadless = parseBoolean(raw.BROWSER_AUTOMATION_HEADLESS, 'BROWSER_AUTOMATION_HEADLESS', true);
  const browserAutomationTimeoutMs = parsePositiveInteger(
    raw.BROWSER_AUTOMATION_TIMEOUT_MS,
    'BROWSER_AUTOMATION_TIMEOUT_MS',
    90_000,
  );
  if (browserAutomationTimeoutMs > 300_000) {
    throw new Error('BROWSER_AUTOMATION_TIMEOUT_MS must not exceed 300000');
  }
  const browserDiagnosticsEnabled = parseBoolean(
    raw.BROWSER_DIAGNOSTICS_ENABLED,
    'BROWSER_DIAGNOSTICS_ENABLED',
    true,
  );
  const browserDiagnosticsDir =
    typeof raw.BROWSER_DIAGNOSTICS_DIR === 'string' && raw.BROWSER_DIAGNOSTICS_DIR.trim()
      ? raw.BROWSER_DIAGNOSTICS_DIR.trim()
      : undefined;
  const browserDiagnosticsRetentionHours = parsePositiveInteger(
    raw.BROWSER_DIAGNOSTICS_RETENTION_HOURS,
    'BROWSER_DIAGNOSTICS_RETENTION_HOURS',
    72,
  );
  const legacyOpenAiTimeoutMs = parsePositiveInteger(raw.OPENAI_TIMEOUT_MS, 'OPENAI_TIMEOUT_MS', 60_000);
  const aiTimeoutMs = raw.AI_TIMEOUT_MS === undefined
    ? legacyOpenAiTimeoutMs
    : parsePositiveInteger(raw.AI_TIMEOUT_MS, 'AI_TIMEOUT_MS', 60_000);
  const aiDefaultProvider = typeof raw.AI_DEFAULT_PROVIDER === 'string'
    ? raw.AI_DEFAULT_PROVIDER.trim().toLowerCase()
    : 'openai';
  if (!['openai', 'deepseek', 'gemini'].includes(aiDefaultProvider)) {
    throw new Error('AI_DEFAULT_PROVIDER must be openai, deepseek, or gemini');
  }
  const logLevel = typeof raw.LOG_LEVEL === 'string' ? raw.LOG_LEVEL : 'info';
  if (!['error', 'warn', 'info', 'debug', 'verbose'].includes(logLevel)) {
    throw new Error('LOG_LEVEL must be error, warn, info, debug, or verbose');
  }

  if (env === 'production') {
    for (const key of REQUIRED_IN_PRODUCTION) {
      if (typeof raw[key] !== 'string' || raw[key].length === 0) {
        throw new Error(`${key} is required in production`);
      }
      const value = String(raw[key]).toLowerCase();
      if (PLACEHOLDER_FRAGMENTS.some((placeholder) => value.includes(placeholder))) {
        throw new Error(`${key} contains an unsafe placeholder value`);
      }
    }
    for (const key of ['JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET'] as const) {
      if (String(raw[key]).length < 32) throw new Error(`${key} must have at least 32 characters`);
    }
    const encryptionKey = Buffer.from(String(raw.CREDENTIAL_ENCRYPTION_KEY), 'base64');
    if (encryptionKey.length !== 32) {
      throw new Error('CREDENTIAL_ENCRYPTION_KEY must be a base64 encoded 32-byte key');
    }
    for (const frontendUrl of String(raw.FRONTEND_URL).split(',').map((value) => value.trim())) {
      validatePublicHttpsUrl(frontendUrl, 'FRONTEND_URL');
    }
    validatePublicHttpsUrl(raw.S3_PUBLIC_URL, 'S3_PUBLIC_URL');
    validatePublicHttpsUrl(raw.OAUTH_REDIRECT_BASE_URL, 'OAUTH_REDIRECT_BASE_URL');
    parseHttpUrl(raw.S3_ENDPOINT, 'S3_ENDPOINT');
  }
  if (typeof raw.LINKEDIN_API_VERSION === 'string' && raw.LINKEDIN_API_VERSION && !/^\d{6}$/.test(raw.LINKEDIN_API_VERSION)) {
    throw new Error('LINKEDIN_API_VERSION must use YYYYMM');
  }
  return {
    ...raw,
    NODE_ENV: env,
    PORT: port,
    LOG_LEVEL: logLevel,
    RABBITMQ_PREFETCH: rabbitmqPrefetch,
    BROWSER_AUTOMATION_ENABLED: browserAutomationEnabled,
    BROWSER_AUTH_RECOVERY_ENABLED: authRecoveryEnabled,
    AUTH_WAIT_TIMEOUT: authWaitTimeout,
    CAPTCHA_WAIT_TIMEOUT: captchaWaitTimeout,
    MAX_AUTH_ATTEMPTS: maxAuthAttempts,
    BROWSER_AUTOMATION_HEADLESS: browserAutomationHeadless,
    BROWSER_AUTOMATION_TIMEOUT_MS: browserAutomationTimeoutMs,
    BROWSER_DIAGNOSTICS_ENABLED: browserDiagnosticsEnabled,
    BROWSER_DIAGNOSTICS_DIR: browserDiagnosticsDir,
    BROWSER_DIAGNOSTICS_RETENTION_HOURS: browserDiagnosticsRetentionHours,
    AI_DEFAULT_PROVIDER: aiDefaultProvider,
    AI_TIMEOUT_MS: aiTimeoutMs,
    OPENAI_TIMEOUT_MS: legacyOpenAiTimeoutMs,
  };
}
