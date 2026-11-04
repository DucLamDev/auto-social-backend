import { Prisma, PublishJobStatus } from '@prisma/client';
import { EXTENSION_CONNECTOR_KEY } from '../connectors/extension/extension-delivery';
import type { PrismaService } from '../database/prisma.service';

/** A claimed task without any report after this long is treated as "result unknown". */
export const EXTENSION_CLAIM_TIMEOUT_MS = 10 * 60_000;
export const EXTENSION_RESULT_UNKNOWN = 'EXTENSION_RESULT_UNKNOWN';
export const EXTENSION_RESULT_UNKNOWN_MESSAGE = 'Tiện ích không báo kết quả trong 10 phút. Kiểm tra diễn đàn: đã có bài thì bấm Đã đăng, chưa có thì Giao lại cho tiện ích.';

/** Prisma JSON filter: accounts switched to Chrome extension delivery. */
export const EXTENSION_ACCOUNT = { settings: { path: ['delivery'], equals: EXTENSION_CONNECTOR_KEY } } satisfies Prisma.PlatformAccountWhereInput;

/**
 * A claim with no report may mean the extension posted and then crashed.
 * Never re-claim it automatically: ask the operator to check the site. The
 * update only touches rows still silent past the timeout, so running it from
 * several processes at once (claim, scheduler replicas) changes each row once.
 */
export async function expireStaleExtensionClaims(
  prisma: Pick<PrismaService, 'publishJob'>,
  ownerId?: string,
  now = new Date(),
): Promise<number> {
  const result = await prisma.publishJob.updateMany({
    where: {
      status: PublishJobStatus.NEEDS_ACTION,
      lastErrorCode: null,
      lockedAt: { lt: new Date(now.getTime() - EXTENSION_CLAIM_TIMEOUT_MS) },
      ...(ownerId ? { target: { campaign: { ownerId } } } : {}),
      platformAccount: EXTENSION_ACCOUNT,
    },
    data: { lastErrorCode: EXTENSION_RESULT_UNKNOWN, lastErrorMessage: EXTENSION_RESULT_UNKNOWN_MESSAGE },
  });
  return result.count;
}
