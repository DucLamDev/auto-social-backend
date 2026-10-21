import { Injectable } from '@nestjs/common';
import { AccountStatus, CredentialStatus, PlatformMode } from '@prisma/client';
import { CredentialsService } from '../credentials/credentials.service';
import { isMetaProvider, META_MIN_TOKEN_AGE_MS, MetaTokenService } from '../credentials/meta-token.service';
import { PrismaService } from '../database/prisma.service';
import { ConnectorAccount } from './core/connector.types';
import { ConnectorRegistryService } from './core/connector-registry.service';
import { ConnectorError } from './core/connector-error';
import { ErrorCode } from '../common/exceptions/application.exception';

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

const BROWSER_RECONNECT_REASONS = new Set([
  'CAPTCHA_REQUIRED',
  'LOGIN_REQUIRED',
  'SECURITY_CHECK_REQUIRED',
  'TWO_FACTOR_REQUIRED',
]);

function browserTestFailureStatus(connectorKey: string, error: unknown): AccountStatus {
  if (connectorKey !== 'browser-assisted' || !(error instanceof ConnectorError)) {
    return AccountStatus.ERROR;
  }
  const reason = error.safeDetails?.reason;
  return typeof reason === 'string' && BROWSER_RECONNECT_REASONS.has(reason)
    ? AccountStatus.RECONNECT_REQUIRED
    : AccountStatus.ERROR;
}

@Injectable()
export class ConnectorAccountsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly credentials: CredentialsService,
    private readonly registry: ConnectorRegistryService,
    private readonly meta: MetaTokenService,
  ) {}

  async load(id: string): Promise<{
    platform: string;
    connectorKey: string;
    platformEnabled: boolean;
    platformMode: PlatformMode;
    enabled: boolean;
    status: AccountStatus;
    account: ConnectorAccount;
  }> {
    return this.loadInternal(id, false);
  }

  /**
   * Login capture must be able to replace a browser session after an explicit
   * revocation or credential expiry. In that narrow case the inactive secret
   * is deliberately ignored and Chromium starts with an empty storage state.
   * Active credentials still go through normal decryption and validation, so
   * corrupt active state cannot be silently discarded.
   */
  async loadForBrowserLoginCapture(id: string): Promise<{
    platform: string;
    connectorKey: string;
    platformEnabled: boolean;
    platformMode: PlatformMode;
    enabled: boolean;
    status: AccountStatus;
    account: ConnectorAccount;
  }> {
    return this.loadInternal(id, true);
  }

  private async loadInternal(id: string, allowInactiveBrowserCredential: boolean): Promise<{
    platform: string;
    connectorKey: string;
    platformEnabled: boolean;
    platformMode: PlatformMode;
    enabled: boolean;
    status: AccountStatus;
    account: ConnectorAccount;
  }> {
    const source = await this.prisma.platformAccount.findUniqueOrThrow({
      where: { id },
      include: {
        platform: { select: { slug: true, connectorKey: true, enabled: true, mode: true } },
        credential: { select: { id: true, status: true, expiresAt: true } },
        oauthToken: { select: { id: true, updatedAt: true } },
      },
    });
    let credentialValues: Record<string, unknown> = {};
    if (source.credential) {
      const inactiveBrowserCredential = source.platform.connectorKey === 'browser-assisted'
        && (
          source.credential.status !== CredentialStatus.ACTIVE
          || (source.credential.expiresAt?.getTime() ?? Number.POSITIVE_INFINITY) <= Date.now()
        );
      if (!allowInactiveBrowserCredential || !inactiveBrowserCredential) {
        credentialValues = await this.credentials.resolve(id);
      }
    } else if (source.oauthToken) {
      let token = await this.credentials.resolveOAuth(id);
      const connectorKey = source.platform.connectorKey;
      // The hourly maintenance job normally renews Meta tokens weeks ahead;
      // this catches a token that reached its last day while that job was down.
      if (
        isMetaProvider(connectorKey)
        && token.expiresAt
        && token.expiresAt.getTime() > Date.now()
        && token.expiresAt.getTime() <= Date.now() + 24 * 60 * 60_000
        && Date.now() - source.oauthToken.updatedAt.getTime() >= META_MIN_TOKEN_AGE_MS
      ) {
        try {
          const renewed = await this.meta.refresh(connectorKey, token.accessToken);
          await this.credentials.upsertOAuthTokens({
            platformAccountId: id,
            accessToken: renewed.accessToken,
            scopes: token.scopes,
            tokenType: renewed.tokenType ?? 'bearer',
            expiresAt: renewed.expiresAt,
          });
          token = await this.credentials.resolveOAuth(id);
        } catch {
          // The current token is still valid; publish with it and let maintenance retry.
        }
      }
      if (token.expiresAt && token.expiresAt.getTime() <= Date.now() + 60_000) {
        if (source.platform.connectorKey === 'blogger' && token.refreshToken) {
          try {
            await this.credentials.refreshGoogleOAuth(id, token.refreshToken);
            token = await this.credentials.resolveOAuth(id);
          } catch {
            await this.prisma.platformAccount.update({ where: { id }, data: { status: AccountStatus.RECONNECT_REQUIRED } });
            throw new ConnectorError(ErrorCode.PLATFORM_TOKEN_EXPIRED, 'Google token refresh failed; reconnect the account', false);
          }
        } else {
          await this.prisma.platformAccount.update({ where: { id }, data: { status: AccountStatus.RECONNECT_REQUIRED } });
          throw new ConnectorError(ErrorCode.PLATFORM_TOKEN_EXPIRED, 'OAuth token expired; reconnect the account', false);
        }
      }
      credentialValues = { accessToken: token.accessToken, refreshToken: token.refreshToken };
    }
    return {
      platform: source.platform.slug,
      connectorKey: source.platform.connectorKey,
      platformEnabled: source.platform.enabled,
      platformMode: source.platform.mode,
      enabled: source.enabled,
      status: source.status,
      account: {
        id: source.id,
        externalId: source.externalId ?? undefined,
        username: source.username ?? undefined,
        settings: asRecord(source.settings),
        credentials: credentialValues,
      },
    };
  }

  async test(id: string) {
    const { connectorKey, enabled, account } = await this.load(id);
    if (enabled === false) {
      throw new ConnectorError(
        ErrorCode.CONNECTOR_NEEDS_ACTION,
        'Enable the platform account before testing its connection',
        false,
      );
    }
    const connector = this.registry.get(connectorKey);
    if (!connector.testConnection) {
      return { ok: false, manual: true, message: 'This connector has no automatic connection test' };
    }
    try {
      const result = await connector.testConnection(account);
      await this.prisma.platformAccount.update({
        where: { id },
        data: { status: AccountStatus.CONNECTED, lastTestedAt: new Date() },
      });
      return result;
    } catch (error) {
      await this.prisma.platformAccount.update({
        where: { id },
        data: { status: browserTestFailureStatus(connectorKey, error), lastTestedAt: new Date() },
      });
      throw error;
    }
  }
}
