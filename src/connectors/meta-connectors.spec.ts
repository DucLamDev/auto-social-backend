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
      .mockResolvedValueOnce(jsonResponse({ status_code: 'FINISHED', id: 'container-1' }))
      .mockResolvedValueOnce(jsonResponse({ id: 'post-1' }))
      .mockResolvedValueOnce(jsonResponse({ id: 'post-1', permalink: 'https://instagram.com/p/post-1' }));

    await expect(connector.publish(account('v24.0'), post)).resolves.toEqual({
      externalId: 'post-1',
      url: 'https://instagram.com/p/post-1',
      status: 'PUBLISHED',
      metadata: { containerId: 'container-1' },
    });
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fetchUrl(fetchMock.mock.calls[0]![0])).toContain('/user-1/media');
    expect(fetchUrl(fetchMock.mock.calls[1]![0])).toContain('/container-1?fields=status_code');
    expect(fetchUrl(fetchMock.mock.calls[2]![0])).toContain('/user-1/media_publish');
    expect(fetchUrl(fetchMock.mock.calls[3]![0])).toContain('/post-1?fields=id,permalink');
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
      .mockResolvedValueOnce(jsonResponse({ status: 'FINISHED', id: 'container-1' }))
      .mockResolvedValueOnce(jsonResponse({ id: 'thread-1' }))
      .mockResolvedValueOnce(jsonResponse({ id: 'thread-1', permalink: 'https://threads.net/@user/post/thread-1' }));

    await expect(connector.publish(account('v1.0'), post)).resolves.toMatchObject({
      externalId: 'thread-1',
      status: 'PUBLISHED',
    });
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fetchUrl(fetchMock.mock.calls[0]![0])).toMatch(/^https:\/\/graph\.threads\.com\/v1\.0\/user-1\/threads/);
    expect(fetchUrl(fetchMock.mock.calls[1]![0])).toContain('/container-1?fields=status');
    expect(fetchUrl(fetchMock.mock.calls[2]![0])).toContain('/user-1/threads_publish');
  });

  it('waits for a Threads container that is still processing before publishing', async () => {
    const connector = new ThreadsConnector();
    (connector as unknown as { containerPoll: { intervalMs: number; maxPolls: number } }).containerPoll = { intervalMs: 0, maxPolls: 3 };
    const fetchMock = jest.spyOn(global, 'fetch')
      .mockResolvedValueOnce(jsonResponse({ id: 'container-1' }))
      .mockResolvedValueOnce(jsonResponse({ status: 'IN_PROGRESS' }))
      .mockResolvedValueOnce(jsonResponse({ status: 'FINISHED' }))
      .mockResolvedValueOnce(jsonResponse({ id: 'thread-1' }))
      .mockResolvedValueOnce(jsonResponse({ id: 'thread-1' }));
    await expect(connector.publish(account('v1.0'), post)).resolves.toMatchObject({ externalId: 'thread-1' });
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it('does not publish a container Meta failed to process, and retries one that never finishes', async () => {
    const failed = new InstagramConnector();
    jest.spyOn(global, 'fetch')
      .mockResolvedValueOnce(jsonResponse({ id: 'container-1' }))
      .mockResolvedValueOnce(jsonResponse({ status_code: 'ERROR' }));
    await expect(failed.publish(account('v24.0'), post)).rejects.toMatchObject({ code: ErrorCode.PLATFORM_MEDIA_INVALID, retryable: false });

    jest.restoreAllMocks();
    const slow = new InstagramConnector();
    (slow as unknown as { containerPoll: { intervalMs: number; maxPolls: number } }).containerPoll = { intervalMs: 0, maxPolls: 2 };
    const fetchMock = jest.spyOn(global, 'fetch')
      .mockResolvedValueOnce(jsonResponse({ id: 'container-1' }))
      .mockImplementation(() => Promise.resolve(jsonResponse({ status_code: 'IN_PROGRESS' })));
    await expect(slow.publish(account('v24.0'), post)).rejects.toMatchObject({ code: ErrorCode.PUBLISH_TIMEOUT, retryable: true });
    expect(fetchUrl(fetchMock.mock.calls.at(-1)![0])).not.toContain('media_publish');
  });

  it('maps Threads 401 to a non-retryable expired-token error', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValueOnce(jsonResponse({ error: { message: 'expired' } }, 401));
    await expect(new ThreadsConnector().publish(account('v1.0'), post)).rejects.toMatchObject({
      code: ErrorCode.PLATFORM_TOKEN_EXPIRED,
      retryable: false,
    });
  });

  it('reports a published post as PUBLISHED even when the permalink lookup fails', async () => {
    jest.spyOn(global, 'fetch')
      .mockResolvedValueOnce(jsonResponse({ id: 'container-1' }))
      .mockResolvedValueOnce(jsonResponse({ status: 'FINISHED' }))
      .mockResolvedValueOnce(jsonResponse({ id: 'thread-1' }))
      .mockResolvedValueOnce(jsonResponse({ error: { message: 'temporary' } }, 500));
    await expect(new ThreadsConnector().publish(account('v1.0'), post)).resolves.toEqual({
      externalId: 'thread-1',
      url: undefined,
      status: 'PUBLISHED',
      metadata: { containerId: 'container-1' },
    });

    jest.restoreAllMocks();
    jest.spyOn(global, 'fetch')
      .mockResolvedValueOnce(jsonResponse({ id: 'container-2' }))
      .mockResolvedValueOnce(jsonResponse({ status_code: 'FINISHED' }))
      .mockResolvedValueOnce(jsonResponse({ id: 'post-2' }))
      .mockRejectedValueOnce(new TypeError('fetch failed'));
    await expect(new InstagramConnector().publish(account('v24.0'), post)).resolves.toMatchObject({ externalId: 'post-2', status: 'PUBLISHED' });
  });
});
