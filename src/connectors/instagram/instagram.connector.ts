import { Injectable } from '@nestjs/common';
import { PlatformMode } from '@prisma/client';
import { ErrorCode } from '../../common/exceptions/application.exception';
import { ConnectorError } from '../core/connector-error';
import { HttpConnectorBase } from '../core/http-connector.base';
import { ConnectionTestResult, ConnectorAccount, PostPayload, PublishResult } from '../core/connector.types';
import { SocialPublisher } from '../core/social-publisher.interface';
import { ContainerPollOptions, isUncertainMetaPublishFailure, uncertainMetaPublishResult, waitForMetaContainer } from '../core/meta-container';

interface MetaIdResponse { id: string }
interface ContainerState { status_code?: string }
interface InstagramMedia { id: string; permalink?: string }
interface InstagramProfile { id: string; username?: string }

@Injectable()
export class InstagramConnector extends HttpConnectorBase implements SocialPublisher {
  readonly platform = 'instagram';
  readonly mode = PlatformMode.OFFICIAL_API;
  readonly capability = { text: false, image: true, video: false, article: false, delete: false, schedule: false, analytics: false, maxImages: 1 };
  protected containerPoll: ContainerPollOptions = { intervalMs: 3_000, maxPolls: 20 };

  validate(post: PostPayload): Promise<void> {
    if (!post.media?.length) {
      throw new ConnectorError(ErrorCode.PLATFORM_MEDIA_INVALID, 'Instagram publishing requires image or video media', false);
    }
    if (post.media.length > 1) {
      throw new ConnectorError(ErrorCode.PLATFORM_MEDIA_INVALID, 'MVP Instagram connector accepts one media item per post', false);
    }
    if (post.media[0]?.type !== 'image') {
      throw new ConnectorError(ErrorCode.PLATFORM_MEDIA_INVALID, 'MVP Instagram connector supports single-image publishing only', false);
    }
    return Promise.resolve();
  }

  async publish(account: ConnectorAccount, post: PostPayload): Promise<PublishResult> {
    await this.validate(post);
    const accessToken = this.requiredString(account.credentials, 'accessToken');
    const userId = account.externalId ?? this.requiredString(account.credentials, 'userId');
    const media = post.media?.[0];
    if (!media) throw new ConnectorError(ErrorCode.PLATFORM_MEDIA_INVALID, 'Media is required', false);
    const create = new URLSearchParams({ access_token: accessToken, caption: this.caption(post) });
    create.set('image_url', media.url);
    const { data: container } = await this.request<MetaIdResponse>(`${this.base(account)}/${encodeURIComponent(userId)}/media`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: create,
    });
    await waitForMetaContainer(async () => {
      const { data: state } = await this.request<ContainerState>(
        `${this.base(account)}/${encodeURIComponent(container.id)}?fields=status_code&access_token=${encodeURIComponent(accessToken)}`,
        {},
      );
      return state.status_code;
    }, this.containerPoll);
    const publish = new URLSearchParams({ access_token: accessToken, creation_id: container.id });
    let data: MetaIdResponse;
    try {
      data = (await this.request<MetaIdResponse>(`${this.base(account)}/${encodeURIComponent(userId)}/media_publish`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: publish,
      })).data;
    } catch (error) {
      if (isUncertainMetaPublishFailure(error)) return uncertainMetaPublishResult(container.id, error);
      throw error;
    }
    // media_publish already made the post public; never turn a failed
    // permalink lookup into a retry that would publish it a second time.
    const permalink = await this.request<InstagramMedia>(`${this.base(account)}/${encodeURIComponent(data.id)}?fields=id,permalink&access_token=${encodeURIComponent(accessToken)}`, {})
      .then(({ data: detail }) => detail.permalink)
      .catch(() => undefined);
    return { externalId: data.id, url: permalink, status: 'PUBLISHED', metadata: { containerId: container.id } };
  }

  async testConnection(account: ConnectorAccount): Promise<ConnectionTestResult> {
    const token = this.requiredString(account.credentials, 'accessToken');
    const { data } = await this.request<InstagramProfile>(`${this.base(account)}/me?fields=id,username&access_token=${encodeURIComponent(token)}`, {});
    return { ok: true, accountName: data.username, details: { externalId: data.id } };
  }

  private base(account: ConnectorAccount): string {
    const version = this.requiredString(account.settings, 'apiVersion');
    if (!/^v\d+\.\d+$/.test(version)) throw new ConnectorError(ErrorCode.PLATFORM_AUTH_FAILED, 'Instagram apiVersion must look like v24.0', false);
    return `https://graph.instagram.com/${version}`;
  }

  private caption(post: PostPayload): string {
    const hashtags = post.hashtags?.map((tag) => `#${tag.replace(/^#/, '')}`).join(' ') ?? '';
    return [post.body, hashtags].filter(Boolean).join('\n\n');
  }
}
