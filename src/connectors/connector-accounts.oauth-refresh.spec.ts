import { HttpStatus } from '@nestjs/common';
import { AccountStatus } from '@prisma/client';
import { ApplicationException, ErrorCode } from '../common/exceptions/application.exception';
import { CredentialsService } from '../credentials/credentials.service';
import { MetaTokenService } from '../credentials/meta-token.service';
import { PrismaService } from '../database/prisma.service';
import { ConnectorAccountsService } from './connector-accounts.service';
import { ConnectorRegistryService } from './core/connector-registry.service';

const expired = { accessToken: 'old', refreshToken: 'r1', scopes: [], expiresAt: new Date(Date.now() - 1_000) };
const fresh = { accessToken: 'new', refreshToken: 'r2', scopes: [], expiresAt: new Date(Date.now() + 40 * 60_000) };

function setup(connectorKey: string, refresh: jest.Mock, resolveOAuth: jest.Mock) {
  const update = jest.fn().mockResolvedValue({});
  const prisma = {
    platformAccount: {
      findUniqueOrThrow: jest.fn().mockResolvedValue({
        id: 'acc', externalId: 'blog', username: null, settings: {}, enabled: true, status: AccountStatus.CONNECTED,
        platform: { slug: connectorKey, connectorKey, enabled: true, mode: 'OFFICIAL_API' },
        credential: null,
        oauthToken: { id: 'tok', updatedAt: new Date() },
      }),
      update,
    },
  } as unknown as PrismaService;
  const credentials = { resolveOAuth, refreshGoogleOAuth: refresh, refreshTumblrOAuth: refresh } as unknown as CredentialsService;
  const service = new ConnectorAccountsService(prisma, credentials, new ConnectorRegistryService(), {} as MetaTokenService);
  return { service, update };
}

describe('ConnectorAccountsService OAuth refresh', () => {
  it('refreshes an expired Tumblr token and uses the new one', async () => {
    const refresh = jest.fn().mockResolvedValue(undefined);
    const { service } = setup('tumblr', refresh, jest.fn().mockResolvedValueOnce(expired).mockResolvedValueOnce(fresh));
    await expect(service.load('acc')).resolves.toMatchObject({ account: { credentials: { accessToken: 'new' } } });
    expect(refresh).toHaveBeenCalledWith('acc', 'r1');
  });

  it('treats a network failure during Google refresh as retryable, not as a reconnect', async () => {
    const refresh = jest.fn().mockRejectedValue(new TypeError('fetch failed'));
    const { service, update } = setup('blogger', refresh, jest.fn().mockResolvedValue(expired));
    await expect(service.load('acc')).rejects.toMatchObject({ code: ErrorCode.PLATFORM_API_ERROR, retryable: true });
    expect(update).not.toHaveBeenCalled();
  });

  it('uses the token a parallel job just stored when the rotated refresh token is refused', async () => {
    const refresh = jest.fn().mockRejectedValue(new ApplicationException(ErrorCode.PLATFORM_TOKEN_EXPIRED, 'used', HttpStatus.UNAUTHORIZED));
    const { service, update } = setup('tumblr', refresh, jest.fn().mockResolvedValueOnce(expired).mockResolvedValueOnce(fresh));
    await expect(service.load('acc')).resolves.toMatchObject({ account: { credentials: { accessToken: 'new' } } });
    expect(update).not.toHaveBeenCalled();
  });

  it('asks for reconnection when the provider refuses the refresh and no newer token exists', async () => {
    const refresh = jest.fn().mockRejectedValue(new ApplicationException(ErrorCode.PLATFORM_TOKEN_EXPIRED, 'revoked', HttpStatus.UNAUTHORIZED));
    const { service, update } = setup('tumblr', refresh, jest.fn().mockResolvedValue(expired));
    await expect(service.load('acc')).rejects.toMatchObject({ code: ErrorCode.PLATFORM_TOKEN_EXPIRED });
    expect(update).toHaveBeenCalledWith({ where: { id: 'acc' }, data: { status: AccountStatus.RECONNECT_REQUIRED } });
  });
});
