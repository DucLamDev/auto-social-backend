import { BadRequestException, ConflictException, HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { CredentialEncryptionService } from '../credentials/credential-encryption.service';
import { RedisService } from '../queue/redis.service';
import { ApplicationException, ErrorCode } from '../common/exceptions/application.exception';
import { UpdateGeminiKeysDto } from './gemini-keys.dto';

export const GEMINI_KEYS_SETTING = 'ai.gemini.keys';
const PREFERRED_KEY = 'ai:gemini:preferred';
const fingerprint = (key: string) => createHash('sha256').update(key).digest('hex');
const cooldownKey = (key: string) => `ai:gemini:cooldown:${fingerprint(key)}`;

@Injectable()
export class GeminiKeyPoolService {
  constructor(private readonly prisma: PrismaService, private readonly config: ConfigService,
    private readonly encryption: CredentialEncryptionService, private readonly redis: RedisService) {}

  private async read() {
    const setting = await this.prisma.systemSetting.findUnique({ where: { key: GEMINI_KEYS_SETTING } });
    const keys: Array<string | null> = Array.from({ length: 10 }, () => null);
    if (!setting) {
      keys[0] = this.config.get<string>('GEMINI_API_KEY')?.trim() || null;
      return { keys, revision: 'environment', source: 'environment' as const };
    }
    const value = setting.value as Record<string, unknown>;
    if (!setting.secret || typeof value.encrypted !== 'string') throw new Error('Invalid encrypted Gemini configuration');
    const payload = this.encryption.decrypt(value.encrypted);
    if (!Array.isArray(payload.keys) || payload.keys.length !== 10 || payload.keys.some((key: unknown) => key !== null && typeof key !== 'string')) throw new Error('Invalid Gemini key slots');
    return { keys: payload.keys as Array<string | null>, revision: setting.updatedAt.toISOString(), source: 'saved' as const };
  }

  async configured(): Promise<boolean> { return (await this.read()).keys.some(Boolean); }

  async describe() {
    const { keys, revision, source } = await this.read();
    const preferred = await this.redis.getValue(PREFERRED_KEY);
    return { revision, source, maxKeys: 10, slots: await Promise.all(keys.map(async (key, index) => {
      const until = key ? Number(await this.redis.getValue(cooldownKey(key))) : 0;
      return { slot: index + 1, configured: Boolean(key), active: Boolean(key && fingerprint(key) === preferred), retryAt: until > Date.now() ? new Date(until).toISOString() : null };
    })) };
  }

  async update(dto: UpdateGeminiKeysDto) {
    const current = await this.read();
    if (dto.revision !== current.revision) throw new ConflictException('Cấu hình Gemini đã thay đổi. Tải lại trước khi lưu.');
    const keys = [...current.keys];
    for (const change of dto.changes) {
      if (change.clear && change.apiKey) throw new BadRequestException('Không thể vừa xóa vừa thay key trong cùng một ô.');
      if (change.clear) keys[change.slot - 1] = null;
      else if (change.apiKey) keys[change.slot - 1] = change.apiKey.trim();
    }
    const configured = keys.filter((key): key is string => Boolean(key));
    if (new Set(configured).size !== configured.length) throw new BadRequestException('Các ô Gemini không được dùng trùng API key.');
    const value = { encrypted: this.encryption.encrypt({ keys }), keyVersion: this.encryption.keyVersion };
    if (current.revision === 'environment') {
      try { await this.prisma.systemSetting.create({ data: { key: GEMINI_KEYS_SETTING, value, secret: true } }); }
      catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') throw new ConflictException('Cấu hình Gemini đã thay đổi. Tải lại trước khi lưu.');
        throw error;
      }
    } else {
      const result = await this.prisma.systemSetting.updateMany({ where: { key: GEMINI_KEYS_SETTING, updatedAt: new Date(current.revision) }, data: { value, secret: true } });
      if (!result.count) throw new ConflictException('Cấu hình Gemini đã thay đổi. Tải lại trước khi lưu.');
    }
    return this.describe();
  }

  async run<T>(request: (apiKey: string) => Promise<T>): Promise<T> {
    const keys = (await this.read()).keys.filter((key): key is string => Boolean(key));
    if (!keys.length) throw new ApplicationException(ErrorCode.INFRASTRUCTURE_UNAVAILABLE, 'GEMINI_API_KEY is not configured', HttpStatus.SERVICE_UNAVAILABLE);
    const preferred = await this.redis.getValue(PREFERRED_KEY);
    const start = Math.max(0, keys.findIndex((key) => fingerprint(key) === preferred));
    const ordered = [...keys.slice(start), ...keys.slice(0, start)];
    for (const key of ordered) {
      if (Number(await this.redis.getValue(cooldownKey(key))) > Date.now()) continue;
      try {
        const result = await request(key);
        await this.redis.setValue(PREFERRED_KEY, fingerprint(key), 86_400);
        return result;
      } catch (error) {
        const status = typeof error === 'object' && error !== null ? (error as { status?: unknown }).status : undefined;
        if (status !== 429 && status !== 402) throw error;
        const seconds = retryDelaySeconds(error);
        await this.redis.setOnce(cooldownKey(key), String(Date.now() + seconds * 1000), seconds);
      }
    }
    const cooldowns = await Promise.all(keys.map(async (key) => Number(await this.redis.getValue(cooldownKey(key)))));
    const earliestRetry = Math.min(...cooldowns.filter((until) => until > Date.now()));
    throw new ApplicationException(
      ErrorCode.PLATFORM_RATE_LIMITED,
      'All configured Gemini API keys are quota-limited. Try again after the cooldown or update keys in Settings.',
      HttpStatus.TOO_MANY_REQUESTS,
      { configuredKeys: keys.length, retryAt: Number.isFinite(earliestRetry) ? new Date(earliestRetry).toISOString() : null },
    );
  }
}

/** Respect provider retry hints; do not include provider payloads or keys in public errors. */
function retryDelaySeconds(error: unknown): number {
  const headers = (error as { headers?: Headers | Record<string, string> })?.headers;
  const hint = headers instanceof Headers ? headers.get('retry-after') : headers?.['retry-after'];
  if (!hint) return 60;
  const delay = Number.isFinite(Number(hint)) ? Number(hint) : (Date.parse(hint) - Date.now()) / 1000;
  return Number.isFinite(delay) && delay > 0 ? Math.max(60, Math.ceil(delay)) : 60;
}
