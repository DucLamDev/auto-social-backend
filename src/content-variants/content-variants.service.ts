import { ConflictException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';

const variantInclude = {
  platform: { select: { slug: true, name: true } },
  content: { select: { id: true, title: true } },
} satisfies Prisma.ContentVariantInclude;

@Injectable()
export class ContentVariantsService {
  constructor(private readonly prisma: PrismaService) {}

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
}
