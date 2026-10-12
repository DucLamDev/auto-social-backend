import { Inject, Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ErrorCode } from '../../common/exceptions/application.exception';
import { StorageService } from '../../storage/storage.service';
import { ConnectorError } from '../core/connector-error';
import {
  ConnectorOutboundHttpBinaryResponse,
  ConnectorOutboundHttpClient,
} from '../core/connector-outbound-http.client';
import {
  POST_MEDIA_MANAGED_STORAGE,
  type PostMedia,
  type PostMediaManagedStorage,
  type PostPayload,
} from '../core/connector.types';
import type {
  BrowserImageMimeType,
  BrowserPreparedImage,
  BrowserPublishRecipe,
  BrowserRecipeMediaPolicy,
} from './browser-automation.types';

export const BROWSER_MEDIA_HTTP_CLIENT = Symbol('BROWSER_MEDIA_HTTP_CLIENT');
export const MAX_BROWSER_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_BROWSER_IMAGE_COUNT = 4;

export interface BrowserMediaHttpClient {
  requestBytes(
    input: string,
    init: RequestInit,
    timeoutMs: number,
  ): Promise<ConnectorOutboundHttpBinaryResponse>;
}

const FORMATS: Readonly<
  Record<
    BrowserImageMimeType,
    {
      extension: string;
      matches: (body: Buffer) => boolean;
    }
  >
> = {
  'image/jpeg': {
    extension: '.jpg',
    matches: (body) => body.length >= 3 && body[0] === 0xff && body[1] === 0xd8 && body[2] === 0xff,
  },
  'image/png': {
    extension: '.png',
    matches: (body) =>
      body.length >= 8 &&
      body.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  },
  'image/webp': {
    extension: '.webp',
    matches: (body) =>
      body.length >= 12 &&
      body.subarray(0, 4).toString('ascii') === 'RIFF' &&
      body.subarray(8, 12).toString('ascii') === 'WEBP',
  },
};

const MANAGED_IMAGE_KEY = /^media\/[a-zA-Z0-9/_-]+\.(?:jpe?g|png|webp)$/;
const SHA256 = /^[a-f0-9]{64}$/i;

function invalidMedia(message: string): never {
  throw new ConnectorError(ErrorCode.PLATFORM_MEDIA_INVALID, message, false);
}

function normalizedContentType(value: string | null): string {
  return (value ?? '').split(';', 1)[0]?.trim().toLowerCase() ?? '';
}

function checkedPolicy(recipe: BrowserPublishRecipe): BrowserRecipeMediaPolicy['images'] {
  const policy = recipe.mediaPolicy?.images;
  if (!policy) invalidMedia(`Browser recipe '${recipe.key}' has not opted in to image upload`);
  if (
    !Number.isInteger(policy.maxCount) ||
    policy.maxCount < 1 ||
    policy.maxCount > MAX_BROWSER_IMAGE_COUNT
  ) {
    throw new Error(`Browser recipe '${recipe.key}' has an invalid image count policy`);
  }
  if (
    !Number.isInteger(policy.maxBytesPerImage) ||
    policy.maxBytesPerImage < 1 ||
    policy.maxBytesPerImage > MAX_BROWSER_IMAGE_BYTES
  ) {
    throw new Error(`Browser recipe '${recipe.key}' has an invalid image size policy`);
  }
  if (!policy.mimeTypes.length || policy.mimeTypes.some((mimeType) => !(mimeType in FORMATS))) {
    throw new Error(`Browser recipe '${recipe.key}' has an invalid image MIME policy`);
  }
  return policy;
}

function assertManagedStorage(
  managed: PostMediaManagedStorage,
  policy: BrowserRecipeMediaPolicy['images'],
): void {
  if (
    !MANAGED_IMAGE_KEY.test(managed.storageKey) ||
    managed.storageKey.includes('..') ||
    !SHA256.test(managed.checksum) ||
    !Number.isSafeInteger(managed.sizeBytes) ||
    managed.sizeBytes < 1 ||
    managed.sizeBytes > policy.maxBytesPerImage
  ) {
    invalidMedia('Managed browser image provenance is invalid or exceeds the recipe limit');
  }
}

/** Reject unsupported media before a browser is opened or any URL is fetched. */
export function assertBrowserRecipeAcceptsMedia(
  recipe: BrowserPublishRecipe,
  media: readonly PostMedia[] | undefined,
): void {
  if (!media?.length) return;
  const policy = checkedPolicy(recipe);
  if (media.length > policy.maxCount) {
    invalidMedia(`Browser recipe '${recipe.key}' accepts at most ${policy.maxCount} images`);
  }
  for (const asset of media) {
    if (asset.type !== 'image') invalidMedia('Browser-assisted publishing only accepts images');
    const managed = asset[POST_MEDIA_MANAGED_STORAGE];
    if (managed) {
      assertManagedStorage(managed, policy);
    }
    const declaredMime = asset.mimeType?.trim().toLowerCase();
    if (managed && !declaredMime) {
      invalidMedia('Managed browser images require their verified MIME type');
    }
    if (declaredMime && !policy.mimeTypes.includes(declaredMime as BrowserImageMimeType)) {
      invalidMedia(`Browser recipe '${recipe.key}' does not accept ${declaredMime}`);
    }
    if (managed) continue;
    let parsed: URL;
    try {
      parsed = new URL(asset.url);
    } catch {
      invalidMedia('Browser image URL must be an absolute HTTPS URL');
    }
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
      invalidMedia('Browser image URL must be an absolute HTTPS URL without URL credentials');
    }
  }
}

/**
 * Downloads reviewed-recipe image inputs through the connector SSRF guard and
 * exposes private temporary files only while the recipe operation is running.
 */
@Injectable()
export class BrowserMediaPreparationService {
  private readonly logger = new Logger(BrowserMediaPreparationService.name);

  constructor(
    @Inject(BROWSER_MEDIA_HTTP_CLIENT)
    private readonly http: BrowserMediaHttpClient,
    private readonly storage: StorageService,
  ) {}

  async withPreparedImages<T>(
    recipe: BrowserPublishRecipe,
    post: PostPayload,
    operation: (images: readonly BrowserPreparedImage[]) => Promise<T>,
  ): Promise<T> {
    if (!post.media?.length) return operation([]);
    assertBrowserRecipeAcceptsMedia(recipe, post.media);
    const policy = checkedPolicy(recipe);
    const directory = await mkdtemp(join(tmpdir(), 'social-publisher-browser-media-'));
    try {
      await chmod(directory, 0o700);
      const prepared: BrowserPreparedImage[] = [];
      for (const [index, asset] of post.media.entries()) {
        prepared.push(await this.downloadImage(asset, policy, directory, index));
      }
      return await operation(prepared);
    } finally {
      await rm(directory, { recursive: true, force: true }).catch((error: unknown) => {
        this.logger.warn(
          JSON.stringify({
            event: 'BROWSER_MEDIA_CLEANUP_FAILED',
            errorType: error instanceof Error ? error.name : 'UnknownError',
          }),
        );
      });
    }
  }

  private async downloadImage(
    asset: PostMedia,
    policy: BrowserRecipeMediaPolicy['images'],
    directory: string,
    index: number,
  ): Promise<BrowserPreparedImage> {
    const { body, mimeType: typedMime } = await this.loadImage(asset, policy);
    const sizeBytes = body.length;
    const format = FORMATS[typedMime];
    if (!format.matches(body)) {
      body.fill(0);
      invalidMedia('Browser image bytes do not match the response MIME type');
    }

    const path = join(directory, `${index + 1}${format.extension}`);
    try {
      await writeFile(path, body, { mode: 0o600, flag: 'wx' });
    } finally {
      body.fill(0);
    }
    return {
      path,
      mimeType: typedMime,
      sizeBytes,
      ...(asset.altText?.trim() ? { altText: asset.altText.trim() } : {}),
    };
  }

  private async loadImage(
    asset: PostMedia,
    policy: BrowserRecipeMediaPolicy['images'],
  ): Promise<{ body: Buffer; mimeType: BrowserImageMimeType }> {
    const managed = asset[POST_MEDIA_MANAGED_STORAGE];
    if (managed) {
      assertManagedStorage(managed, policy);
      const mimeType = asset.mimeType?.trim().toLowerCase() as BrowserImageMimeType;
      const body = await this.storage.get(managed.storageKey, policy.maxBytesPerImage);
      if (
        body.length !== managed.sizeBytes ||
        createHash('sha256').update(body).digest('hex') !== managed.checksum.toLowerCase()
      ) {
        body.fill(0);
        invalidMedia('Managed browser image failed its stored size or checksum verification');
      }
      return { body, mimeType };
    }

    const response = await this.http.requestBytes(
      asset.url,
      {
        method: 'GET',
        headers: { accept: policy.mimeTypes.join(', ') },
      },
      30_000,
    );
    if (!response.ok) {
      throw new ConnectorError(
        ErrorCode.PLATFORM_API_ERROR,
        'The browser image could not be downloaded from public storage',
        response.status === 429 || response.status >= 500,
        undefined,
        { httpStatus: response.status },
      );
    }

    const mimeType = normalizedContentType(response.headers.get('content-type'));
    if (!policy.mimeTypes.includes(mimeType as BrowserImageMimeType)) {
      response.body.fill(0);
      invalidMedia('Browser image response has an unsupported Content-Type');
    }
    const typedMime = mimeType as BrowserImageMimeType;
    if (asset.mimeType && asset.mimeType.trim().toLowerCase() !== typedMime) {
      response.body.fill(0);
      invalidMedia('Browser image response does not match its declared MIME type');
    }
    if (response.body.length === 0 || response.body.length > policy.maxBytesPerImage) {
      response.body.fill(0);
      invalidMedia(`Browser image exceeds the ${policy.maxBytesPerImage}-byte recipe limit`);
    }
    return { body: response.body, mimeType: typedMime };
  }
}

export function createBrowserMediaHttpClient(): BrowserMediaHttpClient {
  return new ConnectorOutboundHttpClient();
}
