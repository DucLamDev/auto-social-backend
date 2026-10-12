import { ConfigService } from '@nestjs/config';
import { RedisService } from './redis.service';

describe('RedisService degraded test mode', () => {
  beforeEach(() => { process.env.SKIP_INFRA_CONNECT = 'true'; });
  afterEach(() => { delete process.env.SKIP_INFRA_CONNECT; });

  it('provides deterministic-safe local behavior without opening Redis', async () => {
    const service = new RedisService(new ConfigService({}));
    const token = await service.acquireLock('lock:test', 1000);
    expect(token).toBeTruthy();
    await expect(service.extendLock('lock:test', token!, 1000)).resolves.toBe(true);
    await expect(service.releaseLock('lock:test', token!)).resolves.toBe(true);
    await expect(service.consumeRateLimit('rate:test', 10, 60)).resolves.toEqual({ allowed: true, remaining: 9 });
    await expect(service.ping()).resolves.toBe(true);
  });

  it('extends a lock only when the supplied token still owns the Redis key', async () => {
    const service = new RedisService(new ConfigService({}));
    const evalCommand = jest.fn().mockResolvedValueOnce(0).mockResolvedValueOnce(1);
    Object.defineProperty(service, 'client', {
      configurable: true,
      value: { status: 'ready', eval: evalCommand },
    });

    await expect(service.extendLock('lock:publish:job-1', 'old-token', 120_000))
      .resolves.toBe(false);
    await expect(service.extendLock('lock:publish:job-1', 'current-token', 120_000))
      .resolves.toBe(true);

    expect(evalCommand).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("redis.call('get', KEYS[1]) == ARGV[1]"),
      1,
      'lock:publish:job-1',
      'old-token',
      120_000,
    );
  });
});
