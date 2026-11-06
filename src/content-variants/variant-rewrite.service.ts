import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { MediaType, Prisma, VariantStatus } from '@prisma/client';
import { AiContentService } from '../ai/ai-content.service';
import { AiProvider } from '../ai/ai-provider';
import { approvalHash, type AiApproval } from '../ai/content-approval';
import { scoreFromReason } from '../ai/content-quality';
import { imagePlanFor } from '../campaigns/image-plan';
import { ApplicationException } from '../common/exceptions/application.exception';
import { repairEscapedNewlines } from '../common/utils/escaped-text';
import { PrismaService } from '../database/prisma.service';
import { rewriteRunning } from './rewrite-state';
import { VariantApprovalService } from './variant-approval.service';

export const MAX_REWRITE_INSTRUCTION_LENGTH = 2_000;
/** "Sửa theo khuyến nghị": how many review points one request may carry, and how long each may be. */
export const MAX_REWRITE_NOTES = 20;
export const MAX_REWRITE_NOTE_LENGTH = 1_000;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/**
 * "Viết lại bằng AI" on one draft. Writing, scoring and up to two rewrites take
 * a minute or more, longer than a proxied request may stay open, so it runs
 * after the response; the review screen follows `aiRevision.status`. The
 * reviser (Claude Opus by default) edits only what the notes point to; the new
 * text replaces the draft in place, so it stays in its review and campaign. A
 * new version that still fails and scores lower than the stored one is not
 * saved: the stored draft is kept and the request reports why.
 */
@Injectable()
export class VariantRewriteService {
  private readonly logger = new Logger(VariantRewriteService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ai: AiContentService,
    private readonly approvals: VariantApprovalService,
  ) {}

  async start(ownerId: string, variantId: string, input: { instruction?: string; notes?: string[]; aiProvider?: AiProvider }) {
    const instruction = input.instruction?.trim() ?? '';
    if (instruction.length > MAX_REWRITE_INSTRUCTION_LENGTH) throw new BadRequestException('Hướng dẫn viết lại tối đa 2.000 ký tự.');
    // Chosen review points replace the automatic notes; none chosen and no instruction leaves nothing to fix.
    const notes = input.notes ? [...new Set(input.notes.map((note) => note.trim()).filter(Boolean))] : undefined;
    if (notes && (notes.length > MAX_REWRITE_NOTES || notes.some((note) => note.length > MAX_REWRITE_NOTE_LENGTH))) {
      throw new BadRequestException(`Chọn tối đa ${MAX_REWRITE_NOTES} khuyến nghị, mỗi khuyến nghị tối đa 1.000 ký tự.`);
    }
    if (notes && !notes.length && !instruction) throw new BadRequestException('Chọn ít nhất một khuyến nghị để AI sửa.');
    const requested = this.ai.resolveProvider(input.aiProvider);
    const variant = await this.prisma.contentVariant.findFirst({
      where: { id: variantId, content: { ownerId } },
      select: {
        id: true, contentId: true, title: true, body: true, hashtags: true, reason: true, recommended: true,
        status: true, updatedAt: true, aiRevision: true, mediaRecommendation: true,
        platform: { select: { slug: true } },
        _count: { select: { targets: true, media: { where: { type: MediaType.IMAGE } } } },
      },
    });
    if (!variant) throw new NotFoundException('Content variant not found');
    if (variant._count.targets) throw new ConflictException('Bài đã vào chiến dịch đang đăng, không viết lại được nữa.');
    if (variant.status === VariantStatus.REJECTED) throw new ConflictException('Bài đã bị từ chối. Khôi phục bài trước khi viết lại.');
    if (rewriteRunning(variant.aiRevision)) throw new ConflictException('AI đang viết lại bài này.');
    // Who edits: the reviser (Claude Opus by default), or the requested writer without its key.
    const writer = await this.ai.reviserFor(requested);
    const provider = writer.provider;
    // Provider configured and the platform still has an active prompt: fail now, not in the background.
    await this.ai.assertReady([variant.platform.slug], provider);
    const revision = {
      status: 'generating', instruction, ...(notes ? { notes } : {}), provider, writerLabel: this.ai.roleLabel(writer),
      startedAt: new Date().toISOString(), finishedAt: null, error: null,
    };
    // Compare-and-set on updatedAt: an edit, approval or second click in between wins.
    const claimed = await this.prisma.contentVariant.updateMany({
      where: { id: variantId, updatedAt: variant.updatedAt, targets: { none: {} } },
      data: { aiRevision: revision },
    });
    if (!claimed.count) throw new ConflictException('Bài vừa thay đổi. Tải lại rồi thử viết lại.');
    const media = record(variant.mediaRecommendation);
    const hasImage = variant._count.media > 0 || (media.type === 'image' && media.status !== 'removed');
    void this.run(ownerId, variant, revision, requested, hasImage);
    return { status: 'generating' };
  }

  private async run(
    ownerId: string,
    variant: { id: string; contentId: string; title: string | null; body: string; hashtags: string[]; reason: string | null; recommended: boolean; status: VariantStatus; platform: { slug: string } },
    revision: Record<string, unknown>,
    provider: AiProvider,
    hasImage: boolean,
  ) {
    try {
      const previousScore = scoreFromReason(variant.reason);
      const result = await this.ai.reviseDraft(ownerId, {
        contentId: variant.contentId,
        platformSlug: variant.platform.slug,
        image: hasImage ? imagePlanFor(variant.platform.slug) : null,
        revision: {
          previous: { title: variant.title, body: variant.body, hashtags: variant.hashtags },
          instruction: typeof revision.instruction === 'string' ? revision.instruction : '',
          // The new version is judged against this score, so fixing the chosen points raises it.
          previousScore,
          // Points the operator chose replace the whole last review; a passing draft's reason is praise, not a note to fix.
          ...(Array.isArray(revision.notes)
            ? { notes: null, chosenNotes: revision.notes.filter((note): note is string => typeof note === 'string') }
            : { notes: variant.recommended ? null : variant.reason }),
        },
      }, provider);
      // A failing edit that scores lower than the stored draft would only make it worse.
      const newScore = scoreFromReason(result.reason);
      if (!result.recommended && result.approval?.status !== 'approved' && newScore !== null && previousScore !== null && newScore < previousScore) {
        await this.finish(variant.id, revision, `Bản AI sửa chỉ được ${newScore}/10, thấp hơn bản hiện tại (${previousScore}/10), nên giữ nguyên bản hiện tại. Sửa tay hoặc chọn khuyến nghị khác rồi thử lại.`);
        return;
      }
      const post = { title: result.title, body: repairEscapedNewlines(result.body), hashtags: result.hashtags };
      // The final approver's verdict comes with the new text. Without one for exactly
      // the stored text (approver off, or the body repaired after it read it) the
      // approver runs again when it is on; else the old verdict stays, no longer current.
      const verdict = result.approval?.textHash === approvalHash(post) ? result.approval : undefined;
      const rerun = !verdict && this.approvals.enabled() ? await this.approvals.runningApproval(post) : undefined;
      const approval: AiApproval | undefined = verdict ?? rerun;
      const saved = await this.prisma.contentVariant.updateMany({
        // Unchanged text only: an edit saved by the operator meanwhile is kept.
        where: {
          id: variant.id, targets: { none: {} }, title: variant.title, body: variant.body,
          aiRevision: { path: ['startedAt'], equals: revision.startedAt as Prisma.InputJsonValue },
        },
        data: {
          title: post.title,
          body: post.body,
          summary: result.summary,
          hashtags: post.hashtags,
          cta: result.cta,
          recommended: result.recommended,
          reason: result.reason,
          // New text needs a new decision: an approved draft goes back to waiting.
          ...(variant.status === VariantStatus.APPROVED ? { status: VariantStatus.GENERATED } : {}),
          aiRevision: { ...revision, status: 'done', finishedAt: new Date().toISOString() },
          ...(approval ? { aiApproval: approval as unknown as Prisma.InputJsonObject } : {}),
        },
      });
      if (!saved.count) {
        await this.finish(variant.id, revision, 'Bài đã được duyệt hoặc sửa tay trong lúc AI viết lại; giữ nguyên bản hiện tại.');
      } else if (rerun) {
        this.approvals.launch(ownerId, variant.id, rerun);
      }
    } catch (error) {
      const message = error instanceof ApplicationException || error instanceof NotFoundException
        ? error.message : 'Không viết lại được bài bằng AI.';
      this.logger.warn(`AI rewrite for variant ${variant.id} failed: ${error instanceof Error ? error.message : String(error)}`);
      await this.finish(variant.id, revision, message).catch((recordError: unknown) => {
        this.logger.error(`Could not record the rewrite failure for variant ${variant.id}: ${recordError instanceof Error ? recordError.message : String(recordError)}`);
      });
    }
  }

  /** Marks this request failed, only if it is still the latest one for the draft. */
  private async finish(variantId: string, revision: Record<string, unknown>, error: string) {
    await this.prisma.contentVariant.updateMany({
      where: { id: variantId, aiRevision: { path: ['startedAt'], equals: revision.startedAt as Prisma.InputJsonValue } },
      data: { aiRevision: { ...revision, status: 'failed', finishedAt: new Date().toISOString(), error } },
    });
  }
}
