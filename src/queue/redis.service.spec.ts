import { ConfigService } from '@nestjs/config';
import { RedisService } from './redis.service';

describe('RedisService degraded test mode', () => {
  beforeEach(() => { process.env.SKIP_INFRA_CONNECT = 'true'; });
  afterEach(() => { delete process.env.SKIP_INFRA_CONNECT; });

  it('provides deterministic-safe local behavior without opening Redis', async () => {
    const service = new RedisService(new ConfigService({}));
    const token = await service.acquireLock('lock:test', 1000);
    expect(token).toBeTruthy();
    await expect(service.releaseLock('lock:test', token!)).resolves.toBe(true);
    await expect(service.consumeRateLimit('rate:test', 10, 60)).resolves.toEqual({ allowed: true, remaining: 9 });
    await expect(service.ping()).resolves.toBe(true);
  });
});
