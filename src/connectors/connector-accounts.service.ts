import { Injectable } from '@nestjs/common';
import { AccountStatus } from '@prisma/client';
import { CredentialsService } from '../credentials/credentials.service';
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

@Injectable()
export class ConnectorAccountsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly credentials: CredentialsService,
    private readonly registry: ConnectorRegistryService,
  ) {}

  async load(id: string): Promise<{ platform: string; account: ConnectorAccount }> {
    const source = await this.prisma.platformAccount.findUniqueOrThrow({
      where: { id },
      include: { platform: { select: { slug: true } }, credential: { select: { id: true } }, oauthToken: { select: { id: true } } },
    });
    let credentialValues: Record<string, unknown> = {};
    if (source.credential) {
      credentialValues = await this.credentials.resolve(id);
    } else if (source.oauthToken) {
      let token = await this.credentials.resolveOAuth(id);
      if (token.expiresAt && token.expiresAt.getTime() <= Date.now() + 60_000) {
        if (source.platform.slug === 'blogger' && token.refreshToken) {
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
    const { platform, account } = await this.load(id);
    const connector = this.registry.get(platform);
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
        data: { status: AccountStatus.ERROR, lastTestedAt: new Date() },
      });
      throw error;
    }
  }
}
