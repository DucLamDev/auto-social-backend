import { Injectable } from '@nestjs/common';
import { PlatformMode } from '@prisma/client';
import { ErrorCode } from '../../common/exceptions/application.exception';
import { ConnectorError } from '../core/connector-error';
import { HttpConnectorBase } from '../core/http-connector.base';
import { ConnectionTestResult, ConnectorAccount, PostPayload, PublishResult } from '../core/connector.types';
import { SocialPublisher } from '../core/social-publisher.interface';

interface LinkedInMe { sub?: string; name?: string }

@Injectable()
export class LinkedInConnector extends HttpConnectorBase implements SocialPublisher {
  readonly platform = 'linkedin';
  readonly mode = PlatformMode.OFFICIAL_API;
  readonly capability = { text: true, image: false, video: false, article: false, delete: false, schedule: false, analytics: false };

  validate(post: PostPayload): Promise<void> {
    if (!post.body.trim()) throw new ConnectorError(ErrorCode.PLATFORM_CONTENT_REJECTED, 'LinkedIn commentary is required', false);
    if (post.media?.length) throw new ConnectorError(ErrorCode.PLATFORM_MEDIA_INVALID, 'LinkedIn media registration is outside the MVP connector scope', false);
    return Promise.resolve();
  }

  async publish(account: ConnectorAccount, post: PostPayload): Promise<PublishResult> {
    await this.validate(post);
    const token = this.requiredString(account.credentials, 'accessToken');
    const author = account.externalId ?? this.requiredString(account.credentials, 'authorUrn');
    const version = this.version(account);
    const { headers } = await this.request<unknown>('https://api.linkedin.com/rest/posts', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-restli-protocol-version': '2.0.0', 'linkedin-version': version },
      body: JSON.stringify({ author, commentary: post.body, visibility: 'PUBLIC', distribution: { feedDistribution: 'MAIN_FEED', targetEntities: [], thirdPartyDistributionChannels: [] }, lifecycleState: 'PUBLISHED', isReshareDisabledByAuthor: false }),
    });
    const id = headers.get('x-restli-id');
    if (!id) throw new ConnectorError(ErrorCode.PLATFORM_API_ERROR, 'LinkedIn did not return a post identifier', false);
    return { externalId: id, status: 'PUBLISHED' };
  }

  async testConnection(account: ConnectorAccount): Promise<ConnectionTestResult> {
    const token = this.requiredString(account.credentials, 'accessToken');
    const { data } = await this.request<LinkedInMe>('https://api.linkedin.com/v2/userinfo', { headers: { authorization: `Bearer ${token}` } });
    return { ok: true, accountName: data.name, details: { externalId: data.sub } };
  }

  private version(account: ConnectorAccount): string {
    const value = this.requiredString(account.settings, 'apiVersion');
    if (!/^\d{6}$/.test(value)) throw new ConnectorError(ErrorCode.PLATFORM_AUTH_FAILED, 'LinkedIn apiVersion must use YYYYMM', false);
    return value;
  }
}
