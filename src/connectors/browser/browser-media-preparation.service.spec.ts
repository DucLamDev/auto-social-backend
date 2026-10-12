import { createHash } from 'node:crypto';
import { access, readFile } from 'node:fs/promises';
import { StorageService } from '../../storage/storage.service';
import { POST_MEDIA_MANAGED_STORAGE, type PostMedia } from '../core/connector.types';
import type { BrowserPublishRecipe } from './browser-automation.types';
import {
  assertBrowserRecipeAcceptsMedia,
  BrowserMediaHttpClient,
  BrowserMediaPreparationService,
} from './browser-media-preparation.service';

const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);

const recipe = {
  key: 'reviewed-editor',
  allowedHosts: ['publisher.example.org'],
  finalSubmitPolicy: 'AUTOMATED',
  mediaPolicy: {
    images: {
      maxCount: 2,
      maxBytesPerImage: 1024,
      mimeTypes: ['image/png'],
    },
  },
} as unknown as BrowserPublishRecipe;

function httpResponse(
  body = png,
  contentType = 'image/png',
): { http: BrowserMediaHttpClient; requestBytes: jest.Mock } {
  const requestBytes = jest.fn().mockResolvedValue({
    ok: true,
    status: 200,
    headers: new Headers({ 'content-type': contentType }),
    body: Buffer.from(body),
  });
  return {
    http: { requestBytes },
    requestBytes,
  };
}

function storage(get = jest.fn()): { storage: StorageService; get: jest.Mock } {
  return { storage: { get } as unknown as StorageService, get };
}

describe('BrowserMediaPreparationService', () => {
  it('stages verified images for the recipe operation and always removes them', async () => {
    const { http, requestBytes } = httpResponse();
    const service = new BrowserMediaPreparationService(http, storage().storage);
    let path = '';

    const result = await service.withPreparedImages(
      recipe,
      {
        body: 'Post',
        idempotencyKey: 'job-1',
        media: [
          {
            type: 'image',
            url: 'https://cdn.example.org/post.png',
            mimeType: 'image/png',
            altText: 'Diagram',
          },
        ],
      },
      async (images) => {
        path = images[0]?.path ?? '';
        expect(images[0]).toMatchObject({
          mimeType: 'image/png',
          sizeBytes: png.length,
          altText: 'Diagram',
        });
        await expect(readFile(path)).resolves.toEqual(png);
        return 'prepared';
      },
    );

    expect(result).toBe('prepared');
    await expect(access(path)).rejects.toThrow();
    expect(requestBytes).toHaveBeenCalledWith(
      'https://cdn.example.org/post.png',
      expect.objectContaining({ method: 'GET' }),
      30_000,
    );
  });

  it('requires a reviewed recipe to opt in before fetching any media', async () => {
    const { http, requestBytes } = httpResponse();
    const service = new BrowserMediaPreparationService(http, storage().storage);
    const noMediaPolicy = { ...recipe, mediaPolicy: undefined };

    await expect(
      service.withPreparedImages(
        noMediaPolicy,
        {
          body: 'Post',
          idempotencyKey: 'job-1',
          media: [{ type: 'image', url: 'https://cdn.example.org/post.png' }],
        },
        () => Promise.resolve(undefined),
      ),
    ).rejects.toMatchObject({
      code: 'PLATFORM_MEDIA_INVALID',
      retryable: false,
    });
    expect(requestBytes).not.toHaveBeenCalled();
  });

  it.each([
    ['http://cdn.example.org/post.png', 'image/png'],
    ['https://user:secret@cdn.example.org/post.png', 'image/png'],
    ['https://cdn.example.org/post.png', 'image/jpeg'],
  ])('rejects unsafe or unsupported input before download: %s', async (url, mimeType) => {
    const { http, requestBytes } = httpResponse();
    const service = new BrowserMediaPreparationService(http, storage().storage);

    await expect(
      service.withPreparedImages(
        recipe,
        {
          body: 'Post',
          idempotencyKey: 'job-1',
          media: [{ type: 'image', url, mimeType }],
        },
        () => Promise.resolve(undefined),
      ),
    ).rejects.toMatchObject({ code: 'PLATFORM_MEDIA_INVALID' });
    expect(requestBytes).not.toHaveBeenCalled();
  });

  it('rejects response bytes that do not match the server Content-Type', async () => {
    const { http } = httpResponse(Buffer.from('not an image'), 'image/png; charset=binary');
    const service = new BrowserMediaPreparationService(http, storage().storage);

    await expect(
      service.withPreparedImages(
        recipe,
        {
          body: 'Post',
          idempotencyKey: 'job-1',
          media: [{ type: 'image', url: 'https://cdn.example.org/post.png' }],
        },
        () => Promise.resolve(undefined),
      ),
    ).rejects.toMatchObject({
      code: 'PLATFORM_MEDIA_INVALID',
      retryable: false,
    });
  });

  it('rejects excess images using the recipe-specific limit', () => {
    expect(() =>
      assertBrowserRecipeAcceptsMedia(recipe, [
        { type: 'image', url: 'https://cdn.example.org/1.png' },
        { type: 'image', url: 'https://cdn.example.org/2.png' },
        { type: 'image', url: 'https://cdn.example.org/3.png' },
      ]),
    ).toThrow('at most 2 images');
  });

  it('prefers verified app-owned storage even when its public URL is local HTTP', async () => {
    const { http, requestBytes } = httpResponse();
    const get = jest.fn().mockResolvedValue(Buffer.from(png));
    const service = new BrowserMediaPreparationService(http, storage(get).storage);
    const media: PostMedia = {
      type: 'image',
      url: 'http://localhost:9000/social-publisher/media/post.png',
      mimeType: 'image/png',
    };
    Object.defineProperty(media, POST_MEDIA_MANAGED_STORAGE, {
      enumerable: false,
      value: {
        storageKey: 'media/2026-10-09/post.png',
        checksum: createHash('sha256').update(png).digest('hex'),
        sizeBytes: png.length,
      },
    });

    await expect(
      service.withPreparedImages(
        recipe,
        {
          body: 'Post',
          idempotencyKey: 'job-1',
          media: [media],
        },
        async (images) => {
          await expect(readFile(images[0]?.path ?? '')).resolves.toEqual(png);
          return images.length;
        },
      ),
    ).resolves.toBe(1);

    expect(get).toHaveBeenCalledWith('media/2026-10-09/post.png', 1024);
    expect(requestBytes).not.toHaveBeenCalled();
  });

  it('rejects an app-owned object whose bytes do not match database provenance', async () => {
    const { http, requestBytes } = httpResponse();
    const get = jest.fn().mockResolvedValue(Buffer.from(png));
    const service = new BrowserMediaPreparationService(http, storage(get).storage);
    const media: PostMedia = {
      type: 'image',
      url: 'http://localhost:9000/social-publisher/media/post.png',
      mimeType: 'image/png',
      [POST_MEDIA_MANAGED_STORAGE]: {
        storageKey: 'media/2026-10-09/post.png',
        checksum: 'a'.repeat(64),
        sizeBytes: png.length,
      },
    };

    await expect(
      service.withPreparedImages(
        recipe,
        {
          body: 'Post',
          idempotencyKey: 'job-1',
          media: [media],
        },
        () => Promise.resolve(undefined),
      ),
    ).rejects.toThrow('checksum');
    expect(requestBytes).not.toHaveBeenCalled();
  });
});
