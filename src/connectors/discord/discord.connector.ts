import { Injectable } from '@nestjs/common';
import { PlatformMode } from '@prisma/client';
import { createHash } from 'node:crypto';
import { ErrorCode } from '../../common/exceptions/application.exception';
import { StorageService } from '../../storage/storage.service';
import { ConnectorError } from '../core/connector-error';
import { HttpConnectorBase } from '../core/http-connector.base';
import {
  ConnectionTestResult,
  ConnectorAccount,
  POST_MEDIA_MANAGED_STORAGE,
  PostMedia,
  PostMediaManagedStorage,
  PostPayload,
  PublishResult,
} from '../core/connector.types';
import { SocialPublisher } from '../core/social-publisher.interface';

interface DiscordMessage { id: string; channel_id?: string; guild_id?: string }
interface DiscordWebhook { id: string; type?: number; name?: string; channel_id?: string; guild_id?: string }

interface DiscordDestinationSettings {
  avatarUrl?: string;
  createForumThread: boolean;
  threadId?: string;
  username?: string;
}

type DiscordUploadMimeType = keyof typeof DISCORD_IMAGE_FORMATS;

interface DiscordMessagePayload {
  allowed_mentions: { parse: never[] };
  attachments?: Array<{ id: number; filename: string; description?: string }>;
  avatar_url?: string;
  content?: string;
  embeds?: Array<{ image: { url: string; description?: string } }>;
  thread_name?: string;
  username?: string;
}

const MAX_DISCORD_FILE_BYTES = 20 * 1024 * 1024;
const MAX_DISCORD_ATTACHMENT_DESCRIPTION = 1024;
const MANAGED_IMAGE_KEY = /^media\/[a-zA-Z0-9][a-zA-Z0-9/_-]*\.(?:gif|jpe?g|png|webp)$/;
const SHA256 = /^[a-f0-9]{64}$/i;

const DISCORD_IMAGE_FORMATS = {
  'image/gif': {
    extension: '.gif',
    matches: (body: Buffer) => {
      const signature = body.subarray(0, 6).toString('ascii');
      return signature === 'GIF87a' || signature === 'GIF89a';
    },
  },
  'image/jpeg': {
    extension: '.jpg',
    matches: (body: Buffer) =>
      body.length >= 3 && body[0] === 0xff && body[1] === 0xd8 && body[2] === 0xff,
  },
  'image/png': {
    extension: '.png',
    matches: (body: Buffer) =>
      body.length >= 8 &&
      body.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  },
  'image/webp': {
    extension: '.webp',
    matches: (body: Buffer) =>
      body.length >= 12 &&
      body.subarray(0, 4).toString('ascii') === 'RIFF' &&
      body.subarray(8, 12).toString('ascii') === 'WEBP',
  },
} as const;

@Injectable()
export class DiscordConnector extends HttpConnectorBase implements SocialPublisher {
  readonly platform = 'discord';
  readonly mode = PlatformMode.OFFICIAL_API;
  readonly capability = { text: true, image: true, video: false, article: false, delete: true, schedule: false, analytics: false, maxText: 2000, maxImages: 10 };

  constructor(private readonly storage: StorageService) {
    super();
  }

  validate(post: PostPayload): Promise<void> {
    const media = post.media ?? [];
    if (!post.body.trim() && media.length === 0) {
      throw new ConnectorError(ErrorCode.PLATFORM_CONTENT_REJECTED, 'Discord requires message text or at least one image', false);
    }
    if (post.body.length > 2000) {
      throw new ConnectorError(ErrorCode.PLATFORM_CONTENT_REJECTED, 'Discord content exceeds 2000 characters', false);
    }
    if (media.some((item) => item.type !== 'image')) {
      throw new ConnectorError(ErrorCode.PLATFORM_MEDIA_INVALID, 'Discord webhook embeds support image media only', false);
    }
    if (media.length > 10) {
      throw new ConnectorError(ErrorCode.PLATFORM_MEDIA_INVALID, 'Discord accepts at most 10 image embeds per message', false);
    }
    for (const item of media) {
      const managed = item[POST_MEDIA_MANAGED_STORAGE];
      if (managed) {
        this.validateManagedImage(item, managed);
      } else {
        this.validateHttpsUrl(item.url, 'Discord image URL');
      }
    }
    return Promise.resolve();
  }

  async publish(account: ConnectorAccount, post: PostPayload): Promise<PublishResult> {
    await this.validate(post);
    const settings = this.destinationSettings(account);
    const webhook = this.webhook(account);
    webhook.searchParams.set('wait', 'true');
    if (settings.threadId) webhook.searchParams.set('thread_id', settings.threadId);

    const threadName = settings.createForumThread ? this.forumThreadName(post) : undefined;
    const request = await this.publishRequest(post, settings, threadName);
    const { data } = await this.request<DiscordMessage>(webhook.toString(), request);
    const url = data.guild_id && data.channel_id ? `https://discord.com/channels/${data.guild_id}/${data.channel_id}/${data.id}` : undefined;
    const createdThreadId = settings.createForumThread ? data.channel_id : undefined;
    return {
      externalId: createdThreadId ? `${data.id}@${createdThreadId}` : data.id,
      url,
      status: 'PUBLISHED',
      metadata: {
        messageId: data.id,
        ...(data.channel_id ? { channelId: data.channel_id } : {}),
        ...(createdThreadId ? { createdThreadId } : {}),
      },
    };
  }

  async testConnection(account: ConnectorAccount): Promise<ConnectionTestResult> {
    const settings = this.destinationSettings(account);
    const { data } = await this.request<DiscordWebhook>(this.webhook(account).toString(), {});
    if (data.type !== undefined && data.type !== 1) {
      throw new ConnectorError(ErrorCode.PLATFORM_AUTH_FAILED, 'Discord URL must belong to an Incoming Webhook', false);
    }
    return {
      ok: true,
      accountName: data.name,
      details: {
        externalId: data.id,
        channelId: data.channel_id,
        guildId: data.guild_id,
        threadId: settings.threadId,
        createForumThread: settings.createForumThread,
      },
    };
  }

  async delete(account: ConnectorAccount, publishId: string): Promise<void> {
    const [rawMessageId, publishedThreadId] = publishId.split('@', 2);
    if (!rawMessageId || !/^\d+$/.test(rawMessageId)) {
      throw new ConnectorError(ErrorCode.PLATFORM_CONTENT_REJECTED, 'Discord publish ID is invalid', false);
    }
    const messageId = rawMessageId;
    const settings = this.destinationSettings(account);
    const webhook = this.webhook(account);
    webhook.pathname = `${webhook.pathname}/messages/${encodeURIComponent(messageId)}`;
    const threadId = settings.threadId ?? publishedThreadId;
    if (threadId) webhook.searchParams.set('thread_id', threadId);
    await this.request(webhook.toString(), { method: 'DELETE' });
  }

  private webhook(account: ConnectorAccount): URL {
    const value = this.requiredString(account.credentials, 'webhookUrl');
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new ConnectorError(ErrorCode.PLATFORM_AUTH_FAILED, 'Discord webhook URL is invalid', false);
    }
    const webhookPath = /^\/api(?:\/v\d+)?\/webhooks\/(\d+)\/([^/]+)\/?$/;
    if (
      url.protocol !== 'https:'
      || !['discord.com', 'canary.discord.com', 'ptb.discord.com'].includes(url.hostname)
      || Boolean(url.username || url.password)
      || !webhookPath.test(url.pathname)
    ) {
      throw new ConnectorError(ErrorCode.PLATFORM_AUTH_FAILED, 'Discord webhook URL is not an official Discord webhook', false);
    }
    url.pathname = url.pathname.replace(/\/$/, '');
    url.search = '';
    url.hash = '';
    return url;
  }

  private destinationSettings(account: ConnectorAccount): DiscordDestinationSettings {
    const username = this.optionalString(account.settings.webhookUsername);
    if (username && username.length > 80) {
      throw new ConnectorError(ErrorCode.PLATFORM_CONTENT_REJECTED, 'Discord webhook username must not exceed 80 characters', false);
    }
    const avatarUrl = this.optionalString(account.settings.webhookAvatarUrl);
    if (avatarUrl) this.validateHttpsUrl(avatarUrl, 'Discord webhook avatar URL');
    const threadId = this.optionalString(account.settings.threadId);
    if (threadId && !/^\d+$/.test(threadId)) {
      throw new ConnectorError(ErrorCode.PLATFORM_AUTH_FAILED, 'Discord thread ID must contain digits only', false);
    }
    const createForumThread = account.settings.createForumThread === true;
    if (threadId && createForumThread) {
      throw new ConnectorError(ErrorCode.PLATFORM_AUTH_FAILED, 'Choose either an existing Discord thread ID or automatic forum-thread creation', false);
    }
    return { avatarUrl, createForumThread, threadId, username };
  }

  private async publishRequest(
    post: PostPayload,
    settings: DiscordDestinationSettings,
    threadName: string | undefined,
  ): Promise<RequestInit> {
    const media = post.media ?? [];
    const payload: DiscordMessagePayload = {
      ...(post.body.trim() ? { content: post.body } : {}),
      ...(settings.username ? { username: settings.username } : {}),
      ...(settings.avatarUrl ? { avatar_url: settings.avatarUrl } : {}),
      ...(threadName ? { thread_name: threadName } : {}),
      allowed_mentions: { parse: [] },
    };
    if (!media.some((asset) => asset[POST_MEDIA_MANAGED_STORAGE])) {
      if (media.length) payload.embeds = media.map((asset) => this.imageEmbed(asset, asset.url));
      return {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      };
    }

    const form = new FormData();
    const attachments: NonNullable<DiscordMessagePayload['attachments']> = [];
    const embeds: NonNullable<DiscordMessagePayload['embeds']> = [];
    let uploadIndex = 0;
    for (const [mediaIndex, asset] of media.entries()) {
      const managed = asset[POST_MEDIA_MANAGED_STORAGE];
      if (!managed) {
        embeds.push(this.imageEmbed(asset, asset.url));
        continue;
      }

      const mimeType = asset.mimeType!.trim().toLowerCase() as DiscordUploadMimeType;
      const filename = `image-${mediaIndex + 1}${DISCORD_IMAGE_FORMATS[mimeType].extension}`;
      const body = await this.loadManagedImage(asset, managed, mimeType);
      try {
        form.append(
          `files[${uploadIndex}]`,
          new Blob([Uint8Array.from(body)], { type: mimeType }),
          filename,
        );
      } finally {
        body.fill(0);
      }
      const description = this.attachmentDescription(asset);
      attachments.push({ id: uploadIndex, filename, ...(description ? { description } : {}) });
      embeds.push(this.imageEmbed(asset, `attachment://${filename}`));
      uploadIndex += 1;
    }
    payload.attachments = attachments;
    payload.embeds = embeds;
    form.append('payload_json', JSON.stringify(payload));
    return { method: 'POST', body: form };
  }

  private imageEmbed(
    asset: PostMedia,
    url: string,
  ): NonNullable<DiscordMessagePayload['embeds']>[number] {
    const description = this.attachmentDescription(asset);
    return {
      image: {
        url,
        ...(description ? { description } : {}),
      },
    };
  }

  private attachmentDescription(asset: PostMedia): string | undefined {
    const value = asset.altText?.trim();
    return value ? value.slice(0, MAX_DISCORD_ATTACHMENT_DESCRIPTION) : undefined;
  }

  private validateManagedImage(asset: PostMedia, managed: PostMediaManagedStorage): void {
    const mimeType = asset.mimeType?.trim().toLowerCase();
    if (!mimeType || !(mimeType in DISCORD_IMAGE_FORMATS)) {
      throw new ConnectorError(
        ErrorCode.PLATFORM_MEDIA_INVALID,
        'Managed Discord images require a supported verified MIME type',
        false,
      );
    }
    if (
      !MANAGED_IMAGE_KEY.test(managed.storageKey) ||
      managed.storageKey.includes('..') ||
      managed.storageKey.includes('//') ||
      !SHA256.test(managed.checksum) ||
      !Number.isSafeInteger(managed.sizeBytes) ||
      managed.sizeBytes < 1 ||
      managed.sizeBytes > MAX_DISCORD_FILE_BYTES
    ) {
      throw new ConnectorError(
        ErrorCode.PLATFORM_MEDIA_INVALID,
        'Managed Discord image provenance is invalid or exceeds the 20 MiB file limit',
        false,
      );
    }
  }

  private async loadManagedImage(
    asset: PostMedia,
    managed: PostMediaManagedStorage,
    mimeType: DiscordUploadMimeType,
  ): Promise<Buffer> {
    let body: Buffer;
    try {
      body = await this.storage.get(managed.storageKey, MAX_DISCORD_FILE_BYTES);
    } catch {
      throw new ConnectorError(
        ErrorCode.PLATFORM_API_ERROR,
        'Stored Discord image could not be loaded',
        true,
      );
    }
    if (
      body.length !== managed.sizeBytes ||
      createHash('sha256').update(body).digest('hex') !== managed.checksum.toLowerCase() ||
      !DISCORD_IMAGE_FORMATS[mimeType].matches(body)
    ) {
      body.fill(0);
      throw new ConnectorError(
        ErrorCode.PLATFORM_MEDIA_INVALID,
        'Managed Discord image failed its stored size, checksum, or file-type verification',
        false,
      );
    }
    return body;
  }

  private forumThreadName(post: PostPayload): string {
    const value = (post.title?.trim() || post.body.trim().split(/\r?\n/, 1)[0] || 'Social Publisher post')
      .replace(/\s+/g, ' ')
      .slice(0, 100);
    if (!value) throw new ConnectorError(ErrorCode.PLATFORM_CONTENT_REJECTED, 'Discord forum posts require a thread name', false);
    return value;
  }

  private optionalString(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
  }

  private validateHttpsUrl(value: string, label: string): void {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new ConnectorError(ErrorCode.PLATFORM_MEDIA_INVALID, `${label} must be an absolute HTTPS URL`, false);
    }
    if (url.protocol !== 'https:' || Boolean(url.username || url.password)) {
      throw new ConnectorError(ErrorCode.PLATFORM_MEDIA_INVALID, `${label} must be an absolute HTTPS URL`, false);
    }
  }
}
