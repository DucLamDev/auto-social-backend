import { Injectable } from '@nestjs/common';
import { ContentStatus, Prisma } from '@prisma/client';
import { sha256 } from '../common/utils/crypto.utils';
import { PrismaService } from '../database/prisma.service';
import { CreateContentDto } from './dto/create-content.dto';
import { paginatedData } from '../common/interceptors/api-response.interceptor';
import { ListContentsQueryDto } from './dto/list-contents-query.dto';

@Injectable()
export class ContentsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(ownerId: string, query: ListContentsQueryDto) {
    const search = query.search?.trim();
    const where: Prisma.ContentWhereInput = {
      ownerId,
      ...(query.status ? { status: query.status } : {}),
      ...(query.sourceId ? { sourceArticle: { sourceId: query.sourceId } } : {}),
      ...(query.from || query.to ? {
        createdAt: {
          ...(query.from ? { gte: new Date(query.from) } : {}),
          ...(query.to ? { lte: new Date(query.to) } : {}),
        },
      } : {}),
      ...(search ? {
        OR: [
          { title: { contains: search, mode: 'insensitive' as const } },
          { summary: { contains: search, mode: 'insensitive' as const } },
          { body: { contains: search, mode: 'insensitive' as const } },
        ],
      } : {}),
    };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.content.findMany({
        where,
        include: {
          _count: { select: { variants: true, campaigns: true } },
          sourceArticle: { select: { source: { select: { id: true, name: true, type: true } } } },
        },
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
      this.prisma.content.count({ where }),
    ]);
    return paginatedData(items, {
      page: query.page,
      limit: query.limit,
      total,
      totalPages: total ? Math.ceil(total / query.limit) : 0,
    });
  }

  get(ownerId: string, id: string) {
    return this.prisma.content.findFirstOrThrow({
      where: { id, ownerId },
      include: { variants: { include: { platform: { select: { slug: true, name: true } } } }, media: true },
    });
  }

  create(ownerId: string, dto: CreateContentDto) {
    return this.prisma.content.create({
      data: {
        ownerId,
        title: dto.title.trim(),
        body: dto.body,
        summary: dto.summary,
        language: dto.language ?? 'vi',
        canonicalUrl: dto.canonicalUrl,
        contentHash: sha256(`${dto.title}\n${dto.body}`),
        status: ContentStatus.DRAFT,
      },
    });
  }

  async promoteSourceArticle(ownerId: string, sourceArticleId: string) {
    const article = await this.prisma.sourceArticle.findFirstOrThrow({
      where: { id: sourceArticleId, source: { ownerId } },
      include: { content: true },
    });
    if (article.content) return article.content;
    return this.prisma.content.create({
      data: {
        ownerId,
        sourceArticleId: article.id,
        title: article.title,
        body: article.mainContent,
        summary: article.description,
        canonicalUrl: article.canonicalUrl,
        contentHash: article.contentHash,
        status: ContentStatus.FETCHED,
      },
    });
  }
}
