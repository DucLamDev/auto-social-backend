import { approvalHash, readAiApproval } from '../ai/content-approval';

/** An approval still "running" after this long is treated as lost (API restart); it can be started again. */
export const APPROVAL_STALE_AFTER_MS = 10 * 60 * 1000;

/** The text a reader sees: what the final approver judges and what its approval is valid for. */
export type ApprovalText = { title?: string | null; body: string; hashtags?: readonly string[] | null };

export type ApprovalVariant = ApprovalText & { aiApproval?: unknown };

export const NO_APPROVAL_MESSAGE = 'Chưa được AI duyệt cuối; bấm Cho AI duyệt.';
export const APPROVAL_RUNNING_MESSAGE = 'AI duyệt cuối đang đọc bài…';
export const APPROVAL_CHANGED_MESSAGE = 'Bài đã sửa sau khi AI duyệt; đang chờ duyệt lại.';

/** The approver is reading the post now (not a run lost to a restart). */
export function approvalRunning(value: unknown): boolean {
  const approval = readAiApproval(value);
  if (approval?.status !== 'running') return false;
  const startedAt = Date.parse(approval.startedAt);
  return Number.isFinite(startedAt) && Date.now() - startedAt < APPROVAL_STALE_AFTER_MS;
}

/** The stored verdict was given on exactly this text (whatever the verdict was). */
export function aiApprovalCurrent(value: unknown, text: ApprovalText): boolean {
  const approval = readAiApproval(value);
  return Boolean(approval) && approval!.textHash === approvalHash(text);
}

/**
 * Why the final approver does not let this variant be approved or published,
 * in Vietnamese for the reviewer; null when it may go out. With the approver
 * turned off nothing is blocked.
 */
export function aiApprovalProblem(variant: ApprovalVariant, enabled: boolean): string | null {
  if (!enabled) return null;
  const approval = readAiApproval(variant.aiApproval);
  if (!approval) return NO_APPROVAL_MESSAGE;
  if (approval.status === 'running' && !approvalRunning(variant.aiApproval)) {
    return 'AI duyệt cuối chưa chạy được: lượt duyệt bị gián đoạn, bấm Cho AI duyệt lại.';
  }
  // A verdict (or a run) on older text says nothing about this text.
  if (approval.textHash !== approvalHash(variant)) return APPROVAL_CHANGED_MESSAGE;
  if (approval.status === 'running') return APPROVAL_RUNNING_MESSAGE;
  if (approval.status === 'approved') return null;
  if (approval.status === 'rejected') {
    const reasons = (approval.reasons ?? []).map((reason) => reason.trim()).filter(Boolean);
    return `AI duyệt cuối (${approval.approverLabel || 'AI'}) từ chối: ${reasons.length ? reasons.join('; ') : 'không nêu lý do'}`;
  }
  return `AI duyệt cuối chưa chạy được: ${approval.error?.trim() || 'lỗi không rõ'}`;
}

/**
 * Same check for a variant that may predate the approver: one with no stored
 * approval (approved before this feature) passes; a stored verdict must be
 * "approved" for the current text.
 */
export function storedApprovalProblem(variant: ApprovalVariant, enabled: boolean): string | null {
  return readAiApproval(variant.aiApproval) ? aiApprovalProblem(variant, enabled) : null;
}

/** API shape: the stored verdict plus whether it was given on the current text. */
export function withAiApprovalCurrent<T extends ApprovalVariant>(variant: T): T & { aiApprovalCurrent: boolean } {
  return { ...variant, aiApprovalCurrent: aiApprovalCurrent(variant.aiApproval, variant) };
}
