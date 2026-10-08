import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { ContentStatus, Prisma, VariantStatus } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { CreateContentVariantDto } from './dto/create-content-variant.dto';

const variantInclude = {
  platform: { select: { slug: true, name: true } },
  content: { select: { id: true, title: true } },
} satisfies Prisma.ContentVariantInclude;

@Injectable()
export class ContentVariantsService {
  constructor(private readonly prisma: PrismaService) {}

  async createManual(ownerId: string, dto: CreateContentVariantDto) {
    const body = dto.body.trim();
    if (!body) throw new BadRequestException('Variant body must not be blank');

    const platformSlug = dto.platformSlug.trim().toLowerCase();
    if (!platformSlug) throw new BadRequestException('Platform slug must not be blank');
    const hashtags = this.normalizeHashtags(dto.hashtags ?? []);

    return this.prisma.$transaction(async (transaction) => {
      const content = await transaction.content.findFirstOrThrow({
        where: { id: dto.contentId, ownerId },
        select: { id: true },
      });
      const platform = await transaction.platform.findFirstOrThrow({
        where: { slug: platformSlug, enabled: true },
        select: { id: true },
      });

      // Updating the parent row serializes concurrent manual creates for the
      // same content before calculating the next per-platform version.
      await transaction.content.update({
        where: { id: content.id },
        data: { status: ContentStatus.GENERATED },
      });
      const latest = await transaction.contentVariant.aggregate({
        where: { contentId: content.id, platformId: platform.id },
        _max: { version: true },
      });

      return transaction.contentVariant.create({
        data: {
          contentId: content.id,
          platformId: platform.id,
          title: dto.title?.trim() || null,
          body,
          hashtags,
          recommended: true,
          reason: 'Created manually by an editor',
          status: VariantStatus.GENERATED,
          version: (latest._max.version ?? 0) + 1,
        },
        include: variantInclude,
      });
    });
  }

  list(ownerId: string, contentId?: string) {
    return this.prisma.contentVariant.findMany({
      where: { contentId, content: { ownerId } },
      include: variantInclude,
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
  }

  async updateUnreferenced(
    ownerId: string,
    id: string,
    data: Prisma.ContentVariantUpdateManyMutationInput,
  ) {
    const updated = await this.prisma.contentVariant.updateMany({
      where: {
        id,
        content: { ownerId },
        targets: { none: {} },
      },
      data,
    });
    if (!updated.count) {
      await this.prisma.contentVariant.findFirstOrThrow({
        where: { id, content: { ownerId } },
        select: { id: true },
      });
      throw new ConflictException('A content variant is immutable after it has been added to a campaign');
    }
    return this.prisma.contentVariant.findUniqueOrThrow({ where: { id }, include: variantInclude });
  }

  private normalizeHashtags(values: string[]): string[] {
    const result: string[] = [];
    const seen = new Set<string>();
    for (const value of values) {
      const hashtag = value.trim().replace(/^#+/, '').trim();
      const key = hashtag.toLowerCase();
      if (!hashtag || seen.has(key)) continue;
      seen.add(key);
      result.push(hashtag);
    }
    return result;
  }
}
