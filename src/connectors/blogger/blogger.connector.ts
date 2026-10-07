import { Injectable } from '@nestjs/common';
import { PlatformMode } from '@prisma/client';
import { ErrorCode } from '../../common/exceptions/application.exception';
import { ConnectorError } from '../core/connector-error';
import { HttpConnectorBase } from '../core/http-connector.base';
import { ConnectionTestResult, ConnectorAccount, PostPayload, PublishResult } from '../core/connector.types';
import { SocialPublisher } from '../core/social-publisher.interface';

interface BloggerPost { id: string; url?: string; title?: string }
interface BloggerBlog { id: string; name?: string }

@Injectable()
export class BloggerConnector extends HttpConnectorBase implements SocialPublisher {
  readonly platform = 'blogger';
  readonly mode = PlatformMode.OFFICIAL_API;
  readonly capability = { text: true, image: false, video: false, article: true, delete: true, schedule: false, analytics: false };

  validate(post: PostPayload): Promise<void> {
    if (!post.title?.trim() || !post.body.trim()) throw new ConnectorError(ErrorCode.PLATFORM_CONTENT_REJECTED, 'Blogger title and content are required', false);
    return Promise.resolve();
  }

  async publish(account: ConnectorAccount, post: PostPayload): Promise<PublishResult> {
    await this.validate(post);
    const token = this.requiredString(account.credentials, 'accessToken');
    const blogId = account.externalId ?? this.requiredString(account.credentials, 'blogId');
    const isDraft = account.settings.publishImmediately === false;
    const { data } = await this.request<BloggerPost>(`https://www.googleapis.com/blogger/v3/blogs/${encodeURIComponent(blogId)}/posts?isDraft=${String(isDraft)}`, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ title: post.title, content: post.body, labels: post.hashtags }),
    });
    return {
      externalId: data.id,
      url: data.url,
      status: isDraft ? 'NEEDS_ACTION' : 'PUBLISHED',
      metadata: isDraft ? { draft: true, externalPostId: data.id, url: data.url } : undefined,
    };
  }

  async testConnection(account: ConnectorAccount): Promise<ConnectionTestResult> {
    const token = this.requiredString(account.credentials, 'accessToken');
    const blogId = account.externalId ?? this.requiredString(account.credentials, 'blogId');
    const { data } = await this.request<BloggerBlog>(`https://www.googleapis.com/blogger/v3/blogs/${encodeURIComponent(blogId)}`, { headers: { authorization: `Bearer ${token}` } });
    return { ok: true, accountName: data.name, details: { externalId: data.id } };
  }

  async delete(account: ConnectorAccount, publishId: string): Promise<void> {
    const token = this.requiredString(account.credentials, 'accessToken');
    const blogId = account.externalId ?? this.requiredString(account.credentials, 'blogId');
    await this.request(`https://www.googleapis.com/blogger/v3/blogs/${encodeURIComponent(blogId)}/posts/${encodeURIComponent(publishId)}`, { method: 'DELETE', headers: { authorization: `Bearer ${token}` } });
  }
}
