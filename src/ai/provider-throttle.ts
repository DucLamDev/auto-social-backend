/**
 * Keeps calls to a slow, quota-limited provider inside its key limits: at most
 * `maxConcurrency` requests in flight and request starts spaced evenly so no
 * more than `perMinute` begin within a minute. The API runs AI calls in one
 * process, so an in-process limiter is enough; the provider still answers 429
 * if several processes share one key.
 */
export class ProviderThrottle {
  private active = 0;
  private nextStartAt = 0;
  private readonly waiters: Array<() => void> = [];
  private readonly gapMs: number;

  constructor(
    private readonly maxConcurrency: number,
    perMinute: number,
    private readonly now: () => number = () => Date.now(),
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); }),
  ) {
    if (!Number.isSafeInteger(maxConcurrency) || maxConcurrency < 1) throw new Error('maxConcurrency must be a positive integer');
    if (!Number.isSafeInteger(perMinute) || perMinute < 1) throw new Error('perMinute must be a positive integer');
    this.gapMs = Math.ceil(60_000 / perMinute);
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      // Reserve the start time before awaiting so concurrent callers queue
      // behind each other instead of all waking at the same instant.
      const current = this.now();
      const startAt = Math.max(current, this.nextStartAt);
      this.nextStartAt = startAt + this.gapMs;
      if (startAt > current) await this.sleep(startAt - current);
      return await task();
    } finally {
      this.release();
    }
  }

  private async acquire(): Promise<void> {
    if (this.active < this.maxConcurrency) {
      this.active += 1;
      return;
    }
    await new Promise<void>((resolve) => { this.waiters.push(resolve); });
  }

  private release(): void {
    const next = this.waiters.shift();
    // Hand the slot straight to the next caller; `active` stays the same.
    if (next) next();
    else this.active -= 1;
  }
}
