import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { MediaType, Prisma, VariantStatus } from '@prisma/client';
import { AiContentService } from '../ai/ai-content.service';
import { AiProvider } from '../ai/ai-provider';
import { imagePlanFor } from '../campaigns/image-plan';
import { ApplicationException } from '../common/exceptions/application.exception';
import { repairEscapedNewlines } from '../common/utils/escaped-text';
import { PrismaService } from '../database/prisma.service';

/** A rewrite still "generating" after this long is treated as lost (API restart). */
const GENERATING_STALE_AFTER_MS = 10 * 60 * 1000;
export const MAX_REWRITE_INSTRUCTION_LENGTH = 2_000;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/**
 * "Viết lại bằng AI" on one draft. Writing, scoring and up to two rewrites take
 * a minute or more, longer than a proxied request may stay open, so it runs
 * after the response; the review screen follows `aiRevision.status`. The new
 * text replaces the draft in place, so it stays in its review and campaign.
 */
@Injectable()
export class VariantRewriteService {
  private readonly logger = new Logger(VariantRewriteService.name);

  constructor(private readonly prisma: PrismaService, private readonly ai: AiContentService) {}

  async start(ownerId: string, variantId: string, input: { instruction?: string; aiProvider?: AiProvider }) {
    const instruction = input.instruction?.trim() ?? '';
    if (instruction.length > MAX_REWRITE_INSTRUCTION_LENGTH) throw new BadRequestException('Hướng dẫn viết lại tối đa 2.000 ký tự.');
    const provider = this.ai.resolveProvider(input.aiProvider);
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
    const current = record(variant.aiRevision);
    const startedAt = typeof current.startedAt === 'string' ? Date.parse(current.startedAt) : NaN;
    if (current.status === 'generating' && Date.now() - startedAt < GENERATING_STALE_AFTER_MS) {
      throw new ConflictException('AI đang viết lại bài này.');
    }
    // Provider configured and the platform still has an active prompt: fail now, not in the background.
    await this.ai.assertReady([variant.platform.slug], provider);
    const revision = { status: 'generating', instruction, provider, startedAt: new Date().toISOString(), finishedAt: null, error: null };
    // Compare-and-set on updatedAt: an edit, approval or second click in between wins.
    const claimed = await this.prisma.contentVariant.updateMany({
      where: { id: variantId, updatedAt: variant.updatedAt, targets: { none: {} } },
      data: { aiRevision: revision },
    });
    if (!claimed.count) throw new ConflictException('Bài vừa thay đổi. Tải lại rồi thử viết lại.');
    const media = record(variant.mediaRecommendation);
    const hasImage = variant._count.media > 0 || (media.type === 'image' && media.status !== 'removed');
    void this.run(ownerId, variant, revision, provider, hasImage);
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
      const result = await this.ai.reviseDraft(ownerId, {
        contentId: variant.contentId,
        platformSlug: variant.platform.slug,
        image: hasImage ? imagePlanFor(variant.platform.slug) : null,
        revision: {
          previous: { title: variant.title, body: variant.body, hashtags: variant.hashtags },
          instruction: typeof revision.instruction === 'string' ? revision.instruction : '',
          // A passing draft's reason is praise, not a note to fix.
          notes: variant.recommended ? null : variant.reason,
        },
      }, provider);
      const saved = await this.prisma.contentVariant.updateMany({
        // Unchanged text only: an edit saved by the operator meanwhile is kept.
        where: {
          id: variant.id, targets: { none: {} }, title: variant.title, body: variant.body,
          aiRevision: { path: ['startedAt'], equals: revision.startedAt as Prisma.InputJsonValue },
        },
        data: {
          title: result.title,
          body: repairEscapedNewlines(result.body),
          summary: result.summary,
          hashtags: result.hashtags,
          cta: result.cta,
          recommended: result.recommended,
          reason: result.reason,
          // New text needs a new decision: an approved draft goes back to waiting.
          ...(variant.status === VariantStatus.APPROVED ? { status: VariantStatus.GENERATED } : {}),
          aiRevision: { ...revision, status: 'done', finishedAt: new Date().toISOString() },
        },
      });
      if (!saved.count) {
        await this.finish(variant.id, revision, 'Bài đã được duyệt hoặc sửa tay trong lúc AI viết lại; giữ nguyên bản hiện tại.');
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
