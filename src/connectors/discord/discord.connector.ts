import { Injectable } from '@nestjs/common';
import { PlatformMode } from '@prisma/client';
import { ErrorCode } from '../../common/exceptions/application.exception';
import { ConnectorError } from '../core/connector-error';
import { HttpConnectorBase } from '../core/http-connector.base';
import { ConnectionTestResult, ConnectorAccount, PostPayload, PublishResult } from '../core/connector.types';
import { SocialPublisher } from '../core/social-publisher.interface';

interface DiscordMessage { id: string; channel_id?: string; guild_id?: string }
interface DiscordWebhook { id: string; name?: string; channel_id?: string; guild_id?: string }

@Injectable()
export class DiscordConnector extends HttpConnectorBase implements SocialPublisher {
  readonly platform = 'discord';
  readonly mode = PlatformMode.OFFICIAL_API;
  readonly capability = { text: true, image: false, video: false, article: false, delete: true, schedule: false, analytics: false, maxText: 2000 };

  validate(post: PostPayload): Promise<void> {
    if (!post.body.trim() || post.body.length > 2000) throw new ConnectorError(ErrorCode.PLATFORM_CONTENT_REJECTED, 'Discord content must contain 1-2000 characters', false);
    return Promise.resolve();
  }

  async publish(account: ConnectorAccount, post: PostPayload): Promise<PublishResult> {
    await this.validate(post);
    const webhook = this.webhook(account);
    const separator = webhook.includes('?') ? '&' : '?';
    const { data } = await this.request<DiscordMessage>(`${webhook}${separator}wait=true`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: post.body, allowed_mentions: { parse: [] } }),
    });
    const url = data.guild_id && data.channel_id ? `https://discord.com/channels/${data.guild_id}/${data.channel_id}/${data.id}` : undefined;
    return { externalId: data.id, url, status: 'PUBLISHED' };
  }

  async testConnection(account: ConnectorAccount): Promise<ConnectionTestResult> {
    const { data } = await this.request<DiscordWebhook>(this.webhook(account), {});
    return { ok: true, accountName: data.name, details: { externalId: data.id, channelId: data.channel_id } };
  }

  async delete(account: ConnectorAccount, publishId: string): Promise<void> {
    await this.request(`${this.webhook(account)}/messages/${encodeURIComponent(publishId)}`, { method: 'DELETE' });
  }

  private webhook(account: ConnectorAccount): string {
    const value = this.requiredString(account.credentials, 'webhookUrl');
    const url = new URL(value);
    if (url.protocol !== 'https:' || !['discord.com', 'canary.discord.com', 'ptb.discord.com'].includes(url.hostname) || !url.pathname.startsWith('/api/webhooks/')) {
      throw new ConnectorError(ErrorCode.PLATFORM_AUTH_FAILED, 'Discord webhook URL is not an official Discord webhook', false);
    }
    return url.toString().replace(/\/$/, '');
  }
}
