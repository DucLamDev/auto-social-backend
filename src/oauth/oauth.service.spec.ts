import { ConfigService } from '@nestjs/config';
import { AccountStatus } from '@prisma/client';
import { CredentialsService } from '../credentials/credentials.service';
import { MetaTokenService } from '../credentials/meta-token.service';
import { PrismaService } from '../database/prisma.service';
import { OAuthStateService } from './oauth-state.service';
import { OAuthService } from './oauth.service';

const config = new ConfigService({
  OAUTH_REDIRECT_BASE_URL: 'https://api.example.com/api/v1/oauth',
  THREADS_APP_ID: 'th-app',
  THREADS_APP_SECRET: 'th-secret',
  INSTAGRAM_APP_ID: 'ig-app',
  INSTAGRAM_APP_SECRET: 'ig-secret',
});

function setup(existingOwner?: string) {
  const states = {
    create: jest.fn().mockResolvedValue({ state: 'state-1' }),
    consume: jest.fn().mockResolvedValue({ userId: 'user-1', redirectUri: 'https://api.example.com/api/v1/oauth/threads/callback' }),
  };
  const upsert = jest.fn<Promise<{ id: string }>, [Record<string, unknown>]>().mockResolvedValue({ id: 'account-1' });
  const deleteMany = jest.fn().mockResolvedValue({ count: 1 });
  const prisma = {
    platform: { findUniqueOrThrow: jest.fn().mockResolvedValue({ id: 'platform-threads', name: 'Threads' }) },
    platformAccount: {
      findUnique: jest.fn().mockResolvedValue(existingOwner ? { ownerId: existingOwner, settings: { rateLimit: 5 } } : null),
      upsert,
    },
    platformCredential: { deleteMany },
  };
  const credentials = { upsertOAuthTokens: jest.fn().mockResolvedValue(undefined) };
  const meta = new MetaTokenService(config);
  const expiresAt = new Date('2026-12-20T00:00:00Z');
  jest.spyOn(meta, 'exchangeCode').mockResolvedValue({ accessToken: 'long-token', expiresAt, tokenType: 'bearer' });
  jest.spyOn(meta, 'profile').mockResolvedValue({ userId: '9001', username: 'vpsttt' });
  const service = new OAuthService(
    config,
    states as unknown as OAuthStateService,
    prisma as unknown as PrismaService,
    credentials as unknown as CredentialsService,
    meta,
  );
  return { service, states, upsert, deleteMany, credentials, expiresAt };
}

describe('OAuthService Meta providers', () => {
  it('builds the Threads consent URL with comma-separated scopes', async () => {
    const { service, states } = setup();
    const { authorizationUrl } = await service.start('user-1', 'threads');
    const url = new URL(authorizationUrl);
    expect(url.origin + url.pathname).toBe('https://threads.com/oauth/authorize');
    expect(url.searchParams.get('client_id')).toBe('th-app');
    expect(url.searchParams.get('scope')).toBe('threads_basic,threads_content_publish');
    expect(url.searchParams.get('redirect_uri')).toBe('https://api.example.com/api/v1/oauth/threads/callback');
    expect(states.create).toHaveBeenCalledWith('user-1', 'threads', 'https://api.example.com/api/v1/oauth/threads/callback');
  });

  it('links the profile, replaces any pasted credential and stores the long-lived token', async () => {
    const { service, upsert, deleteMany, credentials, expiresAt } = setup('user-1');
    await expect(service.callback('threads', 'state-1', 'code')).resolves.toEqual({ provider: 'threads', accountIds: ['account-1'] });
    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { platformId_externalId: { platformId: 'platform-threads', externalId: '9001' } },
    }));
    expect(upsert.mock.calls[0]?.[0]).toMatchObject({
      update: { name: '@vpsttt', status: AccountStatus.CONNECTED, settings: { rateLimit: 5, apiVersion: 'v1.0' } },
    });
    expect(deleteMany).toHaveBeenCalledWith({ where: { platformAccountId: 'account-1' } });
    expect(credentials.upsertOAuthTokens).toHaveBeenCalledWith(expect.objectContaining({
      platformAccountId: 'account-1',
      accessToken: 'long-token',
      expiresAt,
      scopes: ['threads_basic', 'threads_content_publish'],
    }));
  });

  it('refuses to take over a profile linked by another user', async () => {
    const { service, upsert } = setup('someone-else');
    await expect(service.callback('threads', 'state-1', 'code')).rejects.toThrow('already linked to another user');
    expect(upsert).not.toHaveBeenCalled();
  });
});

describe('OAuthService Tumblr', () => {
  afterEach(() => jest.restoreAllMocks());

  it('links every blog of the login with its rotating refresh token', async () => {
    const tumblrConfig = new ConfigService({ OAUTH_REDIRECT_BASE_URL: 'https://api.example.com/api/v1/oauth', TUMBLR_CLIENT_ID: 'tk', TUMBLR_CLIENT_SECRET: 'ts' });
    const upsert = jest.fn<Promise<{ id: string }>, [Record<string, unknown>]>().mockResolvedValueOnce({ id: 'acc-1' }).mockResolvedValueOnce({ id: 'acc-2' });
    const prisma = {
      platform: { findUniqueOrThrow: jest.fn().mockResolvedValue({ id: 'p-tumblr', name: 'Tumblr', defaultSettings: { publishImmediately: true } }) },
      platformAccount: { findUnique: jest.fn().mockResolvedValue(null), upsert },
    };
    const credentials = { upsertOAuthTokens: jest.fn().mockResolvedValue(undefined) };
    const states = { consume: jest.fn().mockResolvedValue({ userId: 'user-1', redirectUri: 'https://api.example.com/api/v1/oauth/tumblr/callback' }) };
    const fetchMock = jest.spyOn(global, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'at', refresh_token: 'rt', expires_in: 2520, scope: 'write offline_access' })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ response: { user: { blogs: [
        { name: 'vpsttt', uuid: 't:1', title: 'VPSTTT', url: 'https://vpsttt.tumblr.com/' },
        { name: 'vpsttt-dev', uuid: 't:2', url: 'https://vpsttt-dev.tumblr.com/' },
      ] } } })));
    const service = new OAuthService(tumblrConfig, states as unknown as OAuthStateService, prisma as unknown as PrismaService, credentials as unknown as CredentialsService, new MetaTokenService(tumblrConfig));

    await expect(service.callback('tumblr', 'state', 'code')).resolves.toEqual({ provider: 'tumblr', accountIds: ['acc-1', 'acc-2'] });
    expect(fetchMock.mock.calls[0]![0] as string).toBe('https://api.tumblr.com/v2/oauth2/token');
    expect(upsert.mock.calls[0]?.[0]).toMatchObject({
      create: { externalId: 't:1', name: 'VPSTTT', settings: { publishImmediately: true, blogName: 'vpsttt', blogUrl: 'https://vpsttt.tumblr.com/' } },
    });
    expect(credentials.upsertOAuthTokens).toHaveBeenCalledWith(expect.objectContaining({ platformAccountId: 'acc-2', accessToken: 'at', refreshToken: 'rt' }));
  });

  it('starts Tumblr OAuth with offline_access so a refresh token is issued', async () => {
    const tumblrConfig = new ConfigService({ OAUTH_REDIRECT_BASE_URL: 'https://api.example.com/api/v1/oauth', TUMBLR_CLIENT_ID: 'tk', TUMBLR_CLIENT_SECRET: 'ts' });
    const states = { create: jest.fn().mockResolvedValue({ state: 's' }) };
    const service = new OAuthService(tumblrConfig, states as unknown as OAuthStateService, {} as PrismaService, {} as CredentialsService, new MetaTokenService(tumblrConfig));
    const url = new URL((await service.start('user-1', 'tumblr')).authorizationUrl);
    expect(url.origin + url.pathname).toBe('https://www.tumblr.com/oauth2/authorize');
    expect(url.searchParams.get('scope')).toBe('basic write offline_access');
  });
});
