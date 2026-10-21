import { Injectable } from '@nestjs/common';
import { PlatformMode } from '@prisma/client';
import { ErrorCode } from '../../common/exceptions/application.exception';
import { ConnectorError } from '../core/connector-error';
import { HttpConnectorBase } from '../core/http-connector.base';
import { ConnectionTestResult, ConnectorAccount, PostPayload, PublishResult } from '../core/connector.types';
import { SocialPublisher } from '../core/social-publisher.interface';
import { ContainerPollOptions, waitForMetaContainer } from '../core/meta-container';

interface ThreadsResponse { id: string; permalink?: string; username?: string; status?: string }

@Injectable()
export class ThreadsConnector extends HttpConnectorBase implements SocialPublisher {
  readonly platform = 'threads';
  readonly mode = PlatformMode.OFFICIAL_API;
  readonly capability = { text: true, image: true, video: false, article: false, delete: false, schedule: false, analytics: false, maxText: 500 };
  /** Meta suggests about 30 seconds for media processing; text containers are usually ready at once. */
  protected containerPoll: ContainerPollOptions = { intervalMs: 3_000, maxPolls: 20 };

  validate(post: PostPayload): Promise<void> {
    if (!post.body.trim()) throw new ConnectorError(ErrorCode.PLATFORM_CONTENT_REJECTED, 'Threads text is required', false);
    if (post.body.length > 500) throw new ConnectorError(ErrorCode.PLATFORM_CONTENT_REJECTED, 'Threads text exceeds 500 characters', false);
    if ((post.media?.length ?? 0) > 1) throw new ConnectorError(ErrorCode.PLATFORM_MEDIA_INVALID, 'MVP Threads connector accepts one media item', false);
    if (post.media?.some((media) => media.type !== 'image')) throw new ConnectorError(ErrorCode.PLATFORM_MEDIA_INVALID, 'MVP Threads connector supports image media only', false);
    return Promise.resolve();
  }

  async publish(account: ConnectorAccount, post: PostPayload): Promise<PublishResult> {
    await this.validate(post);
    const token = this.requiredString(account.credentials, 'accessToken');
    const userId = account.externalId ?? this.requiredString(account.credentials, 'userId');
    const media = post.media?.[0];
    const params = new URLSearchParams({ access_token: token, text: post.body, media_type: media ? media.type.toUpperCase() : 'TEXT' });
    if (media?.type === 'image') params.set('image_url', media.url);
    const { data: container } = await this.request<ThreadsResponse>(`${this.base(account)}/${encodeURIComponent(userId)}/threads`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: params,
    });
    await waitForMetaContainer(async () => {
      const { data: state } = await this.request<ThreadsResponse>(
        `${this.base(account)}/${encodeURIComponent(container.id)}?fields=status&access_token=${encodeURIComponent(token)}`,
        {},
      );
      return state.status;
    }, this.containerPoll);
    const publish = new URLSearchParams({ access_token: token, creation_id: container.id });
    const { data } = await this.request<ThreadsResponse>(`${this.base(account)}/${encodeURIComponent(userId)}/threads_publish`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: publish,
    });
    // The post is live once threads_publish returns; a failed permalink lookup
    // must not surface as a retryable error, or the job would post it twice.
    const permalink = await this.request<ThreadsResponse>(`${this.base(account)}/${encodeURIComponent(data.id)}?fields=id,permalink&access_token=${encodeURIComponent(token)}`, {})
      .then(({ data: detail }) => detail.permalink)
      .catch(() => undefined);
    return { externalId: data.id, url: permalink, status: 'PUBLISHED', metadata: { containerId: container.id } };
  }

  async testConnection(account: ConnectorAccount): Promise<ConnectionTestResult> {
    const token = this.requiredString(account.credentials, 'accessToken');
    const { data } = await this.request<ThreadsResponse>(`${this.base(account)}/me?fields=id,username&access_token=${encodeURIComponent(token)}`, {});
    return { ok: true, accountName: data.username, details: { externalId: data.id } };
  }

  private base(account: ConnectorAccount): string {
    const version = this.requiredString(account.settings, 'apiVersion');
    if (!/^v\d+\.\d+$/.test(version)) throw new ConnectorError(ErrorCode.PLATFORM_AUTH_FAILED, 'Threads apiVersion must look like v1.0', false);
    return `https://graph.threads.com/${version}`;
  }
}
