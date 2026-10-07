import { Injectable } from '@nestjs/common';
import { PlatformMode } from '@prisma/client';
import { ErrorCode } from '../../common/exceptions/application.exception';
import { ConnectorError } from '../core/connector-error';
import { HttpConnectorBase } from '../core/http-connector.base';
import { ConnectorAccount, ConnectionTestResult, PostPayload, PublishResult } from '../core/connector.types';
import { SocialPublisher } from '../core/social-publisher.interface';

interface DevToArticle { id: number; url?: string }
interface DevToUser { name?: string; username?: string }

@Injectable()
export class DevToConnector extends HttpConnectorBase implements SocialPublisher {
  readonly platform = 'devto';
  readonly mode = PlatformMode.OFFICIAL_API;
  readonly capability = { text: true, image: false, video: false, article: true, delete: false, schedule: false, analytics: false };

  validate(post: PostPayload): Promise<void> {
    if (!post.title?.trim() || !post.body.trim()) throw new ConnectorError(ErrorCode.PLATFORM_CONTENT_REJECTED, 'DEV title and Markdown body are required', false);
    return Promise.resolve();
  }

  async publish(account: ConnectorAccount, post: PostPayload): Promise<PublishResult> {
    await this.validate(post);
    const key = this.requiredString(account.credentials, 'apiKey');
    const base = this.normalizeBaseUrl(typeof account.settings.baseUrl === 'string' ? account.settings.baseUrl : 'https://dev.to/api');
    const publishImmediately = account.settings.publishImmediately !== false;
    const { data } = await this.requestDynamic<DevToArticle>(`${base}/articles`, {
      method: 'POST',
      headers: { 'api-key': key, accept: 'application/vnd.forem.api-v1+json', 'content-type': 'application/json', 'user-agent': 'SocialPublisher/0.1' },
      body: JSON.stringify({
        article: {
          title: post.title,
          body_markdown: post.body,
          published: publishImmediately,
          tags: post.hashtags?.slice(0, 4).map((tag) => tag.replace(/^#/, '').trim()).filter(Boolean).join(','),
          canonical_url: post.canonicalUrl,
        },
      }),
    });
    return {
      externalId: String(data.id),
      url: data.url,
      status: publishImmediately ? 'PUBLISHED' : 'NEEDS_ACTION',
      metadata: publishImmediately
        ? undefined
        : { draft: true, externalPostId: String(data.id), url: data.url },
    };
  }

  async testConnection(account: ConnectorAccount): Promise<ConnectionTestResult> {
    const key = this.requiredString(account.credentials, 'apiKey');
    const base = this.normalizeBaseUrl(typeof account.settings.baseUrl === 'string' ? account.settings.baseUrl : 'https://dev.to/api');
    const { data } = await this.requestDynamic<DevToUser>(`${base}/users/me`, { headers: { 'api-key': key, accept: 'application/vnd.forem.api-v1+json', 'user-agent': 'SocialPublisher/0.1' } });
    return { ok: true, accountName: data.name ?? data.username };
  }
}
