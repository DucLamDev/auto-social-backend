import { Injectable } from '@nestjs/common';
import { PlatformMode } from '@prisma/client';
import { ErrorCode } from '../../common/exceptions/application.exception';
import { ConnectorError } from '../core/connector-error';
import { HttpConnectorBase } from '../core/http-connector.base';
import { ConnectionTestResult, ConnectorAccount, PostPayload, PublishResult } from '../core/connector.types';
import { SocialPublisher } from '../core/social-publisher.interface';

interface BlueskyRecord { uri: string; cid: string }
interface BlueskyProfile { did: string; handle: string; displayName?: string }
interface BlueskySession { accessJwt: string; did: string; handle?: string }

@Injectable()
export class BlueskyConnector extends HttpConnectorBase implements SocialPublisher {
  readonly platform = 'bluesky';
  readonly mode = PlatformMode.OFFICIAL_API;
  readonly capability = { text: true, image: false, video: false, article: false, delete: false, schedule: false, analytics: false, maxText: 300 };

  validate(post: PostPayload): Promise<void> {
    if (!post.body.trim() || post.body.length > 300) throw new ConnectorError(ErrorCode.PLATFORM_CONTENT_REJECTED, 'Bluesky post must contain 1-300 characters', false);
    if (post.media?.length) throw new ConnectorError(ErrorCode.PLATFORM_MEDIA_INVALID, 'Blob upload is outside the MVP Bluesky connector scope', false);
    return Promise.resolve();
  }

  async publish(account: ConnectorAccount, post: PostPayload): Promise<PublishResult> {
    await this.validate(post);
    const { token, did } = await this.session(account);
    const { data } = await this.requestDynamic<BlueskyRecord>(`${this.base(account)}/xrpc/com.atproto.repo.createRecord`, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ repo: did, collection: 'app.bsky.feed.post', record: { $type: 'app.bsky.feed.post', text: post.body, createdAt: new Date().toISOString() } }),
    });
    const rkey = data.uri.split('/').at(-1);
    return { externalId: data.uri, url: rkey ? `https://bsky.app/profile/${encodeURIComponent(did)}/post/${encodeURIComponent(rkey)}` : undefined, status: 'PUBLISHED', metadata: { cid: data.cid } };
  }

  async testConnection(account: ConnectorAccount): Promise<ConnectionTestResult> {
    const { token, did } = await this.session(account);
    const { data } = await this.requestDynamic<BlueskyProfile>(`${this.base(account)}/xrpc/app.bsky.actor.getProfile?actor=${encodeURIComponent(did)}`, { headers: { authorization: `Bearer ${token}` } });
    return { ok: true, accountName: data.displayName ?? data.handle, details: { externalId: data.did } };
  }

  /**
   * An App Password (Settings → Privacy and security → App passwords) never
   * expires, so a fresh 2-hour session is created per call. A pasted access JWT
   * is still accepted for existing accounts but lapses after about two hours.
   */
  private async session(account: ConnectorAccount): Promise<{ token: string; did: string }> {
    const appPassword = account.credentials.appPassword;
    if (typeof appPassword === 'string' && appPassword.trim()) {
      const identifier = this.requiredString(account.credentials, 'identifier');
      const { data } = await this.requestDynamic<BlueskySession>(`${this.base(account)}/xrpc/com.atproto.server.createSession`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ identifier: identifier.trim().replace(/^@/, ''), password: appPassword.trim() }),
      });
      return { token: data.accessJwt, did: data.did };
    }
    return {
      token: this.requiredString(account.credentials, 'accessJwt'),
      did: account.externalId ?? this.requiredString(account.credentials, 'did'),
    };
  }

  private base(account: ConnectorAccount): string {
    const value = typeof account.credentials.serviceUrl === 'string' ? account.credentials.serviceUrl : 'https://bsky.social';
    return this.normalizeBaseUrl(value);
  }
}
