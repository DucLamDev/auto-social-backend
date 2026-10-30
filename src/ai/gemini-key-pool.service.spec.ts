import { ConfigService } from '@nestjs/config';
import { ConflictException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { Prisma } from '@prisma/client';
import { CredentialEncryptionService } from '../credentials/credential-encryption.service';
import { PrismaService } from '../database/prisma.service';
import { RedisService } from '../queue/redis.service';
import { GeminiKeyPoolService } from './gemini-key-pool.service';
import { UpdateGeminiKeysDto } from './gemini-keys.dto';
import { AiContentService } from './ai-content.service';

type Stored = { value: Prisma.JsonValue; secret: boolean; updatedAt: Date };
describe('Gemini encrypted key pool', () => {
  let stored: Stored | null;
  let pool: GeminiKeyPoolService;
  let config: ConfigService;
  let redis: Map<string, string>;
  let prisma: PrismaService;
  let encryption: CredentialEncryptionService;
  let now: number;
  beforeEach(() => {
    stored = null; redis = new Map(); now = Date.parse('2026-10-30T00:00:00Z');
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    config = new ConfigService({ GEMINI_API_KEY: 'test-environment-key', CREDENTIAL_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'), AI_DEFAULT_PROVIDER: 'gemini', GEMINI_MODEL: 'test-model', GEMINI_FALLBACK_MODEL: 'test-fallback', OPENAI_API_KEY: '', DEEPSEEK_API_KEY: '' });
    encryption = new CredentialEncryptionService(config);
    prisma = { systemSetting: {
      findUnique: jest.fn(() => Promise.resolve(stored)),
      create: jest.fn(({ data }: { data: { value: Prisma.JsonValue; secret: boolean } }) => { stored = { ...data, updatedAt: new Date(++now) }; return Promise.resolve(stored); }),
      updateMany: jest.fn(({ data, where }: { data: { value: Prisma.JsonValue; secret: boolean }; where: { updatedAt: Date } }) => {
        if (stored?.updatedAt.getTime() !== where.updatedAt.getTime()) return Promise.resolve({ count: 0 });
        stored = { ...data, updatedAt: new Date(++now) }; return Promise.resolve({ count: 1 });
      }),
    } } as unknown as PrismaService;
    pool = new GeminiKeyPoolService(prisma, config, encryption, {
      getValue: (key: string) => Promise.resolve(redis.get(key) ?? null),
      setValue: (key: string, value: string) => { redis.set(key, value); return Promise.resolve(); },
      setOnce: (key: string, value: string) => { redis.set(key, value); return Promise.resolve(true); },
    } as unknown as RedisService);
  });
  afterEach(() => jest.restoreAllMocks());

  async function addKeys(count = 3) {
    return pool.update({ revision: 'environment', changes: Array.from({ length: count - 1 }, (_, index) => ({ slot: index + 2, apiKey: `test-key-${index + 2}-secret` })) });
  }

  it('retains the current environment key, encrypts new keys and only returns slot metadata', async () => {
    const saved = await addKeys();
    expect(saved.slots).toHaveLength(10);
    expect(saved.slots.filter((slot) => slot.configured)).toHaveLength(3);
    expect(saved.source).toBe('saved');
    expect(JSON.stringify(saved)).not.toContain('secret');
    expect(JSON.stringify(stored)).not.toContain('test-key');
    const keyValues: string[] = [];
    await pool.run((key) => { keyValues.push(key); return Promise.resolve('ok'); });
    expect(keyValues).toEqual(['test-environment-key']);
    expect([...redis.keys()].join(' ')).not.toContain('test-environment-key');
  });

  it('immediately moves past quota errors and reuses the successful key on later requests', async () => {
    await addKeys();
    const request = jest.fn<Promise<string>, [string]>().mockRejectedValueOnce({ status: 429, headers: new Headers({ 'retry-after': '120' }), message: 'private-upstream-payload' }).mockResolvedValue('generated');
    expect(await pool.run(request)).toBe('generated');
    expect(request.mock.calls.map(([key]) => key)).toEqual(['test-environment-key', 'test-key-2-secret']);
    request.mockClear();
    expect(await pool.run(request)).toBe('generated');
    expect(request.mock.calls.map(([key]) => key)).toEqual(['test-key-2-secret']);
    expect((await pool.describe()).slots[0]?.retryAt).toBe(new Date(now + 120_000).toISOString());
  });

  it('attempts at most ten keys and skips cooling keys until quota can be retried', async () => {
    await addKeys(10);
    const request = jest.fn<Promise<string>, [string]>().mockRejectedValue({ status: 429, message: 'do-not-leak-secret' });
    await expect(pool.run(request)).rejects.toThrow('All configured Gemini API keys');
    expect(request).toHaveBeenCalledTimes(10);
    await expect(pool.run(request)).rejects.toThrow('All configured Gemini API keys');
    expect(request).toHaveBeenCalledTimes(10);
    now += 61_000;
    request.mockResolvedValue('quota recovered');
    expect(await pool.run(request)).toBe('quota recovered');
    expect(request).toHaveBeenCalledTimes(11);
  });

  it.each([400, 401, 403, 503])('does not rotate keys for non-quota status %i', async (status) => {
    await addKeys();
    const error = { status };
    const request = jest.fn<Promise<string>, [string]>().mockRejectedValue(error);
    await expect(pool.run(request)).rejects.toEqual(error);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('supports replacing and clearing slots, rejects duplicates and stale edits', async () => {
    const saved = await addKeys();
    await expect(pool.update({ revision: saved.revision, changes: [{ slot: 4, apiKey: 'test-key-2-secret' }] })).rejects.toThrow('trùng');
    const updated = await pool.update({ revision: saved.revision, changes: [{ slot: 1, clear: true }, { slot: 2, apiKey: 'test-replaced-key' }] });
    expect(updated.slots[0]?.configured).toBe(false);
    await expect(pool.update({ revision: saved.revision, changes: [{ slot: 2, clear: true }] })).rejects.toBeInstanceOf(ConflictException);
    const empty = await pool.update({ revision: updated.revision, changes: [{ slot: 2, clear: true }, { slot: 3, clear: true }] });
    expect(empty.slots.some((slot) => slot.configured)).toBe(false);
    expect(await pool.configured()).toBe(false);
    await expect(pool.run(() => Promise.resolve('no request'))).rejects.toThrow('not configured');
  });

  it('validates the ten-slot maximum, distinct slots and secret input shape', async () => {
    for (const changes of [
      Array.from({ length: 11 }, (_, i) => ({ slot: i + 1, apiKey: 'test-keys-long-enough' })),
      [{ slot: 1, clear: true }, { slot: 1, clear: true }],
      [{ slot: 0, apiKey: 'short' }], [{ slot: 11, clear: true }], [{ slot: 1, apiKey: 'contains spaces' }],
    ]) {
      expect((await validate(plainToInstance(UpdateGeminiKeysDto, { revision: 'environment', changes }))).length).toBeGreaterThan(0);
    }
  });

  it('routes the actual content generator to a second key on 429 without retrying the exhausted key or changing model', async () => {
    await addKeys();
    const ai = new AiContentService(prisma, config, pool);
    const parsed = { platform: 'devto', title: 'Test title', body: 'Test body', summary: null, hashtags: [], cta: null, recommended: true, reason: 'Relevant', media: { type: 'none', altText: '' } };
    const first = jest.fn().mockRejectedValue({ status: 429 });
    const second = jest.fn().mockResolvedValue({ choices: [{ message: { parsed } }] });
    const access = ai as unknown as { createGeminiClient: (key: string) => unknown; callGemini: (system: string, input: string) => Promise<unknown> };
    access.createGeminiClient = (key) => ({ chat: { completions: { parse: key === 'test-environment-key' ? first : second } } });
    expect(await access.callGemini('system', 'content')).toEqual(parsed);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledWith(expect.objectContaining({ model: 'test-model' }));
  });
});
