import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma, VariantStatus } from '@prisma/client';
import { AiContentService } from '../ai/ai-content.service';
import { aiRoleSetting, approvalHash, readAiApproval, type AiApproval } from '../ai/content-approval';
import { ApplicationException } from '../common/exceptions/application.exception';
import type { ExtensionEngine } from '../connectors/extension/extension-delivery';
import { PrismaService } from '../database/prisma.service';
import { deliveryEngine } from '../platforms/post-length';
import { aiApprovalCurrent, approvalRunning, type ApprovalText } from './ai-approval-gate';
import { rewriteRunning } from './rewrite-state';

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

const DRAFT_SELECT = {
  id: true, contentId: true, platformId: true, title: true, body: true, hashtags: true, reason: true,
  mediaRecommendation: true, aiApproval: true,
  platform: { select: { slug: true } },
} satisfies Prisma.ContentVariantSelect;

type ApprovalDraft = Prisma.ContentVariantGetPayload<{ select: typeof DRAFT_SELECT }>;

/**
 * The final AI approver ("Cho AI duyệt") on one stored draft. Reading a post
 * takes longer than a proxied request may stay open, so it runs after the
 * response; the review screen follows `aiApproval.status`. A verdict is kept
 * only for the exact text the approver read.
 */
@Injectable()
export class VariantApprovalService {
  private readonly logger = new Logger(VariantApprovalService.name);

  constructor(private readonly prisma: PrismaService, private readonly ai: AiContentService) {}

  /** Whether the final approver gate is on (`AI_APPROVAL_ENABLED`). */
  enabled(): boolean {
    return this.ai.approvalEnabled();
  }

  /** `POST /content-variants/:id/ai-approval`: (re)runs the approver on the current text. */
  async start(ownerId: string, variantId: string): Promise<{ status: 'running' }> {
    if (!this.enabled()) throw new BadRequestException('AI duyệt cuối đang tắt trên máy chủ (AI_APPROVAL_ENABLED).');
    const variant = await this.prisma.contentVariant.findFirst({
      where: { id: variantId, content: { ownerId } },
      select: { ...DRAFT_SELECT, status: true, updatedAt: true, aiRevision: true, _count: { select: { targets: true } } },
    });
    if (!variant) throw new NotFoundException('Content variant not found');
    if (variant._count.targets) throw new BadRequestException('Bài đã vào chiến dịch đang đăng, không cho AI duyệt lại được nữa.');
    if (variant.status === VariantStatus.REJECTED) throw new BadRequestException('Bài đã bị từ chối. Khôi phục bài trước khi cho AI duyệt.');
    if (rewriteRunning(variant.aiRevision)) throw new ConflictException('AI đang viết lại bài này; bài mới được AI duyệt khi viết xong.');
    if (approvalRunning(variant.aiApproval) && aiApprovalCurrent(variant.aiApproval, variant)) {
      throw new ConflictException('AI duyệt cuối đang đọc bài này.');
    }
    const approval = await this.runningApproval(variant);
    // Compare-and-set on updatedAt: an edit, an approval or a second click in between wins.
    const claimed = await this.prisma.contentVariant.updateMany({
      where: { id: variantId, updatedAt: variant.updatedAt, targets: { none: {} } },
      data: { aiApproval: approval as unknown as Prisma.InputJsonObject },
    });
    if (!claimed.count) throw new ConflictException('Bài vừa thay đổi. Tải lại rồi thử cho AI duyệt lại.');
    this.launch(ownerId, variantId, approval);
    return { status: 'running' };
  }

  /** The "running" record stored (with the edit itself, when there is one) before the approver reads `post`. */
  async runningApproval(post: ApprovalText): Promise<AiApproval> {
    let approver = { approver: '', approverLabel: 'AI duyệt cuối' };
    try {
      const roles = await this.ai.roles();
      approver = { approver: aiRoleSetting(roles.approver), approverLabel: roles.approver.label };
    } catch (error) {
      // Only the label shown while it runs; the verdict carries the real approver.
      this.logger.warn(`Could not describe the AI approver: ${error instanceof Error ? error.message : String(error)}`);
    }
    return {
      status: 'running',
      ...approver,
      textHash: approvalHash(post),
      startedAt: new Date().toISOString(),
      finishedAt: null,
      error: null,
    };
  }

  /** Runs the approver after the response, for the claim `approval` already stored on the variant. */
  launch(ownerId: string, variantId: string, approval: AiApproval): void {
    void this.run(ownerId, variantId, approval);
  }

  private async run(ownerId: string, variantId: string, approval: AiApproval): Promise<void> {
    try {
      const draft = await this.prisma.contentVariant.findFirst({ where: { id: variantId, content: { ownerId } }, select: DRAFT_SELECT });
      // Deleted, or a newer run (an edit) replaced this one.
      if (!draft || readAiApproval(draft.aiApproval)?.startedAt !== approval.startedAt) return;
      const media = record(draft.mediaRecommendation);
      const hasImage = media.type === 'image' && media.status !== 'removed' && media.status !== 'failed';
      const result = await this.ai.approveDraft(ownerId, {
        contentId: draft.contentId,
        platformSlug: draft.platform.slug,
        engine: await this.engineOf(ownerId, draft.platformId),
        title: draft.title,
        body: draft.body,
        hashtags: draft.hashtags,
        image: hasImage ? { prompt: text(media.prompt), altText: text(media.altText) } : null,
        reviewNotes: draft.reason,
      });
      // The verdict belongs to the text read above; the claim's start time identifies this run.
      const verdict: AiApproval = { ...result, textHash: approvalHash(draft), startedAt: approval.startedAt };
      if (await this.store(draft, approval, verdict)) return;
      await this.fail(variantId, approval, 'Bài đã sửa trong lúc AI duyệt; bấm Cho AI duyệt lại.');
    } catch (error) {
      const message = error instanceof ApplicationException || error instanceof NotFoundException
        ? error.message : 'Không chạy được AI duyệt cuối.';
      this.logger.warn(`AI approval for variant ${variantId} failed: ${error instanceof Error ? error.message : String(error)}`);
      await this.fail(variantId, approval, message).catch((recordError: unknown) => {
        this.logger.error(`Could not record the approval failure for variant ${variantId}: ${recordError instanceof Error ? recordError.message : String(recordError)}`);
      });
    }
  }

  /** Saves the verdict only if the text is unchanged and this is still the latest run. */
  private async store(draft: ApprovalDraft, approval: AiApproval, verdict: AiApproval): Promise<boolean> {
    const saved = await this.prisma.contentVariant.updateMany({
      where: {
        id: draft.id, title: draft.title, body: draft.body, hashtags: { equals: draft.hashtags },
        aiApproval: { path: ['startedAt'], equals: approval.startedAt },
      },
      data: { aiApproval: verdict as unknown as Prisma.InputJsonObject },
    });
    return saved.count > 0;
  }

  /** Marks this run failed, only if it is still the latest one for the draft. */
  private async fail(variantId: string, approval: AiApproval, error: string): Promise<void> {
    await this.prisma.contentVariant.updateMany({
      where: { id: variantId, aiApproval: { path: ['startedAt'], equals: approval.startedAt } },
      data: { aiApproval: { ...approval, status: 'failed', finishedAt: new Date().toISOString(), error } },
    });
  }

  /** The Chrome extension engine the post will go through, when every account of its platform agrees on one. */
  private async engineOf(ownerId: string, platformId: string): Promise<ExtensionEngine | undefined> {
    const accounts = await this.prisma.platformAccount.findMany({ where: { ownerId, platformId, enabled: true }, select: { settings: true } });
    const engines = new Set(accounts.map((account) => deliveryEngine(account.settings)));
    return engines.size === 1 ? [...engines][0] : undefined;
  }
}
