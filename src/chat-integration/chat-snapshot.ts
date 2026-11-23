import { ConflictException } from '@nestjs/common';
import { MediaType, Prisma } from '@prisma/client';
import { sha256 } from '../common/utils/crypto.utils';

/** What an approver in chat sees and approves; any change to it voids the approval. */
export interface ApprovalSnapshot {
  title: string | null;
  body: string;
  hashtags: string[];
  /** Image shown in chat (latest https image of the draft), or null. */
  imageUrl: string | null;
  /** Every image the post would carry. A regenerated or removed image changes this. */
  imageIds: string[];
  /** Accounts of the draft's platform that the post would go to. */
  accountIds: string[];
  accountNames: string[];
  /** Campaign schedule shown as "Giờ đăng" (ISO), null when there is none. */
  scheduledAt: string | null;
}

type Reader = Pick<Prisma.TransactionClient, 'campaign' | 'contentVariant' | 'platformAccount' | 'mediaAsset'>;

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** Reads the snapshot of one draft as it is now (inside a transaction when given one). */
export async function loadApprovalSnapshot(db: Reader, campaignId: string, variantId: string): Promise<ApprovalSnapshot | null> {
  const [campaign, variant] = await Promise.all([
    db.campaign.findUnique({ where: { id: campaignId }, select: { scheduledAt: true, automationRequest: true } }),
    db.contentVariant.findUnique({ where: { id: variantId }, select: { title: true, body: true, hashtags: true, platformId: true } }),
  ]);
  if (!campaign || !variant) return null;
  const requested = (object(campaign.automationRequest).platformAccountIds as unknown[] | undefined)?.filter((id): id is string => typeof id === 'string') ?? [];
  const [accounts, images] = await Promise.all([
    requested.length
      ? db.platformAccount.findMany({ where: { id: { in: requested }, platformId: variant.platformId }, select: { id: true, name: true }, orderBy: { id: 'asc' } })
      : Promise.resolve([] as Array<{ id: string; name: string }>),
    db.mediaAsset.findMany({ where: { variantId, type: MediaType.IMAGE }, select: { id: true, publicUrl: true, createdAt: true }, orderBy: { createdAt: 'desc' } }),
  ]);
  const shown = images.find((image) => image.publicUrl?.startsWith('https://') && image.publicUrl.length <= 2048);
  return {
    title: variant.title,
    body: variant.body,
    hashtags: [...variant.hashtags],
    imageUrl: shown?.publicUrl ?? null,
    imageIds: images.map((image) => image.id).sort(),
    accountIds: accounts.map((account) => account.id),
    accountNames: accounts.map((account) => account.name),
    scheduledAt: campaign.scheduledAt?.toISOString() ?? null,
  };
}

export function snapshotHash(snapshot: ApprovalSnapshot): string {
  return sha256(JSON.stringify([
    snapshot.title ?? '', snapshot.body, snapshot.hashtags, snapshot.imageUrl, snapshot.imageIds, snapshot.accountIds, snapshot.scheduledAt,
  ]));
}

/** The draft (text, image, accounts or schedule) changed after it was sent to chat for approval. */
export class ApprovalContentChangedError extends ConflictException {
  constructor() {
    super('Bài đã được sửa (chữ, ảnh, tài khoản hoặc giờ đăng) sau khi gửi duyệt nên chưa đăng. Yêu cầu duyệt mới đã được gửi.');
  }
}
