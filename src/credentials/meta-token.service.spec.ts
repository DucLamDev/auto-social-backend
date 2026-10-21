import { ConfigService } from '@nestjs/config';
import { MetaTokenService } from './meta-token.service';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function requestUrl(call: unknown[]): URL {
  const value = call[0] as string | URL | Request;
  return new URL(typeof value === 'string' ? value : value instanceof URL ? value.href : value.url);
}

const config = new ConfigService({
  INSTAGRAM_APP_ID: 'ig-app',
  INSTAGRAM_APP_SECRET: 'ig-secret',
  THREADS_APP_ID: 'th-app',
  THREADS_APP_SECRET: 'th-secret',
});

describe('MetaTokenService', () => {
  afterEach(() => jest.restoreAllMocks());

  it('exchanges an Instagram code (data-wrapped response) for a 60-day token', async () => {
    const fetchMock = jest.spyOn(global, 'fetch')
      .mockResolvedValueOnce(jsonResponse({ data: [{ access_token: 'short', user_id: '42', permissions: 'instagram_business_basic' }] }))
      .mockResolvedValueOnce(jsonResponse({ access_token: 'long', token_type: 'bearer', expires_in: 5_184_000 }));
    const before = Date.now();

    const token = await new MetaTokenService(config).exchangeCode('instagram', 'abc#_', 'https://api.example.com/cb');

    expect(token.accessToken).toBe('long');
    expect(token.expiresAt!.getTime()).toBeGreaterThanOrEqual(before + 5_184_000_000);
    const [exchangeUrl, exchangeInit] = fetchMock.mock.calls[0]!;
    expect(requestUrl([exchangeUrl]).href).toBe('https://api.instagram.com/oauth/access_token');
    const form = exchangeInit!.body as URLSearchParams;
    expect(form.get('code')).toBe('abc');
    expect(form.get('client_id')).toBe('ig-app');
    expect(form.get('grant_type')).toBe('authorization_code');
    const longLived = requestUrl(fetchMock.mock.calls[1]!);
    expect(longLived.origin + longLived.pathname).toBe('https://graph.instagram.com/access_token');
    expect(longLived.searchParams.get('grant_type')).toBe('ig_exchange_token');
    expect(longLived.searchParams.get('access_token')).toBe('short');
  });

  it('refreshes a Threads token with th_refresh_token', async () => {
    const fetchMock = jest.spyOn(global, 'fetch')
      .mockResolvedValueOnce(jsonResponse({ access_token: 'renewed', token_type: 'bearer', expires_in: 5_183_944 }));

    await expect(new MetaTokenService(config).refresh('threads', 'old')).resolves.toMatchObject({ accessToken: 'renewed' });
    const url = requestUrl(fetchMock.mock.calls[0]!);
    expect(url.origin + url.pathname).toBe('https://graph.threads.com/refresh_access_token');
    expect(url.searchParams.get('grant_type')).toBe('th_refresh_token');
  });

  it('rejects a refused refresh without exposing the response body', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValueOnce(jsonResponse({ error: { message: 'secret detail' } }, 400));
    await expect(new MetaTokenService(config).refresh('instagram', 'old')).rejects.toThrow('instagram token refresh failed');
  });

  it('uses the Instagram professional account user_id rather than the app-scoped id', async () => {
    const fetchMock = jest.spyOn(global, 'fetch')
      .mockResolvedValueOnce(jsonResponse({ data: [{ id: 'app-scoped', user_id: '178414', username: 'brand' }] }));

    await expect(new MetaTokenService(config).profile('instagram', 'token')).resolves.toEqual({ userId: '178414', username: 'brand' });
    const url = requestUrl(fetchMock.mock.calls[0]!);
    expect(url.pathname).toBe('/v24.0/me');
    expect(url.searchParams.get('fields')).toBe('user_id,username');
  });

  it('reports configuration per provider and uses version overrides', () => {
    const partial = new MetaTokenService(new ConfigService({ THREADS_APP_ID: 'a', THREADS_APP_SECRET: 'b', THREADS_API_VERSION: 'v1.1' }));
    expect(partial.isConfigured('threads')).toBe(true);
    expect(partial.isConfigured('instagram')).toBe(false);
    expect(partial.apiVersion('threads')).toBe('v1.1');
    expect(() => partial.appId('instagram')).toThrow('INSTAGRAM_APP_ID is not configured');
  });
});
