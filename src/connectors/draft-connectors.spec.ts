import { BloggerConnector } from './blogger/blogger.connector';
import { ConnectorOutboundHttpClient } from './core/connector-outbound-http.client';
import { ConnectorAccount, PostPayload } from './core/connector.types';
import { DevToConnector } from './devto/devto.connector';
import { WordPressConnector } from './wordpress/wordpress.connector';

const article: PostPayload = {
  title: 'Draft article',
  body: 'Long-form content',
  idempotencyKey: 'job-1',
};

function response(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
}

function guardedResponse(body: unknown) {
  return jest.spyOn(ConnectorOutboundHttpClient.prototype, 'request').mockResolvedValue({
    ok: true,
    status: 200,
    headers: new Headers({ 'content-type': 'application/json' }),
    text: JSON.stringify(body),
  });
}

describe('Draft connector semantics', () => {
  afterEach(() => jest.restoreAllMocks());

  it('returns NEEDS_ACTION for a WordPress draft instead of claiming it is published', async () => {
    guardedResponse({ id: 10, status: 'draft', link: 'https://blog.example.com/?p=10' });
    const account: ConnectorAccount = {
      id: 'account-1',
      settings: { publishStatus: 'draft' },
      credentials: { siteUrl: 'https://blog.example.com', username: 'editor', applicationPassword: 'secret' },
    };
    await expect(new WordPressConnector().publish(account, article)).resolves.toMatchObject({
      status: 'NEEDS_ACTION',
      metadata: { externalPostId: '10' },
    });
  });

  it('returns NEEDS_ACTION for a dev.to unpublished article', async () => {
    guardedResponse({ id: 20, url: 'https://dev.to/dashboard' });
    const account: ConnectorAccount = {
      id: 'account-1',
      settings: { publishImmediately: false },
      credentials: { apiKey: 'secret' },
    };
    await expect(new DevToConnector().publish(account, article)).resolves.toMatchObject({
      status: 'NEEDS_ACTION',
      metadata: { externalPostId: '20', draft: true },
    });
  });

  it('returns NEEDS_ACTION for a Blogger draft', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(response({ id: '30', url: 'https://blogger.example.com/draft/30' }));
    const account: ConnectorAccount = {
      id: 'account-1',
      externalId: 'blog-1',
      settings: { publishImmediately: false },
      credentials: { accessToken: 'token' },
    };
    await expect(new BloggerConnector().publish(account, article)).resolves.toMatchObject({
      status: 'NEEDS_ACTION',
      metadata: { externalPostId: '30', draft: true },
    });
  });
});
