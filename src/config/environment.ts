import { isIP } from 'node:net';
import { AI_PROVIDER_IDS, AiProvider, isAiProvider } from '../ai/ai-provider';
import { aiRoleSetting, DEFAULT_AI_APPROVER, DEFAULT_AI_REVIEWER, parseAiRole } from '../ai/content-approval';

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
  AI_DEFAULT_PROVIDER: AiProvider;
  AI_TIMEOUT_MS: number;
  OPENAI_API_KEY?: string;
  OPENAI_MODEL?: string;
  OPENAI_TIMEOUT_MS: number;
  DEEPSEEK_API_KEY?: string;
  DEEPSEEK_MODEL?: string;
  GEMINI_API_KEY?: string;
  GEMINI_MODEL?: string;
  GEMINI_FALLBACK_MODEL?: string;
  VPSTTT_AI_BASE_URL?: string;
  VPSTTT_AI_API_KEY?: string;
  VPSTTT_AI_MODEL?: string;
  VPSTTT_AI_TIMEOUT_MS: number;
  VPSTTT_AI_MAX_CONCURRENCY: number;
  VPSTTT_AI_RPM: number;
  /** `provider:model` of the reviewer, e.g. `vpsttt:claude:sonnet`. */
  AI_REVIEWER: string;
  /** `provider:model` of the final approver, e.g. `vpsttt:claude:opus`. */
  AI_APPROVER: string;
  AI_APPROVAL_ENABLED: boolean;
  MCP_ENABLED: boolean;
  MCP_ALLOW_PUBLISH: boolean;
  MCP_RATE_LIMIT_PER_MINUTE: number;
  EXTENSION_UI_RECOVERY_ENABLED: boolean;
  EXTENSION_UI_HINT_PROVIDER?: AiProvider;
  EXTENSION_UI_HINT_MIN_CONFIDENCE: number;
  EXTENSION_AI_FORM_FILL_ENABLED: boolean;
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

/** An AI role setting (`provider:model`), normalized; empty means the default. */
function parseAiRoleSetting(value: unknown, key: string, fallback: string): string {
  if (value !== undefined && typeof value !== 'string') throw new Error(`${key} must look like provider:model`);
  return aiRoleSetting(parseAiRole(value?.trim() || fallback, key));
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

/**
 * Base URL of the company IDE AI API, e.g. https://ide.example.com/ai-api/v1.
 * The API key travels with every request, so plain http is only accepted for a
 * loopback test server outside production.
 */
function parseVpstttAiBaseUrl(value: unknown, env: NodeEnvironment): string | undefined {
  if (value === undefined || (typeof value === 'string' && !value.trim())) return undefined;
  const parsed = parseHttpUrl(typeof value === 'string' ? value.trim() : value, 'VPSTTT_AI_BASE_URL');
  if (parsed.search || parsed.hash) throw new Error('VPSTTT_AI_BASE_URL must not contain a query or fragment');
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
  if (parsed.protocol !== 'https:' && !(env !== 'production' && loopback)) {
    throw new Error('VPSTTT_AI_BASE_URL must use https');
  }
  return parsed.toString().replace(/\/+$/, '');
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
  if (!isAiProvider(aiDefaultProvider)) {
    throw new Error(`AI_DEFAULT_PROVIDER must be one of: ${AI_PROVIDER_IDS.join(', ')}`);
  }
  const vpstttAiBaseUrl = parseVpstttAiBaseUrl(raw.VPSTTT_AI_BASE_URL, env);
  const vpstttAiTimeoutMs = parsePositiveInteger(raw.VPSTTT_AI_TIMEOUT_MS, 'VPSTTT_AI_TIMEOUT_MS', 180_000);
  // The IDE AI API gives up on a request after roughly 15 minutes.
  if (vpstttAiTimeoutMs > 900_000) throw new Error('VPSTTT_AI_TIMEOUT_MS must not exceed 900000');
  const vpstttAiMaxConcurrency = parsePositiveInteger(raw.VPSTTT_AI_MAX_CONCURRENCY, 'VPSTTT_AI_MAX_CONCURRENCY', 2);
  if (vpstttAiMaxConcurrency > 32) throw new Error('VPSTTT_AI_MAX_CONCURRENCY must not exceed 32');
  const vpstttAiRpm = parsePositiveInteger(raw.VPSTTT_AI_RPM, 'VPSTTT_AI_RPM', 10);
  if (vpstttAiRpm > 600) throw new Error('VPSTTT_AI_RPM must not exceed 600');
  // The writer is chosen per campaign; the reviewer and the final approver are
  // set only here, so a request cannot pick who judges its drafts.
  const aiReviewer = parseAiRoleSetting(raw.AI_REVIEWER, 'AI_REVIEWER', DEFAULT_AI_REVIEWER);
  const aiApprover = parseAiRoleSetting(raw.AI_APPROVER, 'AI_APPROVER', DEFAULT_AI_APPROVER);
  const aiApprovalEnabled = parseBoolean(raw.AI_APPROVAL_ENABLED, 'AI_APPROVAL_ENABLED', true);
  // The MCP endpoint for AI agents is off unless explicitly enabled; letting an
  // agent approve (= really publish) campaigns is a separate opt-in.
  const mcpEnabled = parseBoolean(raw.MCP_ENABLED, 'MCP_ENABLED', false);
  const mcpAllowPublish = parseBoolean(raw.MCP_ALLOW_PUBLISH, 'MCP_ALLOW_PUBLISH', false);
  const mcpRateLimitPerMinute = parsePositiveInteger(raw.MCP_RATE_LIMIT_PER_MINUTE, 'MCP_RATE_LIMIT_PER_MINUTE', 60);
  if (mcpRateLimitPerMinute > 600) throw new Error('MCP_RATE_LIMIT_PER_MINUTE must not exceed 600');
  // AI-assisted recovery when a composer field is not found on a redesigned page.
  const extensionUiRecoveryEnabled = parseBoolean(raw.EXTENSION_UI_RECOVERY_ENABLED, 'EXTENSION_UI_RECOVERY_ENABLED', false);
  const uiHintProviderRaw = typeof raw.EXTENSION_UI_HINT_PROVIDER === 'string' ? raw.EXTENSION_UI_HINT_PROVIDER.trim().toLowerCase() : '';
  if (uiHintProviderRaw && !isAiProvider(uiHintProviderRaw)) {
    throw new Error(`EXTENSION_UI_HINT_PROVIDER must be one of: ${AI_PROVIDER_IDS.join(', ')}`);
  }
  const uiHintMinConfidence = raw.EXTENSION_UI_HINT_MIN_CONFIDENCE === undefined ? 0.6 : Number(raw.EXTENSION_UI_HINT_MIN_CONFIDENCE);
  if (!Number.isFinite(uiHintMinConfidence) || uiHintMinConfidence < 0 || uiHintMinConfidence > 1) {
    throw new Error('EXTENSION_UI_HINT_MIN_CONFIDENCE must be between 0 and 1');
  }
  // AI picks the extra controls a post form requires (language, community, NSFW…).
  const extensionAiFormFillEnabled = parseBoolean(raw.EXTENSION_AI_FORM_FILL_ENABLED, 'EXTENSION_AI_FORM_FILL_ENABLED', true);
  const logLevel = typeof raw.LOG_LEVEL === 'string' ? raw.LOG_LEVEL : 'info';
  if (!['error', 'warn', 'info', 'debug', 'verbose'].includes(logLevel)) {
    throw new Error('LOG_LEVEL must be error, warn, info, debug, or verbose');
  }

  if (env === 'production' && raw.INLINE_PUBLISH_WORKER === 'true') {
    throw new Error('INLINE_PUBLISH_WORKER is a development/demo mode and cannot run in production');
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
  for (const key of ['INSTAGRAM_API_VERSION', 'THREADS_API_VERSION'] as const) {
    const value = raw[key];
    if (typeof value === 'string' && value.trim() && !/^v\d+\.\d+$/.test(value.trim())) {
      throw new Error(`${key} must look like v24.0`);
    }
  }
  if (typeof raw.ALERT_WEBHOOK_URL === 'string' && raw.ALERT_WEBHOOK_URL.trim()) {
    const alertUrl = parseHttpUrl(raw.ALERT_WEBHOOK_URL.trim(), 'ALERT_WEBHOOK_URL');
    if (env === 'production' && alertUrl.protocol !== 'https:') throw new Error('ALERT_WEBHOOK_URL must use https in production');
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
    VPSTTT_AI_BASE_URL: vpstttAiBaseUrl,
    VPSTTT_AI_TIMEOUT_MS: vpstttAiTimeoutMs,
    VPSTTT_AI_MAX_CONCURRENCY: vpstttAiMaxConcurrency,
    VPSTTT_AI_RPM: vpstttAiRpm,
    AI_REVIEWER: aiReviewer,
    AI_APPROVER: aiApprover,
    AI_APPROVAL_ENABLED: aiApprovalEnabled,
    MCP_ENABLED: mcpEnabled,
    MCP_ALLOW_PUBLISH: mcpAllowPublish,
    MCP_RATE_LIMIT_PER_MINUTE: mcpRateLimitPerMinute,
    EXTENSION_UI_RECOVERY_ENABLED: extensionUiRecoveryEnabled,
    EXTENSION_UI_HINT_PROVIDER: uiHintProviderRaw || undefined,
    EXTENSION_UI_HINT_MIN_CONFIDENCE: uiHintMinConfidence,
    EXTENSION_AI_FORM_FILL_ENABLED: extensionAiFormFillEnabled,
    OPENAI_TIMEOUT_MS: legacyOpenAiTimeoutMs,
  };
}
