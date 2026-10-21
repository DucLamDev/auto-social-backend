import { ErrorCode } from '../../common/exceptions/application.exception';
import { ConnectorAccount, PostPayload } from '../core/connector.types';
import { BlueskyConnector } from './bluesky.connector';

const post: PostPayload = { body: 'Xin chào Bluesky', idempotencyKey: 'job-1' };

function account(credentials: Record<string, unknown>): ConnectorAccount {
  return { id: 'a', settings: {}, credentials: { serviceUrl: 'https://bsky.social', ...credentials } };
}

describe('BlueskyConnector', () => {
  let connector: BlueskyConnector;
  let request: jest.SpyInstance;

  beforeEach(() => {
    connector = new BlueskyConnector();
    // Bypass DNS pinning in unit tests; the guarded client has its own tests.
    request = jest.spyOn(connector as unknown as { requestDynamic: () => Promise<unknown> }, 'requestDynamic');
  });

  afterEach(() => jest.restoreAllMocks());

  it('creates a session from handle + App Password before posting', async () => {
    request
      .mockResolvedValueOnce({ data: { accessJwt: 'jwt', did: 'did:plc:abc', handle: 'vpsttt.bsky.social' } })
      .mockResolvedValueOnce({ data: { uri: 'at://did:plc:abc/app.bsky.feed.post/3k', cid: 'cid' } });
    await expect(connector.publish(account({ identifier: '@vpsttt.bsky.social', appPassword: 'abcd-efgh-ijkl-mnop' }), post)).resolves.toMatchObject({
      externalId: 'at://did:plc:abc/app.bsky.feed.post/3k',
      url: 'https://bsky.app/profile/did%3Aplc%3Aabc/post/3k',
      status: 'PUBLISHED',
    });
    const [sessionUrl, sessionInit] = request.mock.calls[0] as [string, RequestInit];
    expect(sessionUrl).toBe('https://bsky.social/xrpc/com.atproto.server.createSession');
    expect(JSON.parse(sessionInit.body as string)).toEqual({ identifier: 'vpsttt.bsky.social', password: 'abcd-efgh-ijkl-mnop' }); // vpsttt-secretscan: ignore (App Password giả cho test)
    const [, postInit] = request.mock.calls[1] as [string, RequestInit];
    expect(new Headers(postInit.headers).get('authorization')).toBe('Bearer jwt');
  });

  it('keeps supporting a pasted access JWT', async () => {
    request.mockResolvedValueOnce({ data: { did: 'did:plc:abc', handle: 'h' } });
    await expect(connector.testConnection(account({ accessJwt: 'jwt', did: 'did:plc:abc' }))).resolves.toMatchObject({ ok: true });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('requires the handle when an App Password is given', async () => {
    await expect(connector.publish(account({ appPassword: 'x' }), post)).rejects.toMatchObject({ code: ErrorCode.PLATFORM_AUTH_FAILED });
  });
});
