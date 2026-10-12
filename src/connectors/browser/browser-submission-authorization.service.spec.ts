import { AccountStatus, CredentialStatus, PlatformMode } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { BrowserSubmissionAuthorizationService } from './browser-submission-authorization.service';

describe('BrowserSubmissionAuthorizationService', () => {
  const ready = {
    enabled: true,
    status: AccountStatus.CONNECTED,
    settings: {
      browserRecipe: 'voz-xenforo',
      automationPermissionAttested: true,
      browserAutoSubmit: true,
    },
    credential: { status: CredentialStatus.ACTIVE, expiresAt: null },
    platform: {
      enabled: true,
      mode: PlatformMode.BROWSER_ASSISTED,
      connectorKey: 'browser-assisted',
    },
  };

  it('allows only the current reviewed browser configuration', async () => {
    const service = new BrowserSubmissionAuthorizationService({
      platformAccount: { findUnique: jest.fn().mockResolvedValue(ready) },
    } as unknown as PrismaService);

    await expect(service.inspect('account-1', 'voz-xenforo'))
      .resolves.toEqual({ authorized: true });
  });

  it('stops before submit when the credential was revoked', async () => {
    const service = new BrowserSubmissionAuthorizationService({
      platformAccount: {
        findUnique: jest.fn().mockResolvedValue({
          ...ready,
          status: AccountStatus.RECONNECT_REQUIRED,
          credential: { status: CredentialStatus.REVOKED, expiresAt: null },
        }),
      },
    } as unknown as PrismaService);

    await expect(service.inspect('account-1', 'voz-xenforo')).resolves.toMatchObject({
      authorized: false,
      reason: 'LOGIN_REQUIRED',
      reconnectRequired: true,
    });
  });

  it('stops before submit when consent is withdrawn', async () => {
    const service = new BrowserSubmissionAuthorizationService({
      platformAccount: {
        findUnique: jest.fn().mockResolvedValue({
          ...ready,
          settings: { ...ready.settings, browserAutoSubmit: false },
        }),
      },
    } as unknown as PrismaService);

    await expect(service.inspect('account-1', 'voz-xenforo')).resolves.toMatchObject({
      authorized: false,
      reason: 'SUBMISSION_CONFIRMATION_REQUIRED',
    });
  });
});
