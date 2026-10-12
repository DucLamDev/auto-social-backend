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
    const request = guardedResponse({ id: 20, url: 'https://dev.to/dashboard' });
    const account: ConnectorAccount = {
      id: 'account-1',
      settings: { publishImmediately: false },
      credentials: { apiKey: 'secret' },
    };
    const articleWithImage: PostPayload = {
      ...article,
      summary: '  A concise SEO preview for the article.  ',
      media: [{ type: 'image', url: 'https://cdn.example.com/main.png', altText: 'Main diagram' }],
    };
    await expect(new DevToConnector().publish(account, articleWithImage)).resolves.toMatchObject({
      status: 'NEEDS_ACTION',
      metadata: { externalPostId: '20', draft: true },
    });

    const [, init] = request.mock.calls[0]!;
    if (typeof init.body !== 'string') throw new Error('Expected a JSON string request body');
    expect(JSON.parse(init.body) as unknown).toMatchObject({
      article: {
        published: false,
        description: 'A concise SEO preview for the article.',
        main_image: 'https://cdn.example.com/main.png',
      },
    });
  });

  it('rejects more than one DEV article image', () => {
    const connector = new DevToConnector();
    expect(connector.capability).toMatchObject({ image: true, maxImages: 1 });
    expect(() => connector.validate({
      ...article,
      media: [
        { type: 'image', url: 'https://cdn.example.com/first.png' },
        { type: 'image', url: 'https://cdn.example.com/second.png' },
      ],
    })).toThrow('DEV articles accept at most one main image');
  });

  it('rejects DEV YAML front matter so it cannot override the draft setting', () => {
    expect(() => new DevToConnector().validate({
      ...article,
      body: '---\npublished: true\n---\n# Unsafe override',
    })).toThrow('DEV Markdown body must not contain YAML front matter');
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
