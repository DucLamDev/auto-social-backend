import { ErrorCode } from '../common/exceptions/application.exception';
import { ConnectorAccount, PostPayload } from './core/connector.types';
import { InstagramConnector } from './instagram/instagram.connector';
import { ThreadsConnector } from './threads/threads.connector';

const post: PostPayload = {
  body: 'A useful update',
  hashtags: ['nestjs'],
  media: [{ type: 'image', url: 'https://media.example.com/image.jpg' }],
  idempotencyKey: 'job-1',
};

function account(apiVersion: string): ConnectorAccount {
  return {
    id: 'account-1',
    externalId: 'user-1',
    settings: { apiVersion },
    credentials: { accessToken: 'token' },
  };
}

function jsonResponse(body: unknown, status = 200, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function fetchUrl(value: string | URL | Request): string {
  if (typeof value === 'string') return value;
  return value instanceof URL ? value.href : value.url;
}

describe('Meta connector HTTP contracts', () => {
  afterEach(() => jest.restoreAllMocks());

  it('validates Instagram single-image scope and performs create, publish, detail requests', async () => {
    const connector = new InstagramConnector();
    expect(() => connector.validate({ ...post, media: [] })).toThrow('requires image');
    const fetchMock = jest.spyOn(global, 'fetch')
      .mockResolvedValueOnce(jsonResponse({ id: 'container-1' }))
      .mockResolvedValueOnce(jsonResponse({ id: 'post-1' }))
      .mockResolvedValueOnce(jsonResponse({ id: 'post-1', permalink: 'https://instagram.com/p/post-1' }));

    await expect(connector.publish(account('v24.0'), post)).resolves.toEqual({
      externalId: 'post-1',
      url: 'https://instagram.com/p/post-1',
      status: 'PUBLISHED',
      metadata: { containerId: 'container-1' },
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchUrl(fetchMock.mock.calls[0]![0])).toContain('/user-1/media');
    expect(fetchUrl(fetchMock.mock.calls[1]![0])).toContain('/user-1/media_publish');
    expect(fetchUrl(fetchMock.mock.calls[2]![0])).toContain('/post-1?fields=id,permalink');
  });

  it('maps Instagram 429 to a retryable rate-limit error', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValueOnce(jsonResponse(
      { error: { message: 'details must remain private' } },
      429,
      { 'retry-after': '42' },
    ));
    await expect(new InstagramConnector().publish(account('v24.0'), post)).rejects.toMatchObject({
      code: ErrorCode.PLATFORM_RATE_LIMITED,
      retryable: true,
      retryAfterSeconds: 42,
    });
  });

  it('validates Threads text and performs create, publish, detail requests', async () => {
    const connector = new ThreadsConnector();
    expect(() => connector.validate({ ...post, body: '' })).toThrow('Threads text is required');
    const fetchMock = jest.spyOn(global, 'fetch')
      .mockResolvedValueOnce(jsonResponse({ id: 'container-1' }))
      .mockResolvedValueOnce(jsonResponse({ id: 'thread-1' }))
      .mockResolvedValueOnce(jsonResponse({ id: 'thread-1', permalink: 'https://threads.net/@user/post/thread-1' }));

    await expect(connector.publish(account('v1.0'), post)).resolves.toMatchObject({
      externalId: 'thread-1',
      status: 'PUBLISHED',
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchUrl(fetchMock.mock.calls[0]![0])).toContain('/user-1/threads');
    expect(fetchUrl(fetchMock.mock.calls[1]![0])).toContain('/user-1/threads_publish');
  });

  it('maps Threads 401 to a non-retryable expired-token error', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValueOnce(jsonResponse({ error: { message: 'expired' } }, 401));
    await expect(new ThreadsConnector().publish(account('v1.0'), post)).rejects.toMatchObject({
      code: ErrorCode.PLATFORM_TOKEN_EXPIRED,
      retryable: false,
    });
  });
});
