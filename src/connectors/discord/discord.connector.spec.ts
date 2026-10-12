import { createHash } from 'node:crypto';
import { ErrorCode } from '../../common/exceptions/application.exception';
import { StorageService } from '../../storage/storage.service';
import {
  ConnectorAccount,
  POST_MEDIA_MANAGED_STORAGE,
  PostMedia,
  PostPayload,
} from '../core/connector.types';
import { DiscordConnector } from './discord.connector';

const webhookUrl = 'https://discord.com/api/webhooks/123456789012345678/secret-webhook-token';

const account: ConnectorAccount = {
  id: 'account-1',
  credentials: { webhookUrl },
  settings: {},
};

const post: PostPayload = {
  title: 'Deploying the API safely',
  body: 'A compact Discord update.',
  idempotencyKey: 'job-1',
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function requestUrl(input: string | URL | Request): URL {
  if (input instanceof Request) return new URL(input.url);
  return new URL(input.toString());
}

function connector(get = jest.fn<Promise<Buffer>, [key: string, maxBytes: number]>()) {
  return {
    connector: new DiscordConnector({ get } as unknown as StorageService),
    get,
  };
}

function managedImage(body: Buffer, overrides: Partial<PostMedia> = {}): PostMedia {
  const media: PostMedia = {
    type: 'image',
    url: 'http://minio:9000/social-publisher/media/private.png',
    mimeType: 'image/png',
    altText: 'Dashboard after deployment',
    ...overrides,
  };
  Object.defineProperty(media, POST_MEDIA_MANAGED_STORAGE, {
    enumerable: false,
    value: {
      storageKey: 'media/2026-10-09/private.png',
      checksum: createHash('sha256').update(body).digest('hex'),
      sizeBytes: body.length,
    },
  });
  return media;
}

describe('DiscordConnector', () => {
  afterEach(() => jest.restoreAllMocks());

  it('publishes text and public images with safe mentions and optional webhook presentation', async () => {
    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValueOnce(jsonResponse({
      id: '333333333333333333',
      channel_id: '222222222222222222',
      guild_id: '111111111111111111',
    }));

    await expect(connector().connector.publish({
      ...account,
      settings: {
        webhookUsername: 'Social Publisher',
        webhookAvatarUrl: 'https://cdn.example.com/avatar.png',
        threadId: '222222222222222222',
      },
    }, {
      ...post,
      media: [{ type: 'image', url: 'https://cdn.example.com/post.png', altText: 'Dashboard after deployment' }],
    })).resolves.toEqual({
      externalId: '333333333333333333',
      url: 'https://discord.com/channels/111111111111111111/222222222222222222/333333333333333333',
      status: 'PUBLISHED',
      metadata: {
        messageId: '333333333333333333',
        channelId: '222222222222222222',
      },
    });

    const [input, init] = fetchMock.mock.calls[0]!;
    const url = requestUrl(input);
    expect(url.origin + url.pathname).toBe(webhookUrl);
    expect(url.searchParams.get('wait')).toBe('true');
    expect(url.searchParams.get('thread_id')).toBe('222222222222222222');
    expect(init).toMatchObject({ method: 'POST', headers: { 'content-type': 'application/json' } });
    if (typeof init?.body !== 'string') throw new Error('Expected Discord JSON body');
    expect(JSON.parse(init.body) as unknown).toEqual({
      content: post.body,
      embeds: [{
        image: {
          url: 'https://cdn.example.com/post.png',
          description: 'Dashboard after deployment',
        },
      }],
      username: 'Social Publisher',
      avatar_url: 'https://cdn.example.com/avatar.png',
      allowed_mentions: { parse: [] },
    });
  });

  it('uploads managed images as verified multipart attachments instead of exposing an HTTP storage URL', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    const storedBytes = Buffer.from(png);
    const get = jest.fn<Promise<Buffer>, [key: string, maxBytes: number]>()
      .mockResolvedValueOnce(storedBytes);
    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValueOnce(jsonResponse({
      id: '333333333333333333',
      channel_id: '222222222222222222',
      guild_id: '111111111111111111',
    }));

    await expect(connector(get).connector.publish(account, {
      ...post,
      media: [
        managedImage(png),
        { type: 'image', url: 'https://cdn.example.com/public.webp', altText: 'Public diagram' },
      ],
    })).resolves.toMatchObject({ externalId: '333333333333333333', status: 'PUBLISHED' });

    expect(get).toHaveBeenCalledWith('media/2026-10-09/private.png', 20 * 1024 * 1024);
    expect(storedBytes.equals(Buffer.alloc(storedBytes.length))).toBe(true);
    const init = fetchMock.mock.calls[0]![1];
    expect(init?.method).toBe('POST');
    expect(init?.headers).toBeUndefined();
    expect(init?.body).toBeInstanceOf(FormData);
    const form = init!.body as FormData;
    const payloadPart = form.get('payload_json');
    expect(typeof payloadPart).toBe('string');
    const payload = JSON.parse(payloadPart as string) as Record<string, unknown>;
    expect(payload).toEqual({
      content: post.body,
      embeds: [
        {
          image: {
            url: 'attachment://image-1.png',
            description: 'Dashboard after deployment',
          },
        },
        {
          image: {
            url: 'https://cdn.example.com/public.webp',
            description: 'Public diagram',
          },
        },
      ],
      attachments: [{
        id: 0,
        filename: 'image-1.png',
        description: 'Dashboard after deployment',
      }],
      allowed_mentions: { parse: [] },
    });
    const file = form.get('files[0]');
    expect(file).toBeInstanceOf(Blob);
    expect((file as File).name).toBe('image-1.png');
    expect((file as File).type).toBe('image/png');
    expect(Buffer.from(await (file as File).arrayBuffer())).toEqual(png);
    expect(form.get('files[1]')).toBeNull();
  });

  it('rejects tampered managed image bytes before contacting Discord and clears the loaded buffer', async () => {
    const expected = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const tampered = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0b]);
    const get = jest.fn<Promise<Buffer>, [key: string, maxBytes: number]>()
      .mockResolvedValueOnce(tampered);
    const fetchMock = jest.spyOn(global, 'fetch');

    await expect(connector(get).connector.publish(account, {
      ...post,
      media: [managedImage(expected)],
    })).rejects.toMatchObject({ code: ErrorCode.PLATFORM_MEDIA_INVALID, retryable: false });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(tampered.equals(Buffer.alloc(tampered.length))).toBe(true);
  });

  it('maps managed storage read failures without exposing a storage key or webhook secret', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const get = jest.fn<Promise<Buffer>, [key: string, maxBytes: number]>()
      .mockRejectedValueOnce(new Error('s3://secret-bucket/private-key'));
    const fetchMock = jest.spyOn(global, 'fetch');

    await expect(connector(get).connector.publish(account, {
      ...post,
      media: [managedImage(png)],
    })).rejects.toMatchObject({
      code: ErrorCode.PLATFORM_API_ERROR,
      message: 'Stored Discord image could not be loaded',
      retryable: true,
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('creates a forum thread from the post title and retains its ID for deletion', async () => {
    const fetchMock = jest.spyOn(global, 'fetch')
      .mockResolvedValueOnce(jsonResponse({
        id: '333333333333333333',
        channel_id: '444444444444444444',
        guild_id: '111111111111111111',
      }))
      .mockResolvedValueOnce(jsonResponse(undefined, 204));
    const forumAccount = { ...account, settings: { createForumThread: true } };
    const result = await connector().connector.publish(forumAccount, post);

    expect(result.externalId).toBe('333333333333333333@444444444444444444');
    const publishInit = fetchMock.mock.calls[0]![1];
    if (typeof publishInit?.body !== 'string') throw new Error('Expected Discord JSON body');
    expect(JSON.parse(publishInit.body) as unknown).toMatchObject({
      thread_name: 'Deploying the API safely',
    });

    await connector().connector.delete(forumAccount, result.externalId);
    const deleteUrl = requestUrl(fetchMock.mock.calls[1]![0]);
    expect(deleteUrl.pathname).toBe('/api/webhooks/123456789012345678/secret-webhook-token/messages/333333333333333333');
    expect(deleteUrl.searchParams.get('thread_id')).toBe('444444444444444444');
    expect(fetchMock.mock.calls[1]![1]).toMatchObject({ method: 'DELETE' });
  });

  it('verifies that the credential resolves to an Incoming Webhook', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValueOnce(jsonResponse({
      id: '123456789012345678',
      type: 1,
      name: 'Release updates',
      channel_id: '222222222222222222',
      guild_id: '111111111111111111',
    }));

    await expect(connector().connector.testConnection(account)).resolves.toEqual({
      ok: true,
      accountName: 'Release updates',
      details: {
        externalId: '123456789012345678',
        channelId: '222222222222222222',
        guildId: '111111111111111111',
        threadId: undefined,
        createForumThread: false,
      },
    });
  });

  it.each([
    ['non-Discord host', { ...account, credentials: { webhookUrl: 'https://example.com/api/webhooks/123/token' } }, post, ErrorCode.PLATFORM_AUTH_FAILED],
    ['malformed Discord path', { ...account, credentials: { webhookUrl: 'https://discord.com/api/webhooks/not-an-id/token' } }, post, ErrorCode.PLATFORM_AUTH_FAILED],
    ['non-HTTPS image', account, { ...post, media: [{ type: 'image' as const, url: 'http://cdn.example.com/post.png' }] }, ErrorCode.PLATFORM_MEDIA_INVALID],
    ['unsupported managed MIME type', account, { ...post, media: [managedImage(Buffer.from('not used'), { mimeType: 'image/svg+xml' })] }, ErrorCode.PLATFORM_MEDIA_INVALID],
    ['too many images', account, { ...post, media: Array.from({ length: 11 }, (_, index) => ({ type: 'image' as const, url: `https://cdn.example.com/${index}.png` })) }, ErrorCode.PLATFORM_MEDIA_INVALID],
    ['conflicting thread settings', { ...account, settings: { threadId: '123', createForumThread: true } }, post, ErrorCode.PLATFORM_AUTH_FAILED],
  ])('rejects %s before calling Discord', async (_label, targetAccount, targetPost, code) => {
    const fetchMock = jest.spyOn(global, 'fetch');
    await expect(connector().connector.publish(targetAccount, targetPost)).rejects.toMatchObject({ code, retryable: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
