import { Injectable, Logger } from '@nestjs/common';
import { Prisma, VariantStatus } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { rewriteRunning } from '../content-variants/rewrite-state';
import { ChatConfigService } from './chat-config.service';
import { CHAT_SETTING_KEY, ChatOutboxKind, OPEN_LINK_STATUSES, OUTBOX_PENDING, OUTBOX_SKIPPED } from './chat-integration.constants';

const REVIEWABLE_STATES = ['WAITING_REVIEW', 'PROCESSING'];

/** Same rule as the review page: a planned image still being made keeps the post from being ready. */
function imagePending(mediaRecommendation: unknown): boolean {
  const media = mediaRecommendation && typeof mediaRecommendation === 'object' && !Array.isArray(mediaRecommendation)
    ? mediaRecommendation as Record<string, unknown> : {};
  return media.status === 'pending' || media.status === 'generating';
}

type Tx = Prisma.TransactionClient | PrismaService;

/**
 * Writes what auto-social owes the chat into the outbox. Called from the review
 * flow, so every public hook swallows its own errors: a broken chat connection
 * never fails an approval, a rejection or an AI run.
 */
@Injectable()
export class ChatOutboxService {
  private readonly logger = new Logger(ChatOutboxService.name);

  constructor(private readonly prisma: PrismaService, private readonly chatConfig: ChatConfigService) {}

  /** Inserts one event unless its key exists. Switched off: the row is kept as SKIPPED. Returns true when inserted. */
  async record(kind: ChatOutboxKind, dedupeKey: string, payload: Prisma.InputJsonObject, tx: Tx = this.prisma, enabled?: boolean): Promise<boolean> {
    const on = enabled ?? (await this.chatConfig.read()).config.enabled;
    const result = await tx.chatOutboxEvent.createMany({
      data: [{ kind, dedupeKey: dedupeKey.slice(0, 300), payload, status: on ? OUTBOX_PENDING : OUTBOX_SKIPPED }],
      skipDuplicates: true,
    });
    return result.count === 1;
  }

  /**
   * Drafts that became ready for review: each one waiting (not decided, image
   * done, no AI rewrite running) gets one approval request for its current
   * review round. A round already queued or open is left alone.
   */
  async reviewReady(campaignId: string, variantIds: string[]): Promise<void> {
    await this.bestEffort('reviewReady', async () => {
      if (!variantIds.length || !(await this.configured())) return;
      const enabled = (await this.chatConfig.read()).config.enabled;
      const campaign = await this.prisma.campaign.findFirst({ where: { id: campaignId, automationState: { in: REVIEWABLE_STATES } }, select: { automationVariantIds: true } });
      if (!campaign) return;
      const drafts = await this.prisma.contentVariant.findMany({
        where: {
          id: { in: variantIds.filter((id) => campaign.automationVariantIds.includes(id)) },
          status: { in: [VariantStatus.GENERATED, VariantStatus.APPROVED] },
          targets: { none: {} },
        },
        select: { id: true, mediaRecommendation: true, aiRevision: true },
      });
      for (const draft of drafts) {
        if (imagePending(draft.mediaRecommendation) || rewriteRunning(draft.aiRevision)) continue;
        await this.queueApproval(campaignId, draft.id, enabled);
      }
    });
  }

  /**
   * Drafts decided (or restored) on the web, or a deleted campaign: open chat
   * requests are closed. Omit `variantIds` for every draft of the campaign.
   */
  async reviewClosed(campaignId: string, variantIds?: string[]): Promise<void> {
    await this.bestEffort('reviewClosed', async () => {
      if (variantIds && !variantIds.length) return;
      if (!(await this.configured())) return;
      const enabled = (await this.chatConfig.read()).config.enabled;
      const where = { campaignId, status: { in: OPEN_LINK_STATUSES }, ...(variantIds ? { variantId: { in: variantIds } } : {}) };
      const links = await this.prisma.chatApprovalLink.findMany({ where, select: { id: true, approvalId: true } });
      for (const link of links) {
        const closed = await this.prisma.chatApprovalLink.updateMany({ where: { id: link.id, status: { in: OPEN_LINK_STATUSES } }, data: { status: 'CANCELLED' } });
        // A request not created yet is dropped by the sender when it sees the link closed.
        if (closed.count && link.approvalId) await this.record('APPROVAL_CANCEL', `cancel:${link.approvalId}`, { approvalId: link.approvalId }, this.prisma, enabled);
      }
    });
  }

  /** A restored draft waits for review again: close its old round, open a new one. */
  async reviewRestored(campaignId: string, variantIds?: string[]): Promise<void> {
    await this.reviewClosed(campaignId, variantIds);
    await this.bestEffort('reviewRestored', async () => {
      const campaign = await this.prisma.campaign.findUnique({ where: { id: campaignId }, select: { automationVariantIds: true } });
      if (campaign) await this.reviewReady(campaignId, variantIds ?? campaign.automationVariantIds);
    });
  }

  private async queueApproval(campaignId: string, variantId: string, enabled: boolean): Promise<void> {
    const latest = await this.prisma.chatApprovalLink.findFirst({ where: { variantId }, orderBy: { cycle: 'desc' }, select: { cycle: true, status: true } });
    if (latest && OPEN_LINK_STATUSES.includes(latest.status)) return;
    const cycle = (latest?.cycle ?? 0) + 1;
    const externalKey = `variant:${variantId}:c${cycle}`;
    try {
      await this.prisma.$transaction(async (tx) => {
        const link = await tx.chatApprovalLink.create({ data: { campaignId, variantId, cycle, externalKey, status: enabled ? 'QUEUED' : 'SKIPPED' } });
        await this.record('APPROVAL_CREATE', externalKey, { linkId: link.id }, tx, enabled);
      });
    } catch (error) {
      // Another hook queued the same round first.
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') throw error;
    }
  }

  /** Never set up: hooks stay silent instead of filling the outbox with skipped rows. */
  private async configured(): Promise<boolean> {
    return (await this.prisma.systemSetting.count({ where: { key: CHAT_SETTING_KEY } })) > 0;
  }

  private async bestEffort(name: string, task: () => Promise<void>): Promise<void> {
    try {
      await task();
    } catch (error) {
      this.logger.warn(`Chat outbox ${name} skipped: ${error instanceof Error ? error.message : 'unknown error'}`);
    }
  }
}
