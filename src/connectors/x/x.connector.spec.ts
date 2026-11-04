import { createHash } from 'node:crypto';
import { POST_MEDIA_MANAGED_STORAGE, PostMedia, PostPayload } from '../core/connector.types';
import { XConnector } from './x.connector';

/** validate() throws synchronously; run it as the publisher does, inside a promise. */
const validated = (connector: { validate(post: PostPayload): Promise<void> }, post: PostPayload) => Promise.resolve().then(() => connector.validate(post));


const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7]);
const account = { id: 'account-1', username: 'vpsttt', settings: {}, credentials: { accessToken: 'x-token' } }; // vpsttt-secretscan: ignore (token giả cho test)
const image = (sizeBytes = png.length): PostMedia => ({
  type: 'image', url: 'https://cdn.example/media.png', mimeType: 'image/png', altText: 'Bảng điều khiển VPS',
  [POST_MEDIA_MANAGED_STORAGE]: { storageKey: 'media/2026-11-03/a.png', checksum: createHash('sha256').update(png).digest('hex'), sizeBytes },
});
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });

describe('X connector images', () => {
  afterEach(() => jest.restoreAllMocks());

  it('uploads the image, adds its alt text and posts it with the text', async () => {
    const fetch = jest.spyOn(global, 'fetch')
      .mockResolvedValueOnce(json({ data: { id: 'media-1' } }))
      .mockResolvedValueOnce(json({}))
      .mockResolvedValueOnce(json({ data: { id: 'post-1' } }));
    const connector = new XConnector({ get: jest.fn().mockResolvedValue(png) } as never);

    const result = await connector.publish(account, { body: 'VPS NVMe', media: [image()], idempotencyKey: 'job-1' });

    expect(fetch.mock.calls.map(([url]) => url as string)).toEqual(['https://api.x.com/2/media/upload', 'https://api.x.com/2/media/metadata', 'https://api.x.com/2/tweets']);
    const upload = fetch.mock.calls[0]![1]!.body as FormData;
    expect(upload.get('media_category')).toBe('tweet_image');
    expect(JSON.parse(fetch.mock.calls[1]![1]!.body as string)).toEqual({ id: 'media-1', metadata: { alt_text: { text: 'Bảng điều khiển VPS' } } });
    expect(JSON.parse(fetch.mock.calls[2]![1]!.body as string)).toEqual({ text: 'VPS NVMe', media: { media_ids: ['media-1'] } });
    expect(result).toMatchObject({ externalId: 'post-1', url: 'https://x.com/vpsttt/status/post-1', status: 'PUBLISHED' });
  });

  it('posts text only, with a note, when the image is over the 5 MB limit', async () => {
    const fetch = jest.spyOn(global, 'fetch').mockResolvedValueOnce(json({ data: { id: 'post-2' } }));
    const storage = { get: jest.fn() };
    const result = await new XConnector(storage as never).publish(account, { body: 'VPS NVMe', media: [image(6 * 1024 * 1024)], idempotencyKey: 'job-2' });
    expect(storage.get).not.toHaveBeenCalled();
    expect(JSON.parse(fetch.mock.calls[0]![1]!.body as string)).toEqual({ text: 'VPS NVMe' });
    expect(result.metadata).toEqual({ mediaSkipped: 'Ảnh lớn hơn 5 MB, X không nhận; đã đăng chữ.' });
  });

  it('refuses a corrupted stored image before contacting X', async () => {
    const fetch = jest.spyOn(global, 'fetch');
    const connector = new XConnector({ get: jest.fn().mockResolvedValue(Buffer.from('tampered!')) } as never);
    await expect(connector.publish(account, { body: 'VPS NVMe', media: [image()], idempotencyKey: 'job-3' })).rejects.toThrow('checksum');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('surfaces a missing media.write permission as an X error', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValueOnce(new Response(JSON.stringify({ title: 'Forbidden' }), { status: 403, headers: { 'content-type': 'application/json' } }));
    const connector = new XConnector({ get: jest.fn().mockResolvedValue(png) } as never);
    await expect(connector.publish(account, { body: 'VPS NVMe', media: [image()], idempotencyKey: 'job-4' })).rejects.toMatchObject({ code: expect.stringMatching(/PLATFORM_/) as unknown });
  });
});

describe('X connector length check', () => {
  const connector = new XConnector();

  it('counts the way X does: links are 23 and letters with Vietnamese diacritics are 2', async () => {
    // 300 UTF-16 units, but X counts the link as 23.
    await expect(validated(connector, { body: `${'a'.repeat(200)} https://vpsttt.vn/${'b'.repeat(80)}`, idempotencyKey: 'k' })).resolves.toBeUndefined();
    await expect(validated(connector, { body: 'ạ'.repeat(141), idempotencyKey: 'k' })).rejects.toMatchObject({
      code: 'PLATFORM_CONTENT_REJECTED',
      message: 'Bài X dài 282/280 ký tự, vượt giới hạn của nền tảng. Rút gọn trước khi duyệt hoặc đăng.',
    });
    await expect(validated(connector, { body: '  ', idempotencyKey: 'k' })).rejects.toMatchObject({ code: 'PLATFORM_CONTENT_REJECTED' });
  });
});
