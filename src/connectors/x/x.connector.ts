import { Injectable, Optional } from '@nestjs/common';
import { PlatformMode } from '@prisma/client';
import { createHash } from 'node:crypto';
import { ErrorCode } from '../../common/exceptions/application.exception';
import { checkTextLength, postLengthMessage } from '../../platforms/post-length';
import { StorageService } from '../../storage/storage.service';
import { ConnectorError } from '../core/connector-error';
import { HttpConnectorBase } from '../core/http-connector.base';
import { ConnectionTestResult, ConnectorAccount, POST_MEDIA_MANAGED_STORAGE, PostMedia, PostPayload, PublishResult } from '../core/connector.types';
import { SocialPublisher } from '../core/social-publisher.interface';

interface XPostResponse { data: { id: string; text?: string } }
interface XMeResponse { data: { id: string; name?: string; username?: string } }
interface XMediaResponse { data: { id: string; media_key?: string } }

/** X accepts still images up to 5 MB in one request. */
const MAX_X_IMAGE_BYTES = 5 * 1024 * 1024;
const X_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);

@Injectable()
export class XConnector extends HttpConnectorBase implements SocialPublisher {
  readonly platform = 'x';
  readonly mode = PlatformMode.OFFICIAL_API;
  readonly capability = { text: true, image: true, video: false, article: false, delete: true, schedule: false, analytics: false, maxText: 280, maxImages: 1 };

  constructor(@Optional() private readonly storage?: StorageService) {
    super();
  }

  validate(post: PostPayload): Promise<void> {
    if (!post.body.trim()) throw new ConnectorError(ErrorCode.PLATFORM_CONTENT_REJECTED, 'X post must contain 1-280 characters', false);
    // X's weighted count: links are 23, letters with Vietnamese diacritics 2.
    const length = checkTextLength(this.platform, post.body);
    if (length.over) throw new ConnectorError(ErrorCode.PLATFORM_CONTENT_REJECTED, postLengthMessage('X', length), false);
    if (post.media?.some((media) => media.type !== 'image')) throw new ConnectorError(ErrorCode.PLATFORM_MEDIA_INVALID, 'X posts from this connector support images only', false);
    if ((post.media?.length ?? 0) > 1) throw new ConnectorError(ErrorCode.PLATFORM_MEDIA_INVALID, 'X posts from this connector support one image', false);
    return Promise.resolve();
  }

  async publish(account: ConnectorAccount, post: PostPayload): Promise<PublishResult> {
    await this.validate(post);
    const token = this.requiredString(account.credentials, 'accessToken');
    const image = post.media?.[0];
    const upload = image ? await this.loadImage(image) : undefined;
    const mediaId = upload?.bytes ? await this.uploadImage(token, upload.bytes, upload.mimeType, image?.altText) : undefined;
    const { data } = await this.request<XPostResponse>('https://api.x.com/2/tweets', {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ text: post.body, ...(mediaId ? { media: { media_ids: [mediaId] } } : {}) }),
    });
    const username = account.username;
    return {
      externalId: data.data.id,
      url: username ? `https://x.com/${encodeURIComponent(username)}/status/${data.data.id}` : undefined,
      status: 'PUBLISHED',
      ...(upload?.skipped ? { metadata: { mediaSkipped: upload.skipped } } : {}),
    };
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

  /**
   * Reads a managed image from storage and verifies it. An image over the X
   * limit is left out and the post goes out as text with a note.
   */
  private async loadImage(media: PostMedia): Promise<{ bytes?: Buffer; mimeType: string; skipped?: string }> {
    const managed = media[POST_MEDIA_MANAGED_STORAGE];
    const mimeType = (media.mimeType ?? '').toLowerCase();
    if (!managed || !this.storage || !X_IMAGE_TYPES.has(mimeType)) return { mimeType, skipped: 'Ảnh không nằm trong kho ảnh của hệ thống hoặc không phải PNG/JPEG/WebP; đã đăng chữ.' };
    if (managed.sizeBytes > MAX_X_IMAGE_BYTES) return { mimeType, skipped: 'Ảnh lớn hơn 5 MB, X không nhận; đã đăng chữ.' };
    let bytes: Buffer;
    try { bytes = await this.storage.get(managed.storageKey, MAX_X_IMAGE_BYTES); }
    catch { throw new ConnectorError(ErrorCode.PLATFORM_API_ERROR, 'Stored X image could not be loaded', true); }
    if (bytes.length !== managed.sizeBytes || createHash('sha256').update(bytes).digest('hex') !== managed.checksum.toLowerCase()) {
      throw new ConnectorError(ErrorCode.PLATFORM_MEDIA_INVALID, 'Stored X image failed its size or checksum verification', false);
    }
    return { bytes, mimeType };
  }

  /** v2 one-request image upload; needs the media.write scope on the user token. */
  private async uploadImage(token: string, bytes: Buffer, mimeType: string, altText?: string): Promise<string> {
    const form = new FormData();
    form.append('media', new Blob([Uint8Array.from(bytes)], { type: mimeType }), 'image');
    form.append('media_category', 'tweet_image');
    form.append('media_type', mimeType);
    const { data } = await this.request<XMediaResponse>('https://api.x.com/2/media/upload', {
      method: 'POST', headers: { authorization: `Bearer ${token}` }, body: form,
    }, 60_000);
    const id = data.data?.id;
    if (!id) throw new ConnectorError(ErrorCode.PLATFORM_API_ERROR, 'X did not return a media id', true);
    const description = altText?.trim().slice(0, 1_000);
    if (description) {
      // Alt text improves accessibility but must not block the post.
      try {
        await this.request('https://api.x.com/2/media/metadata', {
          method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ id, metadata: { alt_text: { text: description } } }),
        });
      } catch { /* posted without alt text */ }
    }
    return id;
  }
}
