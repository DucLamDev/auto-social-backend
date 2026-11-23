import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { CredentialEncryptionService } from '../credentials/credential-encryption.service';
import { PrismaService } from '../database/prisma.service';
import { CHAT_EVENTS_PATH, CHAT_SETTING_KEY, OUTBOX_FAILED, OUTBOX_PENDING } from './chat-integration.constants';
import { UpdateChatIntegrationDto } from './chat-integration.dto';

export interface ChatConfig {
  enabled: boolean;
  baseUrl: string | null;
  channelId: string | null;
  botToken: string | null;
  webhookSecret: string | null;
  previousWebhookSecret: string | null;
  /** When the old webhook secret was kept (ISO); it is accepted for 24 h from then. */
  previousWebhookSecretSetAt: string | null;
}

/** How long chat may still sign with the old webhook secret after a rotation. */
export const PREVIOUS_SECRET_TTL_MS = 24 * 60 * 60_000;

const EMPTY: ChatConfig = { enabled: false, baseUrl: null, channelId: null, botToken: null, webhookSecret: null, previousWebhookSecret: null, previousWebhookSecretSetAt: null };

/** End of the old secret's grace period, or null when there is no usable old secret. */
export function previousSecretExpiresAt(config: ChatConfig): Date | null {
  const setAt = config.previousWebhookSecretSetAt ? Date.parse(config.previousWebhookSecretSetAt) : NaN;
  return config.previousWebhookSecret && Number.isFinite(setAt) ? new Date(setAt + PREVIOUS_SECRET_TTL_MS) : null;
}

/** Secrets a webhook signature may be checked against right now. */
export function acceptedWebhookSecrets(config: ChatConfig, now = new Date()): string[] {
  const until = previousSecretExpiresAt(config);
  return [config.webhookSecret, until && until > now ? config.previousWebhookSecret : null].filter((secret): secret is string => Boolean(secret));
}
const STALE = 'Cấu hình kết nối chat đã thay đổi. Tải lại trước khi lưu.';

const text = (value: unknown): string | null => (typeof value === 'string' && value ? value : null);

/** "https://chat.example.com/" → "https://chat.example.com"; anything but a plain https URL is refused. */
export function normalizeChatBaseUrl(raw: string): string {
  let url: URL;
  try { url = new URL(raw.trim()); } catch { throw new BadRequestException('Địa chỉ chat không hợp lệ.'); }
  if (url.protocol !== 'https:') throw new BadRequestException('Địa chỉ chat phải dùng https://.');
  if (url.username || url.password || url.search || url.hash) throw new BadRequestException('Địa chỉ chat không được có tài khoản, tham số hay dấu #.');
  return `${url.origin}${url.pathname}`.replace(/\/+$/, '');
}

/**
 * The chat connection, stored encrypted in one SystemSetting row like the
 * Gemini keys. Secrets leave this service only toward the chat server and the
 * webhook guard; the API sees a masked description.
 */
@Injectable()
export class ChatConfigService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly encryption: CredentialEncryptionService,
    private readonly config: ConfigService,
  ) {}

  async read(): Promise<{ config: ChatConfig; revision: string; saved: boolean }> {
    const setting = await this.prisma.systemSetting.findUnique({ where: { key: CHAT_SETTING_KEY } });
    if (!setting) return { config: { ...EMPTY }, revision: 'new', saved: false };
    const value = setting.value as Record<string, unknown>;
    if (!setting.secret || typeof value.encrypted !== 'string') throw new Error('Invalid encrypted chat configuration');
    const payload = this.encryption.decrypt(value.encrypted);
    return {
      config: {
        enabled: payload.enabled === true,
        baseUrl: text(payload.baseUrl),
        channelId: text(payload.channelId),
        botToken: text(payload.botToken),
        webhookSecret: text(payload.webhookSecret),
        previousWebhookSecret: text(payload.previousWebhookSecret),
        previousWebhookSecretSetAt: text(payload.previousWebhookSecretSetAt),
      },
      revision: setting.updatedAt.toISOString(),
      saved: true,
    };
  }

  /** Configuration usable for sending, or null when off or incomplete. */
  async active(): Promise<(ChatConfig & { baseUrl: string; botToken: string; channelId: string }) | null> {
    const { config } = await this.read();
    if (!config.enabled || !config.baseUrl || !config.botToken || !config.channelId) return null;
    return config as ChatConfig & { baseUrl: string; botToken: string; channelId: string };
  }

  /** First FRONTEND_URL when it is https, for links in chat messages. */
  frontendUrl(): string | null {
    const first = (this.config.get<string>('FRONTEND_URL') ?? '').split(',')[0]?.trim().replace(/\/+$/, '');
    return first && first.startsWith('https://') ? first : null;
  }

  async describe() {
    const { config, revision, saved } = await this.read();
    const [pendingCount, failedCount, last] = await Promise.all([
      this.prisma.chatOutboxEvent.count({ where: { status: OUTBOX_PENDING } }),
      this.prisma.chatOutboxEvent.count({ where: { status: OUTBOX_FAILED } }),
      this.prisma.chatOutboxEvent.findFirst({
        where: { lastAttemptAt: { not: null } },
        orderBy: { lastAttemptAt: 'desc' },
        select: { kind: true, lastAttemptAt: true, sentAt: true, lastError: true },
      }),
    ]);
    const previousExpires = previousSecretExpiresAt(config);
    const ok = Boolean(last?.sentAt && last.lastAttemptAt && last.sentAt.getTime() >= last.lastAttemptAt.getTime());
    return {
      revision,
      configured: saved,
      enabled: config.enabled,
      baseUrl: config.baseUrl,
      channelId: config.channelId,
      botTokenConfigured: Boolean(config.botToken),
      botTokenHint: config.botToken ? `${config.botToken.slice(0, 4)}…${config.botToken.slice(-4)}` : null,
      webhookSecretConfigured: Boolean(config.webhookSecret),
      previousWebhookSecretConfigured: Boolean(previousExpires && previousExpires > new Date()),
      previousWebhookSecretExpiresAt: previousExpires && previousExpires > new Date() ? previousExpires.toISOString() : null,
      webhookPath: CHAT_EVENTS_PATH,
      pendingCount,
      failedCount,
      lastDelivery: last?.lastAttemptAt
        ? { at: last.lastAttemptAt.toISOString(), ok, kind: last.kind, error: ok ? null : last.lastError }
        : null,
    };
  }

  async update(dto: UpdateChatIntegrationDto) {
    const current = await this.read();
    if (dto.revision !== current.revision) throw new ConflictException(STALE);
    const next: ChatConfig = { ...current.config };
    if (dto.baseUrl !== undefined) next.baseUrl = dto.baseUrl.trim() ? normalizeChatBaseUrl(dto.baseUrl) : null;
    if (dto.channelId !== undefined) next.channelId = dto.channelId;
    if (dto.botToken) next.botToken = dto.botToken.trim();
    if (dto.webhookSecret && dto.webhookSecret !== current.config.webhookSecret) {
      // Chat keeps signing with the old secret until its own side is rotated.
      next.previousWebhookSecret = current.config.webhookSecret;
      next.previousWebhookSecretSetAt = current.config.webhookSecret ? new Date().toISOString() : null;
      next.webhookSecret = dto.webhookSecret;
    }
    if (dto.previousWebhookSecret) {
      next.previousWebhookSecret = dto.previousWebhookSecret;
      next.previousWebhookSecretSetAt = new Date().toISOString();
    }
    if (dto.clearPreviousWebhookSecret) {
      if (dto.previousWebhookSecret) throw new BadRequestException('Không thể vừa xoá vừa nhập khoá webhook cũ.');
      next.previousWebhookSecret = null;
      next.previousWebhookSecretSetAt = null;
    }
    if (dto.enabled !== undefined) next.enabled = dto.enabled;
    if (next.enabled && (!next.baseUrl || !next.botToken || !next.channelId || !next.webhookSecret)) {
      throw new BadRequestException('Cần nhập đủ địa chỉ chat, khoá bot, mã kênh và khoá webhook trước khi bật kết nối.');
    }
    const value = { encrypted: this.encryption.encrypt({ ...next }), keyVersion: this.encryption.keyVersion } as Prisma.InputJsonObject;
    if (!current.saved) {
      try {
        await this.prisma.systemSetting.create({ data: { key: CHAT_SETTING_KEY, value, secret: true, description: 'Kết nối chat VPSTTT' } });
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') throw new ConflictException(STALE);
        throw error;
      }
    } else {
      const result = await this.prisma.systemSetting.updateMany({ where: { key: CHAT_SETTING_KEY, updatedAt: new Date(current.revision) }, data: { value, secret: true } });
      if (!result.count) throw new ConflictException(STALE);
    }
    return this.describe();
  }
}
