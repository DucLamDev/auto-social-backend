import type { RedisService } from './redis.service';

export interface RedisLockLeaseOptions {
  onRenewed?: () => Promise<void> | void;
  onLost?: () => Promise<void> | void;
  onCallbackError?: (error: unknown) => void;
}

/**
 * Renews a token-owned Redis lock before its TTL expires. The compare-and-
 * expire operation remains inside Redis, so an old worker can never extend a
 * lock after ownership has moved to another token.
 */
export class RedisLockLease {
  private timer?: NodeJS.Timeout;
  private renewal?: Promise<boolean>;
  private owned = true;
  private stopped = false;
  private lossReported = false;

  constructor(
    private readonly redis: RedisService,
    private readonly key: string,
    private readonly token: string,
    private readonly ttlMs: number,
    private readonly options: RedisLockLeaseOptions = {},
  ) {
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 3_000) {
      throw new Error('A Redis lock lease TTL of at least 3000ms is required');
    }
  }

  start(): void {
    if (this.timer || this.stopped) return;
    const intervalMs = Math.min(30_000, Math.max(1_000, Math.floor(this.ttlMs / 3)));
    this.timer = setInterval(() => {
      void this.verify();
    }, intervalMs);
    this.timer.unref();
  }

  isOwned(): boolean {
    return this.owned && !this.stopped;
  }

  /** Refresh immediately, including immediately before an external side effect. */
  verify(): Promise<boolean> {
    if (this.stopped || !this.owned) return Promise.resolve(false);
    if (this.renewal) return this.renewal;

    const candidate = this.performRenewal();
    this.renewal = candidate;
    void candidate.finally(() => {
      if (this.renewal === candidate) this.renewal = undefined;
    });
    return candidate;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.renewal?.catch(() => false);
  }

  private async performRenewal(): Promise<boolean> {
    let renewed = false;
    try {
      renewed = await this.redis.extendLock(this.key, this.token, this.ttlMs);
    } catch (error) {
      this.options.onCallbackError?.(error);
    }
    if (!renewed) {
      await this.markLost();
      return false;
    }
    try {
      await this.options.onRenewed?.();
    } catch (error) {
      // The Redis lease is still owned. A secondary database heartbeat error
      // must be observable, but must not lie about Redis lock ownership.
      this.options.onCallbackError?.(error);
    }
    return true;
  }

  private async markLost(): Promise<void> {
    this.owned = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    if (this.lossReported) return;
    this.lossReported = true;
    try {
      await this.options.onLost?.();
    } catch (error) {
      this.options.onCallbackError?.(error);
    }
  }
}
