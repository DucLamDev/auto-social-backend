import { Injectable } from '@nestjs/common';
import { PlatformMode } from '@prisma/client';
import { ErrorCode } from '../../common/exceptions/application.exception';
import { ConnectorError } from '../core/connector-error';
import { HttpConnectorBase } from '../core/http-connector.base';
import { ConnectorAccount, ConnectionTestResult, PostPayload, PublishResult } from '../core/connector.types';
import { SocialPublisher } from '../core/social-publisher.interface';

interface WordPressPost { id: number; link?: string; status?: string }

@Injectable()
export class WordPressConnector extends HttpConnectorBase implements SocialPublisher {
  readonly platform = 'wordpress';
  readonly mode = PlatformMode.OFFICIAL_API;
  readonly capability = { text: true, image: false, video: false, article: true, delete: true, schedule: false, analytics: false };

  validate(post: PostPayload): Promise<void> {
    if (!post.title?.trim() || !post.body.trim()) {
      throw new ConnectorError(ErrorCode.PLATFORM_CONTENT_REJECTED, 'WordPress title and body are required', false);
    }
    return Promise.resolve();
  }

  async publish(account: ConnectorAccount, post: PostPayload): Promise<PublishResult> {
    await this.validate(post);
    const siteUrl = this.normalizeBaseUrl(this.requiredString(account.credentials, 'siteUrl'));
    const username = this.requiredString(account.credentials, 'username');
    const password = this.requiredString(account.credentials, 'applicationPassword');
    const requestedStatus = typeof account.settings.publishStatus === 'string'
      ? account.settings.publishStatus
      : 'publish';
    if (!['publish', 'draft', 'pending', 'private'].includes(requestedStatus)) {
      throw new ConnectorError(ErrorCode.PLATFORM_CONTENT_REJECTED, 'Unsupported WordPress publishStatus', false);
    }
    const { data } = await this.requestDynamic<WordPressPost>(`${siteUrl}/wp-json/wp/v2/posts`, {
      method: 'POST',
      headers: {
        authorization: `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ title: post.title, content: post.body, status: requestedStatus }),
    });
    const published = data.status === 'publish';
    return {
      externalId: String(data.id),
      url: data.link,
      status: published ? 'PUBLISHED' : 'NEEDS_ACTION',
      metadata: {
        status: data.status,
        ...(published ? {} : { externalPostId: String(data.id), url: data.link }),
      },
    };
  }

  async testConnection(account: ConnectorAccount): Promise<ConnectionTestResult> {
    const siteUrl = this.normalizeBaseUrl(this.requiredString(account.credentials, 'siteUrl'));
    const username = this.requiredString(account.credentials, 'username');
    const password = this.requiredString(account.credentials, 'applicationPassword');
    await this.requestDynamic(`${siteUrl}/wp-json/wp/v2/users/me?context=edit`, {
      headers: { authorization: `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}` },
    });
    return { ok: true, accountName: username };
  }

  async delete(account: ConnectorAccount, publishId: string): Promise<void> {
    const siteUrl = this.normalizeBaseUrl(this.requiredString(account.credentials, 'siteUrl'));
    const username = this.requiredString(account.credentials, 'username');
    const password = this.requiredString(account.credentials, 'applicationPassword');
    await this.requestDynamic(`${siteUrl}/wp-json/wp/v2/posts/${encodeURIComponent(publishId)}`, {
      method: 'DELETE',
      headers: { authorization: `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}` },
    });
  }
}
