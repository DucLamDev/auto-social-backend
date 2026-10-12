import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { paginatedData } from '../common/interceptors/api-response.interceptor';
import { PrismaService } from '../database/prisma.service';
import { ListPlatformsQueryDto } from './dto/list-platforms-query.dto';

@Injectable()
export class PlatformsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(query: ListPlatformsQueryDto) {
    const search = query.search?.trim();
    const where: Prisma.PlatformWhereInput = {
      ...(query.group ? { groupKey: query.group } : {}),
      ...(query.mode ? { mode: query.mode } : {}),
      ...(query.availability ? { availability: query.availability } : {}),
      ...(query.enabled === undefined ? {} : { enabled: query.enabled }),
      ...(search ? {
        OR: [
          { name: { contains: search, mode: 'insensitive' } },
          { slug: { contains: search, mode: 'insensitive' } },
        ],
      } : {}),
    };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.platform.findMany({
        where,
        include: { capability: true, _count: { select: { accounts: true } } },
        orderBy: [{ groupKey: 'asc' }, { name: 'asc' }],
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
      this.prisma.platform.count({ where }),
    ]);
    return paginatedData(items, {
      page: query.page,
      limit: query.limit,
      total,
      totalPages: total ? Math.ceil(total / query.limit) : 0,
    });
  }

  get(slug: string) {
    return this.prisma.platform.findUniqueOrThrow({
      where: { slug },
      include: { capability: true, _count: { select: { accounts: true } } },
    });
  }

  setEnabled(slug: string, enabled: boolean) {
    return this.prisma.platform.update({ where: { slug }, data: { enabled }, include: { capability: true } });
  }
}
