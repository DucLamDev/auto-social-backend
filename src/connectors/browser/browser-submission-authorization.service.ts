import { Injectable } from '@nestjs/common';
import { AccountStatus, CredentialStatus, PlatformMode } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';

export type BrowserSubmissionAuthorization =
  | { authorized: true }
  | {
      authorized: false;
      reason: 'AUTOMATION_DISABLED' | 'LOGIN_REQUIRED' | 'SUBMISSION_CONFIRMATION_REQUIRED';
      message: string;
      reconnectRequired?: boolean;
    };

function settingsRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

/**
 * Performs the final, database-backed authorization read immediately before a
 * reviewed recipe is allowed to click its submit control.
 */
@Injectable()
export class BrowserSubmissionAuthorizationService {
  constructor(private readonly prisma: PrismaService) {}

  async inspect(accountId: string, recipeKey: string): Promise<BrowserSubmissionAuthorization> {
    const account = await this.prisma.platformAccount.findUnique({
      where: { id: accountId },
      select: {
        enabled: true,
        status: true,
        settings: true,
        credential: { select: { status: true, expiresAt: true } },
        platform: { select: { enabled: true, mode: true, connectorKey: true } },
      },
    });
    if (
      !account
      || !account.enabled
      || account.status === AccountStatus.DISABLED
      || !account.platform.enabled
      || account.platform.mode !== PlatformMode.BROWSER_ASSISTED
      || account.platform.connectorKey !== 'browser-assisted'
    ) {
      return {
        authorized: false,
        reason: 'AUTOMATION_DISABLED',
        message: 'Browser publishing was disabled before final submission; nothing was submitted',
      };
    }
    if (
      account.status !== AccountStatus.CONNECTED
      || account.credential?.status !== CredentialStatus.ACTIVE
      || (account.credential.expiresAt && account.credential.expiresAt.getTime() <= Date.now())
    ) {
      return {
        authorized: false,
        reason: 'LOGIN_REQUIRED',
        message: 'The browser login session was revoked or expired before final submission',
        reconnectRequired: true,
      };
    }
    const settings = settingsRecord(account.settings);
    if (settings.browserRecipe !== recipeKey) {
      return {
        authorized: false,
        reason: 'AUTOMATION_DISABLED',
        message: 'The reviewed browser recipe changed before final submission; nothing was submitted',
      };
    }
    if (
      settings.automationPermissionAttested !== true
      || settings.browserAutoSubmit !== true
    ) {
      return {
        authorized: false,
        reason: 'SUBMISSION_CONFIRMATION_REQUIRED',
        message: 'Browser automation consent or auto-submit was revoked before final submission',
      };
    }
    return { authorized: true };
  }
}
