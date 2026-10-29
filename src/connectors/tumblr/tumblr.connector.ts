import { Injectable } from '@nestjs/common';
import { PlatformMode } from '@prisma/client';
import { ErrorCode } from '../../common/exceptions/application.exception';
import { ConnectorError } from '../core/connector-error';
import { HttpConnectorBase } from '../core/http-connector.base';
import { ConnectionTestResult, ConnectorAccount, PostPayload, PublishResult } from '../core/connector.types';
import { isUncertainMetaPublishFailure } from '../core/meta-container';
import { SocialPublisher } from '../core/social-publisher.interface';

interface TumblrEnvelope<T> { meta?: { status?: number }; response: T }
interface TumblrBlog { name: string; uuid?: string; url?: string; title?: string }
interface NpfTextBlock { type: 'text'; text: string; subtype?: 'heading1' }

const API = 'https://api.tumblr.com/v2';
/** Tumblr requires a consistent User-Agent on every API call. */
const USER_AGENT = 'SocialPublisher/1.1 (+https://vpsttt.com)';
const MAX_BLOCK_LENGTH = 4096;

/** Splits text into NPF text blocks: one per paragraph, each under Tumblr's 4,096 code point limit. */
export function toNpfBlocks(title: string | undefined, body: string): NpfTextBlock[] {
  const blocks: NpfTextBlock[] = [];
  if (title?.trim()) blocks.push({ type: 'text', subtype: 'heading1', text: [...title.trim()].slice(0, MAX_BLOCK_LENGTH).join('') });
  for (const paragraph of body.split(/\n{2,}/).map((part) => part.trim()).filter(Boolean)) {
    const characters = [...paragraph];
    for (let offset = 0; offset < characters.length; offset += MAX_BLOCK_LENGTH) {
      blocks.push({ type: 'text', text: characters.slice(offset, offset + MAX_BLOCK_LENGTH).join('') });
    }
  }
  return blocks;
}

@Injectable()
export class TumblrConnector extends HttpConnectorBase implements SocialPublisher {
  readonly platform = 'tumblr';
  readonly mode = PlatformMode.OFFICIAL_API;
  readonly capability = { text: true, image: false, video: false, article: true, delete: false, schedule: false, analytics: false };

  validate(post: PostPayload): Promise<void> {
    if (!post.body.trim()) throw new ConnectorError(ErrorCode.PLATFORM_CONTENT_REJECTED, 'Tumblr post text is required', false);
    if (post.media?.length) throw new ConnectorError(ErrorCode.PLATFORM_MEDIA_INVALID, 'The Tumblr connector publishes text posts only', false);
    return Promise.resolve();
  }

  async publish(account: ConnectorAccount, post: PostPayload): Promise<PublishResult> {
    await this.validate(post);
    const token = this.requiredString(account.credentials, 'accessToken');
    const blog = this.blogIdentifier(account);
    const draft = account.settings.publishImmediately === false;
    const tags = (post.hashtags ?? []).map((tag) => tag.replace(/^#/, '').replace(/,/g, ' ').trim()).filter(Boolean);
    const body = post.canonicalUrl ? `${post.body}\n\n${post.canonicalUrl}` : post.body;
    let id: string;
    try {
      const { data } = await this.request<TumblrEnvelope<{ id: string | number }>>(`${API}/blog/${encodeURIComponent(blog)}/posts`, {
        method: 'POST',
        headers: this.headers(token, true),
        body: JSON.stringify({ content: toNpfBlocks(post.title, body), tags: tags.join(','), state: draft ? 'draft' : 'published' }),
      });
      id = String(data.response.id);
    } catch (error) {
      // A timeout/5xx may still have created the post; do not retry blindly.
      if (isUncertainMetaPublishFailure(error)) {
        return {
          externalId: `pending:tumblr:${post.idempotencyKey}`,
          status: 'NEEDS_ACTION',
          metadata: { reconciliationRequired: true, submissionUncertain: true, originalErrorCode: error.code },
        };
      }
      throw error;
    }
    const url = await this.request<TumblrEnvelope<{ posts?: Array<{ post_url?: string }> }>>(
      `${API}/blog/${encodeURIComponent(blog)}/posts?id=${encodeURIComponent(id)}`,
      { headers: this.headers(token) },
    ).then(({ data }) => data.response.posts?.[0]?.post_url).catch(() => undefined);
    return draft
      ? { externalId: id, url, status: 'NEEDS_ACTION', metadata: { draft: true, externalPostId: id, ...(url ? { url } : {}) } }
      : { externalId: id, url, status: 'PUBLISHED' };
  }

  async testConnection(account: ConnectorAccount): Promise<ConnectionTestResult> {
    const token = this.requiredString(account.credentials, 'accessToken');
    const blog = this.blogIdentifier(account);
    const { data } = await this.request<TumblrEnvelope<{ user: { name?: string; blogs?: TumblrBlog[] } }>>(`${API}/user/info`, { headers: this.headers(token) });
    const blogs = data.response.user.blogs ?? [];
    const match = blogs.find((item) => item.uuid === blog || item.name === blog);
    if (!match) throw new ConnectorError(ErrorCode.PLATFORM_PERMISSION_DENIED, 'This Tumblr login no longer has access to the configured blog', false);
    return { ok: true, accountName: match.title || match.name, details: { externalId: match.uuid ?? match.name } };
  }

  private blogIdentifier(account: ConnectorAccount): string {
    const value = account.externalId ?? account.settings.blogName;
    if (typeof value !== 'string' || !value.trim()) {
      throw new ConnectorError(ErrorCode.PLATFORM_AUTH_FAILED, 'Tumblr blog identifier is missing; reconnect the account', false);
    }
    return value.trim();
  }

  private headers(token: string, json = false): Record<string, string> {
    return {
      authorization: `Bearer ${token}`,
      'user-agent': USER_AGENT,
      accept: 'application/json',
      ...(json ? { 'content-type': 'application/json' } : {}),
    };
  }
}
