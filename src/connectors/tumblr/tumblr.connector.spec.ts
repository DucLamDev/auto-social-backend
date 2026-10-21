import { ErrorCode } from '../../common/exceptions/application.exception';
import { ConnectorAccount, PostPayload } from '../core/connector.types';
import { toNpfBlocks, TumblrConnector } from './tumblr.connector';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const account: ConnectorAccount = { id: 'a', externalId: 't:uuid', settings: { blogName: 'vpsttt' }, credentials: { accessToken: 'token' } };
const post: PostPayload = { title: 'VPS mới', body: 'Đoạn một.\n\nĐoạn hai.', hashtags: ['#vps', 'hosting'], idempotencyKey: 'job-1' };

describe('TumblrConnector', () => {
  afterEach(() => jest.restoreAllMocks());

  it('splits title and paragraphs into NPF text blocks under 4096 code points', () => {
    const long = 'é'.repeat(5000);
    expect(toNpfBlocks('Tiêu đề', `A\n\n${long}`)).toEqual([
      { type: 'text', subtype: 'heading1', text: 'Tiêu đề' },
      { type: 'text', text: 'A' },
      { type: 'text', text: 'é'.repeat(4096) },
      { type: 'text', text: 'é'.repeat(904) },
    ]);
  });

  it('publishes an NPF post with comma-separated tags and reads its URL', async () => {
    const fetchMock = jest.spyOn(global, 'fetch')
      .mockResolvedValueOnce(jsonResponse({ meta: { status: 201 }, response: { id: '7350' } }, 201))
      .mockResolvedValueOnce(jsonResponse({ response: { posts: [{ post_url: 'https://vpsttt.tumblr.com/post/7350' }] } }));
    await expect(new TumblrConnector().publish(account, post)).resolves.toEqual({
      externalId: '7350', url: 'https://vpsttt.tumblr.com/post/7350', status: 'PUBLISHED',
    });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url as string).toBe('https://api.tumblr.com/v2/blog/t%3Auuid/posts');
    const headers = new Headers(init!.headers);
    expect(headers.get('authorization')).toBe('Bearer token');
    expect(headers.get('user-agent')).toContain('SocialPublisher');
    expect(JSON.parse(init!.body as string)).toEqual({
      content: [
        { type: 'text', subtype: 'heading1', text: 'VPS mới' },
        { type: 'text', text: 'Đoạn một.' },
        { type: 'text', text: 'Đoạn hai.' },
      ],
      tags: 'vps,hosting',
      state: 'published',
    });
  });

  it('saves a draft when immediate publishing is off', async () => {
    const fetchMock = jest.spyOn(global, 'fetch')
      .mockResolvedValueOnce(jsonResponse({ response: { id: 9 } }, 201))
      .mockRejectedValueOnce(new TypeError('fetch failed'));
    await expect(new TumblrConnector().publish({ ...account, settings: { publishImmediately: false } }, post)).resolves.toMatchObject({
      externalId: '9', status: 'NEEDS_ACTION', metadata: { draft: true },
    });
    expect(JSON.parse(fetchMock.mock.calls[0]![1]!.body as string)).toMatchObject({ state: 'draft' });
  });

  it('asks for reconciliation instead of retrying when the create call times out', async () => {
    jest.spyOn(global, 'fetch').mockRejectedValueOnce(Object.assign(new Error('slow'), { name: 'TimeoutError' }));
    await expect(new TumblrConnector().publish(account, post)).resolves.toMatchObject({
      status: 'NEEDS_ACTION',
      metadata: { reconciliationRequired: true, submissionUncertain: true, originalErrorCode: ErrorCode.PUBLISH_TIMEOUT },
    });
  });

  it('fails the connection test when the login lost access to the blog', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValueOnce(jsonResponse({ response: { user: { blogs: [{ name: 'other', uuid: 't:other' }] } } }));
    await expect(new TumblrConnector().testConnection(account)).rejects.toMatchObject({ code: ErrorCode.PLATFORM_PERMISSION_DENIED });
  });
});
