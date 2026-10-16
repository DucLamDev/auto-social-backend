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
    transaction?: Prisma.TransactionClient,
  ): Promise<void> {
    const encryptedPayload = this.encryption.encrypt(payload);
    const client = transaction ?? this.prisma;
    await client.platformCredential.upsert({
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
      select: { encryptedPayload: true, status: true, expiresAt: true },
    });
    if (
      credential.status !== CredentialStatus.ACTIVE
      || (credential.expiresAt && credential.expiresAt.getTime() <= Date.now())
    ) {
      throw new ApplicationException(
        ErrorCode.PLATFORM_TOKEN_EXPIRED,
        'Stored platform credential is revoked or expired; reconnect the account',
        HttpStatus.UNAUTHORIZED,
      );
    }
    return this.encryption.decrypt(credential.encryptedPayload);
  }

  /**
   * Atomically merges refreshed secret material without replacing unrelated
   * credential fields. The optimistic compare prevents a browser worker from
   * overwriting a credential update performed by another API/worker replica.
   */
  async merge(platformAccountId: string, patch: Record<string, unknown>, options: { requireActive?: boolean } = {}): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const current = await this.prisma.platformCredential.findUnique({
        where: { platformAccountId },
        select: { encryptedPayload: true, updatedAt: true, status: true, expiresAt: true },
      });
      if (options.requireActive && (!current || current.status !== CredentialStatus.ACTIVE
        || (current.expiresAt && current.expiresAt.getTime() <= Date.now()))) {
        throw new Error('Credential was revoked or expired; explicit login is required');
      }
      if (!current) {
        try {
          await this.prisma.platformCredential.create({
            data: {
              platformAccountId,
              encryptedPayload: this.encryption.encrypt(patch),
              keyVersion: this.encryption.keyVersion,
              status: CredentialStatus.ACTIVE,
            },
          });
          return;
        } catch (error) {
          if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') continue;
          throw error;
        }
      }
      const payload = { ...this.encryption.decrypt(current.encryptedPayload), ...patch };
      const encryptedPayload = this.encryption.encrypt(payload);
      const updated = await this.prisma.platformCredential.updateMany({
        where: { platformAccountId, updatedAt: current.updatedAt,
          ...(options.requireActive ? { status: CredentialStatus.ACTIVE,
            OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] } : {}),
        },
        data: {
          encryptedPayload,
          keyVersion: this.encryption.keyVersion,
          status: CredentialStatus.ACTIVE,
          expiresAt: null,
        },
      });
      if (updated.count === 1) return;
    }
    throw new Error('Credential changed concurrently; browser state was not saved');
  }

  /**
   * Cryptographically replaces the stored secret payload and marks it revoked.
   * Keeping the row lets a later browser login capture reactivate it through
   * merge(), without retaining the old storageState or accepting passwords.
   */
  async revoke(
    platformAccountId: string,
    transaction?: Prisma.TransactionClient,
  ): Promise<void> {
    const client = transaction ?? this.prisma;
    await client.platformCredential.updateMany({
      where: { platformAccountId },
      data: {
        encryptedPayload: this.encryption.encrypt({}),
        keyVersion: this.encryption.keyVersion,
        status: CredentialStatus.REVOKED,
        expiresAt: null,
      },
    });
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
