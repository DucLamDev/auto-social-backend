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
    JWT_ACCESS_SECRET: 'a'.repeat(32),
    JWT_REFRESH_SECRET: 'b'.repeat(32),
    CREDENTIAL_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
    S3_ENDPOINT: 'http://minio:9000',
    S3_PUBLIC_URL: 'https://media.example.com/publisher',
    S3_REGION: 'us-east-1',
    S3_ACCESS_KEY: 'publisher-access',
    S3_SECRET_KEY: 'strong-storage-secret',
    S3_BUCKET: 'publisher',
    OAUTH_REDIRECT_BASE_URL: 'https://api.example.com/api/v1/oauth',
    LINKEDIN_API_VERSION: '202610',
  };
}

describe('validateEnvironment', () => {
  it('accepts explicit public production origins and internal S3 transport', () => {
    expect(validateEnvironment(productionEnvironment())).toMatchObject({
      NODE_ENV: 'production', PORT: 3001, LOG_LEVEL: 'info',
    });
  });

  it.each([
    ['FRONTEND_URL', 'http://localhost:3000'],
    ['S3_PUBLIC_URL', 'http://minio:9000/publisher'],
    ['OAUTH_REDIRECT_BASE_URL', 'https://127.0.0.1/api/v1/oauth'],
  ])('rejects an unsafe production %s', (key, value) => {
    expect(() => validateEnvironment({ ...productionEnvironment(), [key]: value })).toThrow(key);
  });
});
