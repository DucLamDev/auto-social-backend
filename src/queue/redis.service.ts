import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { randomUUID } from 'node:crypto';

@Injectable()
export class RedisService implements OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  private readonly client?: Redis;

  constructor(config: ConfigService) {
    if (process.env.SKIP_INFRA_CONNECT !== 'true') {
      this.client = new Redis(config.get<string>('REDIS_URL', 'redis://localhost:6379'), {
        lazyConnect: true,
        maxRetriesPerRequest: 2,
        enableReadyCheck: true,
        retryStrategy: (attempt) => Math.min(attempt * 200, 5_000),
      });
      this.client.on('error', (error) => this.logger.error(`Redis error: ${error.message}`));
    }
  }

  async acquireLock(key: string, ttlMs: number): Promise<string | null> {
    if (!this.client) return randomUUID();
    await this.connect();
    const token = randomUUID();
    const result = await this.client.set(key, token, 'PX', ttlMs, 'NX');
    return result === 'OK' ? token : null;
  }

  async releaseLock(key: string, token: string): Promise<boolean> {
    if (!this.client) return true;
    const result = await this.client.eval(
      "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
      1,
      key,
      token,
    );
    return result === 1;
  }

  async extendLock(key: string, token: string, ttlMs: number): Promise<boolean> {
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1) {
      throw new Error('Redis lock TTL must be a positive integer');
    }
    if (!this.client) return true;
    const result = await this.client.eval(
      "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) else return 0 end",
      1,
      key,
      token,
      ttlMs,
    );
    return result === 1;
  }

  async consumeRateLimit(key: string, limit: number, windowSeconds: number): Promise<{ allowed: boolean; remaining: number }> {
    if (!this.client) return { allowed: true, remaining: limit - 1 };
    await this.connect();
    const result = (await this.client.eval(
      "local n=redis.call('incr',KEYS[1]); if n==1 then redis.call('expire',KEYS[1],ARGV[1]) end; return n",
      1,
      key,
      windowSeconds,
    )) as number;
    return { allowed: result <= limit, remaining: Math.max(0, limit - result) };
  }

  async setOnce(key: string, value: string, ttlSeconds: number): Promise<boolean> {
    if (!this.client) return true;
    await this.connect();
    return (await this.client.set(key, value, 'EX', ttlSeconds, 'NX')) === 'OK';
  }

  async ping(): Promise<boolean> {
    if (!this.client) return true;
    await this.connect();
    return (await this.client.ping()) === 'PONG';
  }

  async onModuleDestroy(): Promise<void> {
    if (this.client) await this.client.quit().catch(() => this.client?.disconnect());
  }

  private async connect(): Promise<void> {
    if (this.client?.status === 'wait') await this.client.connect();
  }
}
