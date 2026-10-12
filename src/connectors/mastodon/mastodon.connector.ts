import { Injectable } from '@nestjs/common';
import { PlatformMode } from '@prisma/client';
import { ErrorCode } from '../../common/exceptions/application.exception';
import { ConnectorError } from '../core/connector-error';
import { HttpConnectorBase } from '../core/http-connector.base';
import { ConnectorAccount, ConnectionTestResult, PostPayload, PublishResult } from '../core/connector.types';
import { SocialPublisher } from '../core/social-publisher.interface';

interface MastodonStatus { id: string; url?: string; uri?: string }
interface MastodonAccount { display_name?: string; username?: string }

@Injectable()
export class MastodonConnector extends HttpConnectorBase implements SocialPublisher {
  readonly platform = 'mastodon';
  readonly mode = PlatformMode.OFFICIAL_API;
  readonly capability = { text: true, image: false, video: false, article: false, delete: true, schedule: false, analytics: false };

  validate(post: PostPayload): Promise<void> {
    if (!post.body.trim()) throw new ConnectorError(ErrorCode.PLATFORM_CONTENT_REJECTED, 'Status text is required', false);
    if (post.media?.length) throw new ConnectorError(ErrorCode.PLATFORM_MEDIA_INVALID, 'Media upload is outside the MVP Mastodon connector scope', false);
    return Promise.resolve();
  }

  async publish(account: ConnectorAccount, post: PostPayload): Promise<PublishResult> {
    await this.validate(post);
    const base = this.instanceUrl(account);
    const token = this.requiredString(account.credentials, 'accessToken');
    const { data } = await this.requestDynamic<MastodonStatus>(`${base}/api/v1/statuses`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'idempotency-key': post.idempotencyKey },
      body: JSON.stringify({ status: post.body, visibility: account.settings.visibility ?? 'public' }),
    });
    return { externalId: data.id, url: data.url ?? data.uri, status: 'PUBLISHED' };
  }

  async testConnection(account: ConnectorAccount): Promise<ConnectionTestResult> {
    const base = this.instanceUrl(account);
    const token = this.requiredString(account.credentials, 'accessToken');
    const { data } = await this.requestDynamic<MastodonAccount>(`${base}/api/v1/accounts/verify_credentials`, { headers: { authorization: `Bearer ${token}` } });
    return { ok: true, accountName: data.display_name ?? data.username };
  }

  async delete(account: ConnectorAccount, publishId: string): Promise<void> {
    const base = this.instanceUrl(account);
    const token = this.requiredString(account.credentials, 'accessToken');
    await this.requestDynamic(`${base}/api/v1/statuses/${encodeURIComponent(publishId)}`, { method: 'DELETE', headers: { authorization: `Bearer ${token}` } });
  }

  private instanceUrl(account: ConnectorAccount): string {
    const value = account.settings.instanceUrl ?? account.credentials.instanceUrl;
    return this.normalizeBaseUrl(this.requiredString({ instanceUrl: value }, 'instanceUrl'));
  }
}
