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
  ])('rejects an invalid positive integer %s', (key, value) => {
    expect(() => validateEnvironment({ ...productionEnvironment(), [key]: value })).toThrow(key);
  });

  it.each([
    ['BROWSER_AUTOMATION_ENABLED', 'yes'],
    ['BROWSER_AUTOMATION_HEADLESS', '1'],
  ])('rejects an invalid browser automation boolean %s', (key, value) => {
    expect(() => validateEnvironment({ ...productionEnvironment(), [key]: value })).toThrow(key);
  });

  it('caps browser tasks so a worker cannot be occupied indefinitely', () => {
    expect(() => validateEnvironment({
      ...productionEnvironment(),
      BROWSER_AUTOMATION_TIMEOUT_MS: '300001',
    })).toThrow('BROWSER_AUTOMATION_TIMEOUT_MS');
  });

  it('rejects an unknown default AI provider', () => {
    expect(() => validateEnvironment({ ...productionEnvironment(), AI_DEFAULT_PROVIDER: 'unknown' }))
      .toThrow('AI_DEFAULT_PROVIDER');
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
});
