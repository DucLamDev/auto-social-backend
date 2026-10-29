import { HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AccountStatus } from '@prisma/client';
import { ApplicationException, ErrorCode } from '../common/exceptions/application.exception';
import { CredentialsService } from '../credentials/credentials.service';
import { isMetaProvider, MetaProvider, MetaTokenService } from '../credentials/meta-token.service';
import { PrismaService } from '../database/prisma.service';
import { OAuthStateService } from './oauth-state.service';

interface ProviderDefinition {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  clientIdEnv: string;
  clientSecretEnv: string;
  scopes: string[];
  extraAuthorization?: Record<string, string>;
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
}

type ValidToken = Required<Pick<TokenResponse, 'access_token'>> & TokenResponse;

const PROVIDERS: Record<string, ProviderDefinition> = {
  linkedin: {
    authorizationEndpoint: 'https://www.linkedin.com/oauth/v2/authorization',
    tokenEndpoint: 'https://www.linkedin.com/oauth/v2/accessToken',
    clientIdEnv: 'LINKEDIN_CLIENT_ID',
    clientSecretEnv: 'LINKEDIN_CLIENT_SECRET',
    scopes: ['openid', 'profile', 'w_member_social'],
  },
  google: {
    authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenEndpoint: 'https://oauth2.googleapis.com/token',
    clientIdEnv: 'GOOGLE_CLIENT_ID',
    clientSecretEnv: 'GOOGLE_CLIENT_SECRET',
    scopes: ['openid', 'profile', 'https://www.googleapis.com/auth/blogger'],
    extraAuthorization: { access_type: 'offline', prompt: 'consent' },
  },
  tumblr: {
    authorizationEndpoint: 'https://www.tumblr.com/oauth2/authorize',
    tokenEndpoint: 'https://api.tumblr.com/v2/oauth2/token',
    clientIdEnv: 'TUMBLR_CLIENT_ID',
    clientSecretEnv: 'TUMBLR_CLIENT_SECRET',
    // offline_access is what makes Tumblr return a refresh token.
    scopes: ['basic', 'write', 'offline_access'],
  },
};

@Injectable()
export class OAuthService {
  constructor(
    private readonly config: ConfigService,
    private readonly states: OAuthStateService,
    private readonly prisma: PrismaService,
    private readonly credentials: CredentialsService,
    private readonly meta: MetaTokenService,
  ) {}

  async start(userId: string, providerName: string) {
    if (isMetaProvider(providerName)) return this.startMeta(userId, providerName);
    const provider = this.provider(providerName);
    const clientId = this.requiredEnv(provider.clientIdEnv);
    this.requiredEnv(provider.clientSecretEnv);
    const redirectUri = this.callbackUrl(providerName);
    const state = await this.states.create(userId, providerName, redirectUri);
    const url = new URL(provider.authorizationEndpoint);
    url.search = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: redirectUri,
      state: state.state,
      scope: provider.scopes.join(' '),
      ...provider.extraAuthorization,
    }).toString();
    return { authorizationUrl: url.toString(), expiresInSeconds: 600 };
  }

  async callback(providerName: string, state: string, code: string) {
    if (isMetaProvider(providerName)) return this.callbackMeta(providerName, state, code);
    const provider = this.provider(providerName);
    const oauthState = await this.states.consume(providerName, state);
    const token = await this.exchange(provider, code, oauthState.redirectUri);
    if (providerName === 'linkedin') return this.saveLinkedIn(oauthState.userId, token);
    if (providerName === 'tumblr') return this.saveTumblr(oauthState.userId, token);
    return this.saveBlogger(oauthState.userId, token);
  }

  private async startMeta(userId: string, provider: MetaProvider) {
    const definition = this.meta.definition(provider);
    const clientId = this.meta.appId(provider);
    this.requiredEnv(definition.appSecretEnv);
    const redirectUri = this.callbackUrl(provider);
    const state = await this.states.create(userId, provider, redirectUri);
    const url = new URL(definition.authorizationEndpoint);
    url.search = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      // Meta documents comma-separated scopes for both Instagram and Threads.
      scope: definition.scopes.join(','),
      state: state.state,
    }).toString();
    return { authorizationUrl: url.toString(), expiresInSeconds: 600 };
  }

  /**
   * Stores a 60-day token for an Instagram professional or Threads profile.
   * TokenMaintenanceService refreshes it before expiry, so the user only has
   * to sign in again when Meta revokes access or the token lapses unrefreshed.
   */
  private async callbackMeta(provider: MetaProvider, state: string, code: string) {
    const oauthState = await this.states.consume(provider, state);
    const definition = this.meta.definition(provider);
    const token = await this.meta.exchangeCode(provider, code, oauthState.redirectUri);
    const profile = await this.meta.profile(provider, token.accessToken);
    const platform = await this.prisma.platform.findUniqueOrThrow({ where: { slug: definition.platformSlug } });
    const existing = await this.prisma.platformAccount.findUnique({
      where: { platformId_externalId: { platformId: platform.id, externalId: profile.userId } },
    });
    if (existing && existing.ownerId !== oauthState.userId) {
      throw new ApplicationException(ErrorCode.FORBIDDEN, `This ${platform.name} account is already linked to another user`, HttpStatus.CONFLICT);
    }
    const name = profile.username ? `@${profile.username}` : platform.name;
    const apiVersion = this.meta.apiVersion(provider);
    const account = await this.prisma.platformAccount.upsert({
      where: { platformId_externalId: { platformId: platform.id, externalId: profile.userId } },
      create: {
        ownerId: oauthState.userId,
        platformId: platform.id,
        name,
        username: profile.username,
        externalId: profile.userId,
        status: AccountStatus.CONNECTED,
        lastTestedAt: new Date(),
        settings: { apiVersion },
      },
      update: {
        name,
        username: profile.username,
        status: AccountStatus.CONNECTED,
        lastTestedAt: new Date(),
        settings: { ...this.asRecord(existing?.settings), apiVersion },
      },
    });
    // A manually pasted token would otherwise take precedence over OAuth in
    // ConnectorAccountsService; the OAuth token is now the source of truth.
    await this.prisma.platformCredential.deleteMany({ where: { platformAccountId: account.id } });
    await this.credentials.upsertOAuthTokens({
      platformAccountId: account.id,
      accessToken: token.accessToken,
      scopes: definition.scopes,
      tokenType: token.tokenType ?? 'bearer',
      expiresAt: token.expiresAt,
    });
    return { provider, accountIds: [account.id] };
  }

  private async exchange(provider: ProviderDefinition, code: string, redirectUri: string): Promise<ValidToken> {
    const response = await fetch(provider.tokenEndpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
        client_id: this.requiredEnv(provider.clientIdEnv),
        client_secret: this.requiredEnv(provider.clientSecretEnv),
      }),
      signal: AbortSignal.timeout(30_000),
    });
    const payload = (await response.json()) as TokenResponse;
    if (!response.ok || typeof payload.access_token !== 'string') {
      throw new ApplicationException(ErrorCode.PLATFORM_AUTH_FAILED, 'OAuth token exchange failed', HttpStatus.BAD_GATEWAY);
    }
    return payload as ValidToken;
  }

  private async saveLinkedIn(userId: string, token: ValidToken) {
    const response = await fetch('https://api.linkedin.com/v2/userinfo', {
      headers: { authorization: `Bearer ${token.access_token}` },
      signal: AbortSignal.timeout(30_000),
    });
    const profile = (await response.json()) as { sub?: string; name?: string };
    if (!response.ok || !profile.sub) {
      throw new ApplicationException(ErrorCode.PLATFORM_AUTH_FAILED, 'LinkedIn profile lookup failed', HttpStatus.BAD_GATEWAY);
    }
    const platform = await this.prisma.platform.findUniqueOrThrow({ where: { slug: 'linkedin' } });
    const apiVersion = this.requiredEnv('LINKEDIN_API_VERSION');
    const externalId = `urn:li:person:${profile.sub}`;
    const existing = await this.prisma.platformAccount.findUnique({
      where: { platformId_externalId: { platformId: platform.id, externalId } },
    });
    if (existing && existing.ownerId !== userId) {
      throw new ApplicationException(ErrorCode.FORBIDDEN, 'This LinkedIn account is already linked to another user', HttpStatus.CONFLICT);
    }
    const account = await this.prisma.platformAccount.upsert({
      where: { platformId_externalId: { platformId: platform.id, externalId } },
      create: { ownerId: userId, platformId: platform.id, name: profile.name ?? 'LinkedIn', externalId, status: AccountStatus.CONNECTED, settings: { apiVersion } },
      update: {
        name: profile.name ?? 'LinkedIn',
        status: AccountStatus.CONNECTED,
        settings: { ...this.asRecord(existing?.settings), apiVersion },
      },
    });
    await this.saveToken(account.id, token, ['openid', 'profile', 'w_member_social']);
    return { provider: 'linkedin', accountIds: [account.id] };
  }

  private async saveBlogger(userId: string, token: ValidToken) {
    const response = await fetch('https://www.googleapis.com/blogger/v3/users/self/blogs', {
      headers: { authorization: `Bearer ${token.access_token}` },
      signal: AbortSignal.timeout(30_000),
    });
    const payload = (await response.json()) as { items?: Array<{ id?: string; name?: string; url?: string }> };
    if (!response.ok) {
      throw new ApplicationException(ErrorCode.PLATFORM_AUTH_FAILED, 'Blogger blog lookup failed', HttpStatus.BAD_GATEWAY);
    }
    const blogs = (payload.items ?? []).filter(
      (blog): blog is { id: string; name?: string; url?: string } => typeof blog.id === 'string',
    );
    if (!blogs.length) {
      throw new ApplicationException(ErrorCode.RESOURCE_NOT_FOUND, 'No Blogger blogs are available for this Google account', HttpStatus.NOT_FOUND);
    }
    const platform = await this.prisma.platform.findUniqueOrThrow({ where: { slug: 'blogger' } });
    // New blogs start from the catalog default (draft until the operator turns on immediate publishing).
    const defaults = this.asRecord(platform.defaultSettings);
    const accountIds: string[] = [];
    for (const blog of blogs) {
      const existing = await this.prisma.platformAccount.findUnique({
        where: { platformId_externalId: { platformId: platform.id, externalId: blog.id } },
      });
      if (existing && existing.ownerId !== userId) continue;
      const account = await this.prisma.platformAccount.upsert({
        where: { platformId_externalId: { platformId: platform.id, externalId: blog.id } },
        create: { ownerId: userId, platformId: platform.id, name: blog.name ?? 'Blogger', externalId: blog.id, status: AccountStatus.CONNECTED, settings: { ...defaults, blogUrl: blog.url ?? null } },
        update: {
          name: blog.name ?? 'Blogger',
          status: AccountStatus.CONNECTED,
          settings: { ...this.asRecord(existing?.settings), blogUrl: blog.url ?? null },
        },
      });
      await this.saveToken(account.id, token, ['https://www.googleapis.com/auth/blogger']);
      accountIds.push(account.id);
    }
    return { provider: 'google', accountIds };
  }

  /** One platform account per Tumblr blog the login can post to, like Blogger. */
  private async saveTumblr(userId: string, token: ValidToken) {
    const response = await fetch('https://api.tumblr.com/v2/user/info', {
      headers: { authorization: `Bearer ${token.access_token}`, 'user-agent': 'SocialPublisher/1.1 (+https://vpsttt.com)', accept: 'application/json' },
      signal: AbortSignal.timeout(30_000),
    });
    const payload = (await response.json()) as { response?: { user?: { blogs?: Array<{ name?: string; uuid?: string; url?: string; title?: string }> } } };
    if (!response.ok) {
      throw new ApplicationException(ErrorCode.PLATFORM_AUTH_FAILED, 'Tumblr blog lookup failed', HttpStatus.BAD_GATEWAY);
    }
    const blogs = (payload.response?.user?.blogs ?? []).filter(
      (blog): blog is { name: string; uuid?: string; url?: string; title?: string } => typeof blog.name === 'string' && blog.name.length > 0,
    );
    if (!blogs.length) {
      throw new ApplicationException(ErrorCode.RESOURCE_NOT_FOUND, 'No Tumblr blogs are available for this login', HttpStatus.NOT_FOUND);
    }
    const platform = await this.prisma.platform.findUniqueOrThrow({ where: { slug: 'tumblr' } });
    const defaults = this.asRecord(platform.defaultSettings);
    const accountIds: string[] = [];
    for (const blog of blogs) {
      const externalId = blog.uuid ?? blog.name;
      const existing = await this.prisma.platformAccount.findUnique({
        where: { platformId_externalId: { platformId: platform.id, externalId } },
      });
      if (existing && existing.ownerId !== userId) continue;
      const settings = { blogName: blog.name, blogUrl: blog.url ?? null };
      const account = await this.prisma.platformAccount.upsert({
        where: { platformId_externalId: { platformId: platform.id, externalId } },
        create: { ownerId: userId, platformId: platform.id, name: blog.title || blog.name, username: blog.name, externalId, status: AccountStatus.CONNECTED, lastTestedAt: new Date(), settings: { ...defaults, ...settings } },
        update: { name: blog.title || blog.name, username: blog.name, status: AccountStatus.CONNECTED, lastTestedAt: new Date(), settings: { ...defaults, ...this.asRecord(existing?.settings), ...settings } },
      });
      await this.saveToken(account.id, token, ['basic', 'write', 'offline_access']);
      accountIds.push(account.id);
    }
    return { provider: 'tumblr', accountIds };
  }

  private saveToken(accountId: string, token: ValidToken, fallbackScopes: string[]): Promise<void> {
    return this.credentials.upsertOAuthTokens({
      platformAccountId: accountId,
      accessToken: token.access_token,
      refreshToken: token.refresh_token,
      scopes: token.scope?.split(/\s+/).filter(Boolean) ?? fallbackScopes,
      tokenType: token.token_type,
      expiresAt: token.expires_in ? new Date(Date.now() + token.expires_in * 1000) : undefined,
    });
  }

  private provider(name: string): ProviderDefinition {
    const provider = PROVIDERS[name];
    if (!provider) {
      throw new ApplicationException(
        ErrorCode.CONNECTOR_NEEDS_ACTION,
        `OAuth for '${name}' is not enabled because its current provider flow requires review/research`,
        HttpStatus.NOT_IMPLEMENTED,
        { status: 'API_RESEARCH_REQUIRED' },
      );
    }
    return provider;
  }

  private callbackUrl(provider: string): string {
    const base = this.config.get<string>('OAUTH_REDIRECT_BASE_URL', 'http://localhost:3001/api/v1/oauth');
    return `${base.replace(/\/$/, '')}/${encodeURIComponent(provider)}/callback`;
  }

  private requiredEnv(key: string): string {
    const value = this.config.get<string>(key);
    if (!value) {
      throw new ApplicationException(ErrorCode.CONNECTOR_NEEDS_ACTION, `${key} is not configured`, HttpStatus.SERVICE_UNAVAILABLE, { status: 'CREDENTIAL_REQUIRED' });
    }
    return value;
  }

  private asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {};
  }
}
