import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { paginatedData } from '../common/interceptors/api-response.interceptor';
import { PrismaService } from '../database/prisma.service';
import { ListSourceArticlesQueryDto } from './dto/list-source-articles-query.dto';

@Injectable()
export class SourceArticlesService {
  constructor(private readonly prisma: PrismaService) {}

  async list(ownerId: string, query: ListSourceArticlesQueryDto) {
    const search = query.search?.trim();
    const where: Prisma.SourceArticleWhereInput = {
      source: { ownerId },
      ...(query.sourceId ? { sourceId: query.sourceId } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(search ? {
        OR: [
          { title: { contains: search, mode: 'insensitive' } },
          { description: { contains: search, mode: 'insensitive' } },
          { author: { contains: search, mode: 'insensitive' } },
          { source: { name: { contains: search, mode: 'insensitive' } } },
        ],
      } : {}),
    };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.sourceArticle.findMany({
        where,
        include: {
          source: { select: { id: true, name: true, type: true } },
          content: { select: { id: true, status: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
      this.prisma.sourceArticle.count({ where }),
    ]);
    return paginatedData(items, {
      page: query.page,
      limit: query.limit,
      total,
      totalPages: total ? Math.ceil(total / query.limit) : 0,
    });
  }
}
