import { Injectable } from '@nestjs/common';
import { CredentialStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { CredentialEncryptionService } from './credential-encryption.service';
import { ConfigService } from '@nestjs/config';
import { ApplicationException, ErrorCode } from '../common/exceptions/application.exception';
import { HttpStatus } from '@nestjs/common';

@Injectable()
export class CredentialsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly encryption: CredentialEncryptionService,
    private readonly config: ConfigService,
  ) {}

  async upsert(
    platformAccountId: string,
    payload: Record<string, unknown>,
    expiresAt?: Date,
  ): Promise<void> {
    const encryptedPayload = this.encryption.encrypt(payload);
    await this.prisma.platformCredential.upsert({
      where: { platformAccountId },
      create: {
        platformAccountId,
        encryptedPayload,
        keyVersion: this.encryption.keyVersion,
        status: CredentialStatus.ACTIVE,
        expiresAt,
      },
      update: {
        encryptedPayload,
        keyVersion: this.encryption.keyVersion,
        status: CredentialStatus.ACTIVE,
        expiresAt,
      },
    });
  }

  async resolve(platformAccountId: string): Promise<Record<string, unknown>> {
    const credential = await this.prisma.platformCredential.findUniqueOrThrow({
      where: { platformAccountId },
      select: { encryptedPayload: true },
    });
    return this.encryption.decrypt(credential.encryptedPayload);
  }

  async upsertOAuthTokens(input: {
    platformAccountId: string;
    accessToken: string;
    refreshToken?: string;
    scopes: string[];
    tokenType?: string;
    expiresAt?: Date;
  }): Promise<void> {
    const encryptedAccessToken = this.encryption.encrypt({ token: input.accessToken });
    const encryptedRefreshToken = input.refreshToken
      ? this.encryption.encrypt({ token: input.refreshToken })
      : undefined;
    const create: Prisma.OAuthTokenUncheckedCreateInput = {
      platformAccountId: input.platformAccountId,
      encryptedAccessToken,
      encryptedRefreshToken: encryptedRefreshToken ?? null,
      scopes: input.scopes,
      tokenType: input.tokenType ?? 'Bearer',
      expiresAt: input.expiresAt ?? null,
    };
    const update: Prisma.OAuthTokenUncheckedUpdateInput = {
      encryptedAccessToken,
      ...(encryptedRefreshToken ? { encryptedRefreshToken } : {}),
      scopes: input.scopes,
      tokenType: input.tokenType ?? 'Bearer',
      expiresAt: input.expiresAt ?? null,
    };
    await this.prisma.oAuthToken.upsert({
      where: { platformAccountId: input.platformAccountId },
      create,
      update,
    });
  }

  async resolveOAuth(platformAccountId: string): Promise<{
    accessToken: string;
    refreshToken?: string;
    scopes: string[];
    expiresAt?: Date;
  }> {
    const token = await this.prisma.oAuthToken.findUniqueOrThrow({
      where: { platformAccountId },
    });
    const access = this.encryption.decrypt(token.encryptedAccessToken).token;
    const refresh = token.encryptedRefreshToken
      ? this.encryption.decrypt(token.encryptedRefreshToken).token
      : undefined;
    if (typeof access !== 'string' || (refresh !== undefined && typeof refresh !== 'string')) {
      throw new Error('OAuth credential payload is invalid');
    }
    return {
      accessToken: access,
      refreshToken: refresh,
      scopes: token.scopes,
      expiresAt: token.expiresAt ?? undefined,
    };
  }

  async refreshGoogleOAuth(platformAccountId: string, refreshToken: string): Promise<void> {
    const clientId = this.config.get<string>('GOOGLE_CLIENT_ID');
    const clientSecret = this.config.get<string>('GOOGLE_CLIENT_SECRET');
    if (!clientId || !clientSecret) {
      throw new ApplicationException(ErrorCode.PLATFORM_TOKEN_EXPIRED, 'Google OAuth client is not configured for token refresh', HttpStatus.UNAUTHORIZED);
    }
    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, grant_type: 'refresh_token' }),
      signal: AbortSignal.timeout(30_000),
    });
    const payload = (await response.json()) as { access_token?: string; expires_in?: number; scope?: string; token_type?: string; refresh_token?: string };
    if (!response.ok || !payload.access_token) {
      throw new ApplicationException(ErrorCode.PLATFORM_TOKEN_EXPIRED, 'Google refresh token was rejected; reconnect the account', HttpStatus.UNAUTHORIZED);
    }
    const current = await this.prisma.oAuthToken.findUniqueOrThrow({ where: { platformAccountId } });
    await this.upsertOAuthTokens({
      platformAccountId,
      accessToken: payload.access_token,
      refreshToken: payload.refresh_token ?? refreshToken,
      scopes: payload.scope?.split(/\s+/).filter(Boolean) ?? current.scopes,
      tokenType: payload.token_type ?? current.tokenType,
      expiresAt: payload.expires_in ? new Date(Date.now() + payload.expires_in * 1000) : undefined,
    });
  }
}
