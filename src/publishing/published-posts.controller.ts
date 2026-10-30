import { BadRequestException, Controller, Get, Query } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AuthenticatedUser } from '../auth/auth.types';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { PrismaService } from '../database/prisma.service';
import { ApiOkEnvelope, PublishedPostContractDto } from '../common/swagger/api-contract.dto';
import { ListPublishedPostsQueryDto } from './dto/list-published-posts-query.dto';
import { paginatedData } from '../common/interceptors/api-response.interceptor';

@ApiTags('published-posts')
@ApiBearerAuth()
@Controller('published-posts')
export class PublishedPostsController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  @ApiOkEnvelope(PublishedPostContractDto, true)
  async list(@CurrentUser() user: AuthenticatedUser, @Query() query: ListPublishedPostsQueryDto) {
    if (query.from && query.to && new Date(query.from) > new Date(query.to)) throw new BadRequestException('Ngày bắt đầu phải trước ngày kết thúc.');
    const search = query.search?.trim();
    const where: Prisma.PublishedPostWhereInput = {
      status: 'PUBLISHED',
      job: { status: 'PUBLISHED', target: { campaign: { ownerId: user.id, ...(query.campaignId ? { id: query.campaignId } : {}) } } },
      ...(query.accountId ? { platformAccountId: query.accountId } : {}),
      ...(query.platformId ? { platformAccount: { platformId: query.platformId } } : {}),
      ...(query.from || query.to ? { publishedAt: { ...(query.from ? { gte: new Date(query.from) } : {}), ...(query.to ? { lte: new Date(query.to) } : {}) } } : {}),
      ...(search ? { OR: [
        { url: { contains: search, mode: 'insensitive' } },
        { platformAccount: { name: { contains: search, mode: 'insensitive' } } },
        { platformAccount: { platform: { name: { contains: search, mode: 'insensitive' } } } },
        { job: { target: { campaign: { name: { contains: search, mode: 'insensitive' } } } } },
        { job: { target: { contentVariant: { title: { contains: search, mode: 'insensitive' } } } } },
      ] } : {}),
    };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.publishedPost.findMany({
        where,
        select: {
          id: true, publishJobId: true, platformAccountId: true, externalPostId: true, url: true, status: true, publishedAt: true,
          platformAccount: { select: { id: true, name: true, platform: { select: { id: true, slug: true, name: true } } } },
          job: { select: { id: true, target: { select: { campaign: { select: { id: true, name: true } }, contentVariant: { select: { title: true } } } } } },
        },
        orderBy: [{ publishedAt: 'desc' }, { id: 'desc' }],
        skip: (query.page - 1) * query.limit, take: query.limit,
      }),
      this.prisma.publishedPost.count({ where }),
    ]);
    return paginatedData(items, { page: query.page, limit: query.limit, total, totalPages: Math.ceil(total / query.limit) });
  }
}
