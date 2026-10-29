import { HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApplicationException, ErrorCode } from '../common/exceptions/application.exception';

export type MetaProvider = 'instagram' | 'threads';

export interface MetaProviderDefinition {
  provider: MetaProvider;
  platformSlug: string;
  appIdEnv: string;
  appSecretEnv: string;
  apiVersionEnv: string;
  defaultApiVersion: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  graphBase: string;
  exchangeGrant: string;
  refreshGrant: string;
  scopes: string[];
}

/**
 * Instagram API with Instagram Login and the Threads API use separate Meta
 * apps with separate app IDs. Both issue a 1-hour token from the code, which
 * is exchanged server-side for a 60-day token that can be refreshed once it
 * is at least 24 hours old and still valid.
 */
export const META_PROVIDERS: Record<MetaProvider, MetaProviderDefinition> = {
  instagram: {
    provider: 'instagram',
    platformSlug: 'instagram',
    appIdEnv: 'INSTAGRAM_APP_ID',
    appSecretEnv: 'INSTAGRAM_APP_SECRET',
    apiVersionEnv: 'INSTAGRAM_API_VERSION',
    defaultApiVersion: 'v24.0',
    authorizationEndpoint: 'https://www.instagram.com/oauth/authorize',
    tokenEndpoint: 'https://api.instagram.com/oauth/access_token',
    graphBase: 'https://graph.instagram.com',
    exchangeGrant: 'ig_exchange_token',
    refreshGrant: 'ig_refresh_token',
    scopes: ['instagram_business_basic', 'instagram_business_content_publish'],
  },
  threads: {
    provider: 'threads',
    platformSlug: 'threads',
    appIdEnv: 'THREADS_APP_ID',
    appSecretEnv: 'THREADS_APP_SECRET',
    apiVersionEnv: 'THREADS_API_VERSION',
    defaultApiVersion: 'v1.0',
    authorizationEndpoint: 'https://threads.com/oauth/authorize',
    tokenEndpoint: 'https://graph.threads.com/oauth/access_token',
    graphBase: 'https://graph.threads.com',
    exchangeGrant: 'th_exchange_token',
    refreshGrant: 'th_refresh_token',
    scopes: ['threads_basic', 'threads_content_publish'],
  },
};

/** Meta refuses to refresh a long-lived token younger than 24 hours. */
export const META_MIN_TOKEN_AGE_MS = 24 * 60 * 60 * 1000;

export function isMetaProvider(value: string): value is MetaProvider {
  return value === 'instagram' || value === 'threads';
}

export interface MetaLongLivedToken {
  accessToken: string;
  expiresAt?: Date;
  tokenType?: string;
}

export interface MetaProfile {
  userId: string;
  username?: string;
}

interface TokenPayload {
  access_token?: unknown;
  token_type?: unknown;
  expires_in?: unknown;
  user_id?: unknown;
  data?: unknown;
}

@Injectable()
export class MetaTokenService {
  constructor(private readonly config: ConfigService) {}

  definition(provider: MetaProvider): MetaProviderDefinition {
    return META_PROVIDERS[provider];
  }

  isConfigured(provider: MetaProvider): boolean {
    const definition = META_PROVIDERS[provider];
    return Boolean(this.config.get<string>(definition.appIdEnv)?.trim() && this.config.get<string>(definition.appSecretEnv)?.trim());
  }

  apiVersion(provider: MetaProvider): string {
    const definition = META_PROVIDERS[provider];
    return this.config.get<string>(definition.apiVersionEnv)?.trim() || definition.defaultApiVersion;
  }

  appId(provider: MetaProvider): string {
    return this.required(META_PROVIDERS[provider].appIdEnv);
  }

  /** Exchanges the authorization code and immediately upgrades it to a 60-day token. */
  async exchangeCode(provider: MetaProvider, code: string, redirectUri: string): Promise<MetaLongLivedToken> {
    const definition = META_PROVIDERS[provider];
    const response = await fetch(definition.tokenEndpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({
        client_id: this.appId(provider),
        client_secret: this.required(definition.appSecretEnv),
        grant_type: 'authorization_code',
        redirect_uri: redirectUri,
        // Meta appends "#_" to the redirect; browsers normally drop the fragment.
        code: code.replace(/#_$/, ''),
      }),
      signal: AbortSignal.timeout(30_000),
    });
    const payload = this.unwrap(await this.json(response));
    if (!response.ok || typeof payload.access_token !== 'string') {
      throw this.failure(`${provider} OAuth code exchange failed`);
    }
    const url = new URL(`${definition.graphBase}/access_token`);
    url.search = new URLSearchParams({
      grant_type: definition.exchangeGrant,
      client_secret: this.required(definition.appSecretEnv),
      access_token: payload.access_token,
    }).toString();
    return this.longLived(provider, await fetch(url, { signal: AbortSignal.timeout(30_000) }), 'long-lived token exchange');
  }

  async refresh(provider: MetaProvider, accessToken: string): Promise<MetaLongLivedToken> {
    const definition = META_PROVIDERS[provider];
    const url = new URL(`${definition.graphBase}/refresh_access_token`);
    url.search = new URLSearchParams({ grant_type: definition.refreshGrant, access_token: accessToken }).toString();
    return this.longLived(provider, await fetch(url, { signal: AbortSignal.timeout(30_000) }), 'token refresh');
  }

  /**
   * Instagram publishes with the professional account ID (`user_id`), not the
   * app-scoped `id`; Threads only exposes `id`.
   */
  async profile(provider: MetaProvider, accessToken: string): Promise<MetaProfile> {
    const definition = META_PROVIDERS[provider];
    const fields = provider === 'instagram' ? 'user_id,username' : 'id,username';
    const url = new URL(`${definition.graphBase}/${this.apiVersion(provider)}/me`);
    url.search = new URLSearchParams({ fields, access_token: accessToken }).toString();
    const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    const payload = this.unwrap(await this.json(response)) as TokenPayload & { id?: unknown; username?: unknown };
    const rawId = provider === 'instagram' ? payload.user_id ?? payload.id : payload.id;
    const userId = typeof rawId === 'number' ? String(rawId) : rawId;
    if (!response.ok || typeof userId !== 'string' || !userId) {
      throw this.failure(`${provider} profile lookup failed`);
    }
    return { userId, username: typeof payload.username === 'string' ? payload.username : undefined };
  }

  private async longLived(provider: MetaProvider, response: Response, step: string): Promise<MetaLongLivedToken> {
    const payload = this.unwrap(await this.json(response));
    if (!response.ok || typeof payload.access_token !== 'string') {
      throw this.failure(`${provider} ${step} failed`);
    }
    const expiresIn = typeof payload.expires_in === 'number' ? payload.expires_in : Number(payload.expires_in);
    return {
      accessToken: payload.access_token,
      tokenType: typeof payload.token_type === 'string' ? payload.token_type : undefined,
      expiresAt: Number.isFinite(expiresIn) && expiresIn > 0 ? new Date(Date.now() + expiresIn * 1000) : undefined,
    };
  }

  /** Instagram's code exchange (and some /me responses) wrap the object in `data: [...]`. */
  private unwrap(payload: TokenPayload): TokenPayload {
    if (Array.isArray(payload.data) && payload.data[0] && typeof payload.data[0] === 'object') {
      return payload.data[0] as TokenPayload;
    }
    return payload;
  }

  private async json(response: Response): Promise<TokenPayload> {
    try {
      const value: unknown = await response.json();
      return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    } catch {
      return {};
    }
  }

  private failure(message: string): ApplicationException {
    return new ApplicationException(ErrorCode.PLATFORM_AUTH_FAILED, message, HttpStatus.BAD_GATEWAY);
  }

  private required(key: string): string {
    const value = this.config.get<string>(key)?.trim();
    if (!value) {
      throw new ApplicationException(ErrorCode.CONNECTOR_NEEDS_ACTION, `${key} is not configured`, HttpStatus.SERVICE_UNAVAILABLE, { status: 'CREDENTIAL_REQUIRED' });
    }
    return value;
  }
}
