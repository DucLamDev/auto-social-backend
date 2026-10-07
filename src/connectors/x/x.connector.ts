import { Injectable } from '@nestjs/common';
import { PlatformMode } from '@prisma/client';
import { ErrorCode } from '../../common/exceptions/application.exception';
import { ConnectorError } from '../core/connector-error';
import { HttpConnectorBase } from '../core/http-connector.base';
import { ConnectionTestResult, ConnectorAccount, PostPayload, PublishResult } from '../core/connector.types';
import { SocialPublisher } from '../core/social-publisher.interface';

interface XPostResponse { data: { id: string; text?: string } }
interface XMeResponse { data: { id: string; name?: string; username?: string } }

@Injectable()
export class XConnector extends HttpConnectorBase implements SocialPublisher {
  readonly platform = 'x';
  readonly mode = PlatformMode.OFFICIAL_API;
  readonly capability = { text: true, image: false, video: false, article: false, delete: true, schedule: false, analytics: false, maxText: 280 };

  validate(post: PostPayload): Promise<void> {
    if (!post.body.trim() || post.body.length > 280) throw new ConnectorError(ErrorCode.PLATFORM_CONTENT_REJECTED, 'X post must contain 1-280 characters', false);
    if (post.media?.length) throw new ConnectorError(ErrorCode.PLATFORM_MEDIA_INVALID, 'Media upload is outside the MVP X connector scope', false);
    return Promise.resolve();
  }

  async publish(account: ConnectorAccount, post: PostPayload): Promise<PublishResult> {
    await this.validate(post);
    const token = this.requiredString(account.credentials, 'accessToken');
    const { data } = await this.request<XPostResponse>('https://api.x.com/2/tweets', {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ text: post.body }),
    });
    const username = account.username;
    return { externalId: data.data.id, url: username ? `https://x.com/${encodeURIComponent(username)}/status/${data.data.id}` : undefined, status: 'PUBLISHED' };
  }

  async testConnection(account: ConnectorAccount): Promise<ConnectionTestResult> {
    const token = this.requiredString(account.credentials, 'accessToken');
    const { data } = await this.request<XMeResponse>('https://api.x.com/2/users/me', { headers: { authorization: `Bearer ${token}` } });
    return { ok: true, accountName: data.data.name ?? data.data.username, details: { externalId: data.data.id } };
  }

  async delete(account: ConnectorAccount, publishId: string): Promise<void> {
    const token = this.requiredString(account.credentials, 'accessToken');
    await this.request(`https://api.x.com/2/tweets/${encodeURIComponent(publishId)}`, { method: 'DELETE', headers: { authorization: `Bearer ${token}` } });
  }
}
