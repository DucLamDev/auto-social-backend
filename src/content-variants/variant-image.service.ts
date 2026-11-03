import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { MediaType, Prisma } from '@prisma/client';
import { AI_IMAGE_SIZES, AiImageService, AiImageSize } from '../ai/ai-image.service';
import { imageSizeFor } from '../campaigns/image-plan';
import { ApplicationException } from '../common/exceptions/application.exception';
import { PrismaService } from '../database/prisma.service';
import { MediaService } from '../media/media.service';

/** A regeneration still "generating" after this long is treated as lost (API restart). */
const GENERATING_STALE_AFTER_MS = 10 * 60 * 1000;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/**
 * Review-time image actions on one draft variant. Regeneration takes minutes,
 * longer than a proxied HTTP request may stay open, so it runs after the
 * response and the review screen follows `mediaRecommendation.status`.
 */
@Injectable()
export class VariantImageService {
  private readonly logger = new Logger(VariantImageService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly media: MediaService,
    @Optional() private readonly images?: AiImageService,
  ) {}

  async regenerate(ownerId: string, variantId: string, input: { prompt?: string }) {
    const images = this.images;
    if (!images?.status().configured) throw new BadRequestException('Chưa cấu hình tạo ảnh bằng VPSTTT AI trên máy chủ.');
    const variant = await this.editable(ownerId, variantId);
    const current = record(variant.mediaRecommendation);
    const startedAt = typeof current.startedAt === 'string' ? Date.parse(current.startedAt) : NaN;
    if (current.status === 'generating' && Date.now() - startedAt < GENERATING_STALE_AFTER_MS) {
      throw new ConflictException('Ảnh của kênh này đang được tạo.');
    }
    const prompt = input.prompt?.trim() || (typeof current.prompt === 'string' ? current.prompt.trim() : '');
    if (!prompt) throw new BadRequestException('Chưa có mô tả ảnh. Nhập mô tả rồi tạo lại.');
    if (prompt.length > 4_000) throw new BadRequestException('Mô tả ảnh tối đa 4.000 ký tự.');
    const size: AiImageSize = (AI_IMAGE_SIZES as readonly string[]).includes(String(current.size)) ? current.size as AiImageSize : imageSizeFor(variant.platform.slug);
    const altText = typeof current.altText === 'string' ? current.altText : '';
    const generating = { ...current, type: 'image', prompt, altText, size, status: 'generating', startedAt: new Date().toISOString(), error: null };
    await this.prisma.contentVariant.update({ where: { id: variantId }, data: { mediaRecommendation: generating } });
    void this.run(ownerId, variantId, images, generating);
    return { status: 'generating' };
  }

  async remove(ownerId: string, variantId: string, mediaId: string) {
    const variant = await this.editable(ownerId, variantId);
    await this.media.removeVariantImage(ownerId, variantId, mediaId);
    const left = await this.prisma.mediaAsset.count({ where: { variantId, type: MediaType.IMAGE } });
    if (!left) {
      await this.prisma.contentVariant.update({ where: { id: variantId }, data: { mediaRecommendation: { ...record(variant.mediaRecommendation), status: 'removed' } } });
    }
    return { removed: true };
  }

  private async run(ownerId: string, variantId: string, images: AiImageService, request: Record<string, unknown>) {
    const prompt = String(request.prompt);
    try {
      const generated = await images.generate(prompt, request.size as AiImageSize);
      // A newer "Tạo lại ảnh" started meanwhile: its image wins, this one is dropped.
      if (!await this.isLatest(variantId, request.startedAt)) return;
      const stored = await this.media.storeGeneratedImage(ownerId, variantId, generated, { altText: typeof request.altText === 'string' ? request.altText : '', prompt });
      // The new image replaces the variant's previous ones: one image per post.
      await this.prisma.mediaAsset.deleteMany({ where: { variantId, ownerId, type: MediaType.IMAGE, id: { not: stored.id } } });
      await this.finish(variantId, { ...request, status: 'generated', error: null });
    } catch (error) {
      const message = error instanceof ApplicationException || error instanceof ConflictException || error instanceof NotFoundException
        ? error.message : 'Không tạo được ảnh bằng VPSTTT AI.';
      this.logger.warn(`Image regeneration for variant ${variantId} failed: ${message}`);
      await this.finish(variantId, { ...request, status: 'failed', error: message }).catch((recordError: unknown) => {
        this.logger.error(`Could not record the image failure for variant ${variantId}: ${recordError instanceof Error ? recordError.message : String(recordError)}`);
      });
    }
  }

  private async isLatest(variantId: string, startedAt: unknown) {
    const current = await this.prisma.contentVariant.findFirst({ where: { id: variantId }, select: { mediaRecommendation: true } });
    return record(current?.mediaRecommendation).startedAt === startedAt;
  }

  /** Writes the outcome only if this run is still the latest request for the variant. */
  private async finish(variantId: string, outcome: Record<string, unknown>) {
    await this.prisma.contentVariant.updateMany({
      where: { id: variantId, mediaRecommendation: { path: ['startedAt'], equals: outcome.startedAt as Prisma.InputJsonValue } },
      data: { mediaRecommendation: outcome as Prisma.InputJsonValue },
    });
  }

  private async editable(ownerId: string, variantId: string) {
    const variant = await this.prisma.contentVariant.findFirst({
      where: { id: variantId, content: { ownerId } },
      select: { id: true, mediaRecommendation: true, platform: { select: { slug: true } }, _count: { select: { targets: true } } },
    });
    if (!variant) throw new NotFoundException('Content variant not found');
    if (variant._count.targets) throw new ConflictException('Không đổi ảnh sau khi bài đã vào chiến dịch đang đăng.');
    return variant;
  }
}
