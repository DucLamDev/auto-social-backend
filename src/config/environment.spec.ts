import { validateEnvironment } from './environment';

function productionEnvironment(): Record<string, unknown> {
  return {
    NODE_ENV: 'production',
    PORT: '3001',
    LOG_LEVEL: 'info',
    FRONTEND_URL: 'https://app.example.com',
    DATABASE_URL: 'postgresql://publisher:strong-password@postgres:5432/publisher',
    REDIS_URL: 'redis://:strong-password@redis:6379',
    RABBITMQ_URL: 'amqp://publisher:strong-password@rabbitmq:5672',
    RABBITMQ_PREFETCH: '10',
    JWT_ACCESS_SECRET: 'a'.repeat(32),
    JWT_REFRESH_SECRET: 'b'.repeat(32),
    CREDENTIAL_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
    AI_DEFAULT_PROVIDER: 'openai',
    AI_TIMEOUT_MS: '60000',
    OPENAI_TIMEOUT_MS: '60000',
    S3_ENDPOINT: 'http://minio:9000',
    S3_PUBLIC_URL: 'https://media.example.com/publisher',
    S3_REGION: 'us-east-1',
    S3_ACCESS_KEY: 'publisher-access',
    S3_SECRET_KEY: 'strong-storage-secret',
    S3_BUCKET: 'publisher',
    OAUTH_REDIRECT_BASE_URL: 'https://api.example.com/api/v1/oauth',
    LINKEDIN_API_VERSION: '202610',
    BROWSER_AUTOMATION_ENABLED: 'true',
    BROWSER_AUTOMATION_HEADLESS: 'true',
    BROWSER_AUTOMATION_TIMEOUT_MS: '90000',
  };
}

describe('validateEnvironment', () => {
  it('accepts explicit public production origins and internal S3 transport', () => {
    expect(validateEnvironment(productionEnvironment())).toMatchObject({
      NODE_ENV: 'production',
      PORT: 3001,
      LOG_LEVEL: 'info',
      RABBITMQ_PREFETCH: 10,
      AI_DEFAULT_PROVIDER: 'openai',
      AI_TIMEOUT_MS: 60_000,
      OPENAI_TIMEOUT_MS: 60_000,
      BROWSER_AUTOMATION_ENABLED: true,
      BROWSER_AUTOMATION_HEADLESS: true,
      BROWSER_AUTOMATION_TIMEOUT_MS: 90_000,
    });
  });

  it.each([
    ['RABBITMQ_PREFETCH', '0'],
    ['RABBITMQ_PREFETCH', '1.5'],
    ['RABBITMQ_PREFETCH', 'not-a-number'],
    ['OPENAI_TIMEOUT_MS', '-1'],
    ['OPENAI_TIMEOUT_MS', 'Infinity'],
    ['AI_TIMEOUT_MS', '0'],
    ['BROWSER_AUTOMATION_TIMEOUT_MS', '0'],
    ['AUTH_WAIT_TIMEOUT', '0'],
    ['CAPTCHA_WAIT_TIMEOUT', 'Infinity'],
    ['MAX_AUTH_ATTEMPTS', '1.5'],
  ])('rejects an invalid positive integer %s', (key, value) => {
    expect(() => validateEnvironment({ ...productionEnvironment(), [key]: value })).toThrow(key);
  });

  it.each([
    ['BROWSER_AUTOMATION_ENABLED', 'yes'],
    ['BROWSER_AUTOMATION_HEADLESS', '1'],
    ['BROWSER_AUTH_RECOVERY_ENABLED', 'yes'],
  ])('rejects an invalid browser automation boolean %s', (key, value) => {
    expect(() => validateEnvironment({ ...productionEnvironment(), [key]: value })).toThrow(key);
  });

  it('caps browser tasks so a worker cannot be occupied indefinitely', () => {
    expect(() => validateEnvironment({
      ...productionEnvironment(),
      BROWSER_AUTOMATION_TIMEOUT_MS: '300001',
    })).toThrow('BROWSER_AUTOMATION_TIMEOUT_MS');
  });

  it('caps recovery timeouts and OTP attempts', () => {
    expect(() => validateEnvironment({ ...productionEnvironment(), AUTH_WAIT_TIMEOUT: '900001' })).toThrow('timeouts');
    expect(() => validateEnvironment({ ...productionEnvironment(), MAX_AUTH_ATTEMPTS: '4' })).toThrow('MAX_AUTH_ATTEMPTS');
    expect(validateEnvironment({ NODE_ENV: 'test' })).toMatchObject({
      BROWSER_AUTH_RECOVERY_ENABLED: false, AUTH_WAIT_TIMEOUT: 300000, CAPTCHA_WAIT_TIMEOUT: 300000, MAX_AUTH_ATTEMPTS: 3,
    });
  });

  it('rejects an unknown default AI provider', () => {
    expect(() => validateEnvironment({ ...productionEnvironment(), AI_DEFAULT_PROVIDER: 'unknown' }))
      .toThrow('AI_DEFAULT_PROVIDER');
  });

  it('accepts the IDE AI API as default provider over https and applies its limits', () => {
    expect(validateEnvironment({
      ...productionEnvironment(), AI_DEFAULT_PROVIDER: 'VPSTTT', VPSTTT_AI_BASE_URL: 'https://ide.example.com/ai-api/v1/',
    })).toMatchObject({
      AI_DEFAULT_PROVIDER: 'vpsttt', VPSTTT_AI_BASE_URL: 'https://ide.example.com/ai-api/v1',
      VPSTTT_AI_TIMEOUT_MS: 180_000, VPSTTT_AI_MAX_CONCURRENCY: 2, VPSTTT_AI_RPM: 10,
    });
    expect(validateEnvironment({ NODE_ENV: 'test' })).toMatchObject({ VPSTTT_AI_BASE_URL: undefined });
  });

  it('refuses an IDE AI API address that would leak the key or hide parameters', () => {
    expect(() => validateEnvironment({ ...productionEnvironment(), VPSTTT_AI_BASE_URL: 'http://ide.example.com/ai-api/v1' }))
      .toThrow('VPSTTT_AI_BASE_URL must use https');
    expect(() => validateEnvironment({ ...productionEnvironment(), VPSTTT_AI_BASE_URL: 'http://127.0.0.1:3923/v1' }))
      .toThrow('VPSTTT_AI_BASE_URL must use https');
    expect(validateEnvironment({ NODE_ENV: 'test', VPSTTT_AI_BASE_URL: 'http://127.0.0.1:3923/v1' }))
      .toMatchObject({ VPSTTT_AI_BASE_URL: 'http://127.0.0.1:3923/v1' });
    expect(() => validateEnvironment({ ...productionEnvironment(), VPSTTT_AI_BASE_URL: 'https://ide.example.com/ai-api/v1?key=x' }))
      .toThrow('query');
    expect(() => validateEnvironment({ ...productionEnvironment(), VPSTTT_AI_BASE_URL: 'https://user:pass@ide.example.com/ai-api/v1' }))
      .toThrow('credentials');
    expect(() => validateEnvironment({ ...productionEnvironment(), VPSTTT_AI_TIMEOUT_MS: '900001' })).toThrow('VPSTTT_AI_TIMEOUT_MS');
    expect(() => validateEnvironment({ ...productionEnvironment(), VPSTTT_AI_MAX_CONCURRENCY: '33' })).toThrow('VPSTTT_AI_MAX_CONCURRENCY');
    expect(() => validateEnvironment({ ...productionEnvironment(), VPSTTT_AI_RPM: '0' })).toThrow('VPSTTT_AI_RPM');
  });

  it('defaults both the reviewer and the final approver to Claude Opus on VPSTTT AI, with approval on', () => {
    expect(validateEnvironment({ NODE_ENV: 'test' })).toMatchObject({
      AI_REVIEWER: 'vpsttt:claude:opus', AI_APPROVER: 'vpsttt:claude:opus', AI_APPROVAL_ENABLED: true,
    });
    expect(validateEnvironment({ ...productionEnvironment(), AI_REVIEWER: ' ', AI_APPROVER: '' }))
      .toMatchObject({ AI_REVIEWER: 'vpsttt:claude:opus', AI_APPROVER: 'vpsttt:claude:opus' });
  });

  it('normalizes configured AI roles and the approval switch', () => {
    expect(validateEnvironment({
      ...productionEnvironment(), AI_REVIEWER: ' VPSTTT:claude:haiku ', AI_APPROVER: 'openai', AI_APPROVAL_ENABLED: 'false',
    })).toMatchObject({ AI_REVIEWER: 'vpsttt:claude:haiku', AI_APPROVER: 'openai', AI_APPROVAL_ENABLED: false });
    expect(validateEnvironment({ ...productionEnvironment(), AI_APPROVER: 'gemini:gemini-3.5-pro' })).toMatchObject({ AI_APPROVER: 'gemini:gemini-3.5-pro' });
  });

  it.each([
    ['AI_REVIEWER', 'anthropic:claude-opus'],
    ['AI_APPROVER', 'claude:opus'],
    ['AI_APPROVAL_ENABLED', 'yes'],
  ])('refuses an invalid %s at startup', (key, value) => {
    expect(() => validateEnvironment({ ...productionEnvironment(), [key]: value })).toThrow(key);
  });

  it('keeps the MCP endpoint and agent publishing off unless enabled', () => {
    expect(validateEnvironment({ NODE_ENV: 'test' })).toMatchObject({ MCP_ENABLED: false, MCP_ALLOW_PUBLISH: false, MCP_RATE_LIMIT_PER_MINUTE: 60 });
    expect(validateEnvironment({ ...productionEnvironment(), MCP_ENABLED: 'true', MCP_ALLOW_PUBLISH: 'false' }))
      .toMatchObject({ MCP_ENABLED: true, MCP_ALLOW_PUBLISH: false });
    expect(() => validateEnvironment({ ...productionEnvironment(), MCP_ENABLED: 'yes' })).toThrow('MCP_ENABLED');
    expect(() => validateEnvironment({ ...productionEnvironment(), MCP_RATE_LIMIT_PER_MINUTE: '601' })).toThrow('MCP_RATE_LIMIT_PER_MINUTE');
  });

  it('keeps AI-assisted UI recovery off by default and validates its provider and threshold', () => {
    expect(validateEnvironment({ NODE_ENV: 'test' })).toMatchObject({ EXTENSION_UI_RECOVERY_ENABLED: false, EXTENSION_UI_HINT_MIN_CONFIDENCE: 0.6, EXTENSION_UI_HINT_PROVIDER: undefined });
    expect(validateEnvironment({ ...productionEnvironment(), EXTENSION_UI_RECOVERY_ENABLED: 'true', EXTENSION_UI_HINT_PROVIDER: 'VPSTTT', EXTENSION_UI_HINT_MIN_CONFIDENCE: '0.75' }))
      .toMatchObject({ EXTENSION_UI_RECOVERY_ENABLED: true, EXTENSION_UI_HINT_PROVIDER: 'vpsttt', EXTENSION_UI_HINT_MIN_CONFIDENCE: 0.75 });
    expect(() => validateEnvironment({ ...productionEnvironment(), EXTENSION_UI_HINT_PROVIDER: 'other' })).toThrow('EXTENSION_UI_HINT_PROVIDER');
    expect(() => validateEnvironment({ ...productionEnvironment(), EXTENSION_UI_HINT_MIN_CONFIDENCE: '1.5' })).toThrow('EXTENSION_UI_HINT_MIN_CONFIDENCE');
    // AI form filling (language, community…) is on unless switched off.
    expect(validateEnvironment({ NODE_ENV: 'test' })).toMatchObject({ EXTENSION_AI_FORM_FILL_ENABLED: true });
    expect(validateEnvironment({ ...productionEnvironment(), EXTENSION_AI_FORM_FILL_ENABLED: 'false' })).toMatchObject({ EXTENSION_AI_FORM_FILL_ENABLED: false });
    expect(() => validateEnvironment({ ...productionEnvironment(), EXTENSION_AI_FORM_FILL_ENABLED: 'maybe' })).toThrow('EXTENSION_AI_FORM_FILL_ENABLED');
  });

  it('uses the legacy OpenAI timeout when AI_TIMEOUT_MS is absent', () => {
    const environment = productionEnvironment();
    delete environment.AI_TIMEOUT_MS;
    expect(validateEnvironment(environment)).toMatchObject({ AI_TIMEOUT_MS: 60_000 });
  });

  it.each([
    ['FRONTEND_URL', 'http://localhost:3000'],
    ['S3_PUBLIC_URL', 'http://minio:9000/publisher'],
    ['OAUTH_REDIRECT_BASE_URL', 'https://127.0.0.1/api/v1/oauth'],
  ])('rejects an unsafe production %s', (key, value) => {
    expect(() => validateEnvironment({ ...productionEnvironment(), [key]: value })).toThrow(key);
  });

  it.each([
    ['THREADS_API_VERSION', '1.0'],
    ['INSTAGRAM_API_VERSION', 'latest'],
    ['ALERT_WEBHOOK_URL', 'http://hooks.example.com/alert'],
  ])('rejects an invalid %s', (key, value) => {
    expect(() => validateEnvironment({ ...productionEnvironment(), [key]: value })).toThrow(key);
  });

  it('accepts Meta API versions and an HTTPS alert webhook', () => {
    expect(() => validateEnvironment({
      ...productionEnvironment(),
      THREADS_API_VERSION: 'v1.0',
      INSTAGRAM_API_VERSION: 'v24.0',
      ALERT_WEBHOOK_URL: 'https://hooks.example.com/alert',
    })).not.toThrow();
  });
});
