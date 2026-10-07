import { SourceArticleStatus } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { SourceArticlesService } from './source-articles.service';

describe('SourceArticlesService', () => {
  it('filters owner-scoped articles in PostgreSQL and returns pagination metadata', async () => {
    const findMany = jest.fn().mockResolvedValue([{ id: 'article-1' }]);
    const count = jest.fn().mockResolvedValue(21);
    const prisma = {
      sourceArticle: { findMany, count },
      $transaction: jest.fn((operations: Array<Promise<unknown>>) => Promise.all(operations)),
    } as unknown as PrismaService;
    const service = new SourceArticlesService(prisma);

    await expect(service.list('owner-1', {
      page: 2,
      limit: 20,
      search: 'release',
      status: SourceArticleStatus.FETCHED,
      sourceId: '00000000-0000-4000-8000-000000000001',
    })).resolves.toEqual({
      items: [{ id: 'article-1' }],
      pagination: { page: 2, limit: 20, total: 21, totalPages: 2 },
    });
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({
      skip: 20,
      take: 20,
      where: expect.objectContaining({
        source: { ownerId: 'owner-1' },
        sourceId: '00000000-0000-4000-8000-000000000001',
        status: SourceArticleStatus.FETCHED,
      }) as unknown,
    }));
  });
});
