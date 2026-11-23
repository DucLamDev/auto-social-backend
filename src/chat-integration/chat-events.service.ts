import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma, RoleName, VariantStatus } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { CampaignAutomationService } from '../campaigns/campaign-automation.service';
import { PrismaService } from '../database/prisma.service';
import { ChatApiClient } from './chat-api.client';
import { ChatConfigService } from './chat-config.service';
import { APPROVAL_ACTION, OPEN_LINK_STATUSES } from './chat-integration.constants';
import { ApprovalContentChangedError } from './chat-snapshot';
import { ChatOutboxService } from './chat-outbox.service';

type Decision = { user_email?: unknown; decision?: unknown; note?: unknown };
type Link = { id: string; campaignId: string; variantId: string; approvalId: string | null; status: string; contentHash: string | null; externalKey: string };
export type EventOutcome = 'applied' | 'ignored' | 'rejected_decider' | 'failed';

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const str = (value: unknown): string | null => (typeof value === 'string' && value ? value : null);
const VIETNAMESE = /[ăâđêôơưáàảãạấầẩẫậắằẳẵặéèẻẽẹếềểễệíìỉĩịóòỏõọốồổỗộớờởỡợúùủũụứừửữựýỳỷỹỵ]/i;

/** Why an approval could not be applied, in words the chat card can show. */
export function failureMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  if ((error instanceof BadRequestException || error instanceof ConflictException) && VIETNAMESE.test(message)) return message.slice(0, 500);
  if (error instanceof NotFoundException) return 'Bài hoặc chiến dịch không còn ở auto-social.';
  if (error instanceof ConflictException) return 'Bài không còn chờ duyệt ở auto-social (đã được xử lý hoặc đã thay đổi).';
  if (error instanceof BadRequestException) return 'Auto-social không duyệt được bài này. Mở auto-social để xem lý do.';
  return 'Auto-social gặp lỗi khi duyệt bài. Thử duyệt lại trên auto-social.';
}

/**
 * Applies chat approval decisions (contract B1). A decision counts only from
 * the campaign owner, signed in to auto-social (enabled, ADMIN or EDITOR), and
 * goes through the very functions the review page calls.
 */
@Injectable()
export class ChatEventsService {
  private readonly logger = new Logger(ChatEventsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly automation: CampaignAutomationService,
    private readonly audit: AuditService,
    private readonly outbox: ChatOutboxService,
    private readonly chatConfig: ChatConfigService,
    private readonly api: ChatApiClient,
  ) {}

  async handle(event: Record<string, unknown>): Promise<EventOutcome> {
    const type = event.event_type;
    const payload = object(event.payload);
    if (type !== 'approval.decided' && type !== 'approval.cancelled') return 'ignored';
    const link = await this.ownLink(payload);
    if (!link) return 'ignored';
    const status = payload.status;
    if (type === 'approval.cancelled' || status === 'cancelled') return this.close(link, 'CANCELLED');
    if (status === 'expired') return this.close(link, 'EXPIRED');
    if (status !== 'approved' && status !== 'rejected') return 'ignored';
    const approvalId = link.approvalId ?? str(payload.approval_id)!;

    if (!OPEN_LINK_STATUSES.includes(link.status)) {
      // Already handled on auto-social (or this decision was applied before).
      if (status === 'approved' && !['APPROVED', 'FAILED'].includes(link.status)) {
        await this.reportFailure(link, approvalId, 'Bài đã được xử lý ở auto-social.');
      }
      return 'ignored';
    }

    const action = status === 'approved' ? 'approve' : 'reject';
    const decisions = Array.isArray(payload.decisions) ? payload.decisions as Decision[] : [];
    const decision = [...decisions].reverse().find((item) => object(item).decision === action);
    const email = str(decision?.user_email)?.trim().toLowerCase() ?? null;
    const note = str(decision?.note)?.slice(0, 500) ?? null;
    const campaign = await this.prisma.campaign.findUnique({ where: { id: link.campaignId }, select: { id: true, ownerId: true, scheduledAt: true } });
    const user = email
      ? await this.prisma.user.findFirst({ where: { email: { equals: email, mode: 'insensitive' } }, select: { id: true, enabled: true, roles: { select: { role: { select: { name: true } } } } } })
      : null;
    const problem = !campaign ? 'CAMPAIGN_GONE'
      : !user ? 'UNKNOWN_USER'
        : !user.enabled ? 'USER_DISABLED'
          : !user.roles.some(({ role }) => role.name === RoleName.ADMIN || role.name === RoleName.EDITOR) ? 'ROLE_NOT_ALLOWED'
            : user.id !== campaign.ownerId ? 'NOT_OWNER' : null;
    if (problem || !campaign || !user) {
      await this.audit.recordBestEffort({
        actorId: user?.id, action: 'CHAT_APPROVAL_IGNORED', entityType: 'campaigns', entityId: link.campaignId,
        after: { source: 'chat', approvalId, variantId: link.variantId, decision: action, reason: problem },
      });
      await this.prisma.chatApprovalLink.updateMany({ where: { id: link.id, status: { in: OPEN_LINK_STATUSES } }, data: { status: 'FAILED', approvalId } });
      if (action === 'approve') await this.recordFailure(approvalId, problem === 'CAMPAIGN_GONE' ? 'Chiến dịch không còn ở auto-social.' : 'Người duyệt không hợp lệ.');
      return 'rejected_decider';
    }

    // Claim the link first: the hooks fired by the decision must not cancel this same request.
    const claimed = await this.prisma.chatApprovalLink.updateMany({
      where: { id: link.id, status: { in: OPEN_LINK_STATUSES } },
      data: { status: action === 'approve' ? 'APPROVED' : 'REJECTED', approvalId },
    });
    if (!claimed.count) return 'ignored';
    // A missing hash means nothing is known about what was shown: approval is refused under the lock.
    const origin = { source: 'chat' as const, approvalId, ...(note ? { note } : {}), ...(link.contentHash ? { expectedHash: link.contentHash } : {}) };
    try {
      if (action === 'approve') {
        const future = campaign.scheduledAt && campaign.scheduledAt.getTime() > Date.now() + 60_000;
        await this.automation.approveVariant(user.id, campaign.id, link.variantId,
          future ? { publishMode: 'SCHEDULED', scheduledAt: campaign.scheduledAt!.toISOString() } : { publishMode: 'NOW' }, origin);
      } else {
        await this.automation.rejectVariant(user.id, campaign.id, link.variantId, origin);
      }
      return 'applied';
    } catch (error) {
      this.logger.warn(`Chat ${action} of variant ${link.variantId} raised: ${error instanceof Error ? error.message : 'unknown error'}`);
      // The decision may have been stored before a later step failed: trust the data, not the exception.
      if (await this.decisionStored(campaign.id, link.variantId, action)) return 'applied';
      const changed = error instanceof ApprovalContentChangedError;
      const message = failureMessage(error);
      await this.prisma.chatApprovalLink.update({ where: { id: link.id }, data: { status: 'FAILED' } });
      await this.audit.recordBestEffort({
        actorId: user.id, action: 'CHAT_APPROVAL_FAILED', entityType: 'campaigns', entityId: campaign.id,
        after: { source: 'chat', approvalId, variantId: link.variantId, decision: action, message, ...(changed ? { reason: 'CHANGED_SINCE_REQUEST' } : {}) },
      });
      if (action === 'approve') await this.recordFailure(approvalId, message);
      // Ask again with what the post is now.
      if (changed) await this.outbox.reviewReady(campaign.id, [link.variantId]);
      return 'failed';
    }
  }

  /**
   * The link this event is about, only when the approval is really ours: our
   * action, our draft as resource, and the approval id we stored. An id not
   * stored yet is confirmed with chat (GET as our bot: another bot's request is 404).
   */
  private async ownLink(payload: Record<string, unknown>): Promise<Link | null> {
    const link = await this.findLink(payload);
    if (!link) return null;
    const approvalId = str(payload.approval_id);
    if (payload.action !== APPROVAL_ACTION || payload.resource_id !== link.variantId || !approvalId) return this.foreign(link, approvalId, 'ACTION_OR_RESOURCE_MISMATCH');
    if (link.approvalId) return link.approvalId === approvalId ? link : this.foreign(link, approvalId, 'APPROVAL_ID_MISMATCH');
    const config = await this.chatConfig.active();
    if (!config) return null;
    const result = await this.api.getApproval(config, approvalId);
    if (result.status === 404) return this.foreign(link, approvalId, 'NOT_OUR_APPROVAL');
    // Anything else unexpected: fail so chat delivers the event again.
    if (!result.ok) throw new Error(`Chat approval lookup failed with HTTP ${result.status}`);
    if (object(result.data?.approval).external_key !== link.externalKey) return this.foreign(link, approvalId, 'EXTERNAL_KEY_MISMATCH');
    const stored = await this.prisma.chatApprovalLink.updateMany({ where: { id: link.id, approvalId: null }, data: { approvalId } });
    if (!stored.count) {
      const current = await this.prisma.chatApprovalLink.findUnique({ where: { id: link.id }, select: { approvalId: true } });
      if (current?.approvalId !== approvalId) return this.foreign(link, approvalId, 'APPROVAL_ID_MISMATCH');
    }
    return { ...link, approvalId };
  }

  private async foreign(link: Link, approvalId: string | null, reason: string): Promise<null> {
    await this.audit.recordBestEffort({
      action: 'CHAT_APPROVAL_IGNORED', entityType: 'campaigns', entityId: link.campaignId,
      after: { source: 'chat', approvalId, variantId: link.variantId, reason },
    });
    return null;
  }

  private async decisionStored(campaignId: string, variantId: string, action: 'approve' | 'reject'): Promise<boolean> {
    if (action === 'approve') return (await this.prisma.campaignTarget.count({ where: { campaignId, contentVariantId: variantId } })) > 0;
    return (await this.prisma.contentVariant.count({ where: { id: variantId, status: VariantStatus.REJECTED } })) > 0;
  }

  private async findLink(payload: Record<string, unknown>): Promise<Link | null> {
    const select = { id: true, campaignId: true, variantId: true, approvalId: true, status: true, contentHash: true, externalKey: true } satisfies Prisma.ChatApprovalLinkSelect;
    const approvalId = str(payload.approval_id);
    const byId = approvalId ? await this.prisma.chatApprovalLink.findUnique({ where: { approvalId }, select }) : null;
    if (byId) return byId;
    // The webhook can arrive before the sender stored the id the create call returned.
    const externalKey = str(payload.external_key);
    const byKey = externalKey ? await this.prisma.chatApprovalLink.findUnique({ where: { externalKey }, select }) : null;
    if (!byKey || (byKey.approvalId && byKey.approvalId !== approvalId) || !approvalId) return null;
    return byKey;
  }

  private async close(link: Link, status: 'CANCELLED' | 'EXPIRED'): Promise<EventOutcome> {
    const updated = await this.prisma.chatApprovalLink.updateMany({ where: { id: link.id, status: { in: OPEN_LINK_STATUSES } }, data: { status } });
    return updated.count ? 'applied' : 'ignored';
  }

  private async reportFailure(link: Link, approvalId: string, message: string): Promise<void> {
    await this.prisma.chatApprovalLink.updateMany({ where: { id: link.id, resultRecordedAt: null }, data: { resultRecordedAt: new Date() } });
    await this.recordFailure(approvalId, message);
  }

  private async recordFailure(approvalId: string, error: string): Promise<void> {
    await this.outbox.record('APPROVAL_RESULT', `result:${approvalId}`, { approvalId, status: 'failed', error });
  }
}
