import { BadRequestException, ConflictException, HttpException } from '@nestjs/common';
import { failedPlatformOf } from '../ai/ai-content.service';
import { ApplicationException, ErrorCode } from '../common/exceptions/application.exception';
import { PLATFORM_CATALOG } from '../platforms/platform-catalog';

/** What the review screen shows when an AI run fails: the cause, the platform and the provider. */
export interface AutomationFailure {
  code: string;
  message: string;
  platform?: string;
  platformName?: string;
  provider?: string;
  at: string;
}

const MESSAGE_MAX = 500;

/**
 * Turns an error into a cause the operator can act on. Messages of the
 * application's own exceptions are already free of upstream response bodies;
 * any other error (a bug, a database error) is named only, and its full text
 * stays in the API log with the campaign id.
 */
export function describeAutomationFailure(error: unknown, campaignId: string, provider?: string, now = new Date()): AutomationFailure {
  const code = error instanceof ApplicationException ? error.code
    : error instanceof BadRequestException ? ErrorCode.VALIDATION_FAILED
      : error instanceof ConflictException ? ErrorCode.CONFLICT
        : ErrorCode.INTERNAL_ERROR;
  const message = error instanceof HttpException
    ? error.message
    : `Lỗi máy chủ khi tạo bài (${error instanceof Error ? error.name : 'không rõ'}). Xem log API của chiến dịch ${campaignId}.`;
  const platform = failedPlatformOf(error);
  const platformName = platform ? PLATFORM_CATALOG.find((entry) => entry.slug === platform)?.name ?? platform : undefined;
  return {
    code,
    message: message.slice(0, MESSAGE_MAX),
    ...(platform ? { platform, platformName } : {}),
    ...(provider ? { provider } : {}),
    at: now.toISOString(),
  };
}
