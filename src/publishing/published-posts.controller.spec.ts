import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { AuthenticatedUser } from '../auth/auth.types';
import { PrismaService } from '../database/prisma.service';
import { ListPublishedPostsQueryDto } from './dto/list-published-posts-query.dto';
import { PublishedPostsController } from './published-posts.controller';

describe('Published post history', () => {
  const user: AuthenticatedUser = { id: 'owner', email: 'owner@example.com', displayName: 'Owner', roles: [] };
  const findMany = jest.fn<Promise<unknown[]>, [Prisma.PublishedPostFindManyArgs]>();
  const count = jest.fn<Promise<number>, [Prisma.PublishedPostCountArgs]>();
  const prisma = {
    publishedPost: { findMany, count },
    $transaction: (operations: Promise<unknown>[]) => Promise.all(operations),
  } as unknown as PrismaService;
  const controller = new PublishedPostsController(prisma);

  beforeEach(() => { findMany.mockReset().mockResolvedValue([]); count.mockReset().mockResolvedValue(0); });

  it('scopes every page and count to the owner and confirmed published results', async () => {
    const query = Object.assign(new ListPublishedPostsQueryDto(), { page: 9, limit: 25, search: ' NGINX ' });
    count.mockResolvedValue(230);
    const result = await controller.list(user, query);
    expect(result.pagination).toEqual({ page: 9, limit: 25, total: 230, totalPages: 10 });
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({
      skip: 200, take: 25,
      orderBy: [{ publishedAt: 'desc' }, { id: 'desc' }],
    }));
    const args = findMany.mock.calls[0]?.[0];
    if (!args) throw new Error('Expected a published history query');
    expect(args.where).toMatchObject({ status: 'PUBLISHED', job: { status: 'PUBLISHED', target: { campaign: { ownerId: 'owner' } } } });
    expect(count).toHaveBeenCalledWith({ where: args.where });
    expect(args.where?.OR).toContainEqual({ job: { target: { contentVariant: { title: { contains: 'NGINX', mode: 'insensitive' } } } } });
    expect(JSON.stringify(args.select)).not.toContain('credential');
    expect(args.select).not.toHaveProperty('metadata');
  });

  it('combines account, platform, campaign and dates without losing ownership checks', async () => {
    await controller.list(user, Object.assign(new ListPublishedPostsQueryDto(), {
      platformId: 'platform', accountId: 'account', campaignId: 'campaign',
      from: '2026-10-01T00:00:00Z', to: '2026-10-31T23:59:59Z',
    }));
    expect(findMany.mock.calls[0]?.[0].where).toMatchObject({
      platformAccountId: 'account', platformAccount: { platformId: 'platform' },
      job: { target: { campaign: { ownerId: 'owner', id: 'campaign' } } },
      publishedAt: { gte: new Date('2026-10-01T00:00:00Z'), lte: new Date('2026-10-31T23:59:59Z') },
    });
  });

  it('rejects invalid filters and inverted dates before querying', async () => {
    const invalid = plainToInstance(ListPublishedPostsQueryDto, { page: 0, limit: 1001, accountId: 'invalid', from: 'yesterday' });
    expect((await validate(invalid)).map((error) => error.property)).toEqual(expect.arrayContaining(['page', 'limit', 'accountId', 'from']));
    await expect(controller.list(user, Object.assign(new ListPublishedPostsQueryDto(), {
      from: '2026-10-31T00:00:00Z', to: '2026-10-01T00:00:00Z',
    }))).rejects.toBeInstanceOf(BadRequestException);
    expect(findMany).not.toHaveBeenCalled();
  });
});
