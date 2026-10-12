import { RedisLockLease } from './redis-lock-lease';
import { RedisService } from './redis.service';

describe('RedisLockLease', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('renews a token-owned lock before its TTL and stops cleanly', async () => {
    jest.useFakeTimers();
    const extendLock = jest.fn().mockResolvedValue(true);
    const onRenewed = jest.fn().mockResolvedValue(undefined);
    const lease = new RedisLockLease(
      { extendLock } as unknown as RedisService,
      'lock:publish:job-1',
      'owner-token',
      9_000,
      { onRenewed },
    );

    lease.start();
    await jest.advanceTimersByTimeAsync(3_000);

    expect(extendLock).toHaveBeenCalledWith(
      'lock:publish:job-1',
      'owner-token',
      9_000,
    );
    expect(onRenewed).toHaveBeenCalledTimes(1);
    expect(lease.isOwned()).toBe(true);

    await lease.stop();
    await jest.advanceTimersByTimeAsync(12_000);
    expect(extendLock).toHaveBeenCalledTimes(1);
  });

  it('marks the lease lost when the token no longer owns the Redis key', async () => {
    const onLost = jest.fn().mockResolvedValue(undefined);
    const lease = new RedisLockLease(
      { extendLock: jest.fn().mockResolvedValue(false) } as unknown as RedisService,
      'lock:browser-session:account-1',
      'old-token',
      9_000,
      { onLost },
    );

    await expect(lease.verify()).resolves.toBe(false);
    expect(lease.isOwned()).toBe(false);
    expect(onLost).toHaveBeenCalledTimes(1);
    await expect(lease.verify()).resolves.toBe(false);
    expect(onLost).toHaveBeenCalledTimes(1);
    await lease.stop();
  });
});
