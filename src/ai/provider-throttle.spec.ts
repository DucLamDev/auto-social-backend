import { ProviderThrottle } from './provider-throttle';

describe('ProviderThrottle', () => {
  it('never runs more requests at once than the key allows', async () => {
    const throttle = new ProviderThrottle(2, 600, () => 0, () => Promise.resolve());
    let active = 0;
    let peak = 0;
    const releases: Array<() => void> = [];
    const runs = Array.from({ length: 5 }, () => throttle.run(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise<void>((resolve) => { releases.push(resolve); });
      active -= 1;
    }));
    for (let round = 0; round < 10; round++) {
      await new Promise(setImmediate);
      releases.splice(0).forEach((release) => { release(); });
    }
    await Promise.all(runs);
    expect(peak).toBe(2);
  });

  it('spaces request starts so a 10-per-minute key is never exceeded', async () => {
    const sleeps: number[] = [];
    const throttle = new ProviderThrottle(3, 10, () => 0, (ms) => { sleeps.push(ms); return Promise.resolve(); });
    await Promise.all([1, 2, 3].map(() => throttle.run(() => Promise.resolve())));
    expect(sleeps).toEqual([6_000, 12_000]);
  });

  it('frees the slot when a request fails', async () => {
    const throttle = new ProviderThrottle(1, 600, () => 0, () => Promise.resolve());
    await expect(throttle.run(() => Promise.reject(new Error('upstream down')))).rejects.toThrow('upstream down');
    await expect(throttle.run(() => Promise.resolve('next'))).resolves.toBe('next');
  });

  it('rejects limits that are not positive integers', () => {
    expect(() => new ProviderThrottle(0, 10)).toThrow('maxConcurrency');
    expect(() => new ProviderThrottle(2, Number.NaN)).toThrow('perMinute');
  });
});
