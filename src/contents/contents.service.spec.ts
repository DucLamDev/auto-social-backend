import { ContentStatus } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { ContentsService } from './contents.service';

describe('ContentsService pagination', () => {
  it('filters and paginates content in PostgreSQL', async () => {
    const findMany = jest.fn().mockResolvedValue([{ id: 'content-21' }]);
    const count = jest.fn().mockResolvedValue(41);
    const prisma = {
      content: { findMany, count },
      $transaction: jest.fn((operations: Array<Promise<unknown>>) => Promise.all(operations)),
    } as unknown as PrismaService;

    const result = await new ContentsService(prisma).list('owner-1', {
      page: 2,
      limit: 20,
      search: ' launch ',
      status: ContentStatus.APPROVED,
      sourceId: 'source-1',
      from: '2026-10-01T00:00:00.000Z',
      to: '2026-10-08T23:59:59.999Z',
    });

    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({
      skip: 20,
      take: 20,
      where: expect.objectContaining({
        ownerId: 'owner-1',
        status: ContentStatus.APPROVED,
        sourceArticle: { sourceId: 'source-1' },
        createdAt: {
          gte: new Date('2026-10-01T00:00:00.000Z'),
          lte: new Date('2026-10-08T23:59:59.999Z'),
        },
      }) as unknown,
      include: expect.objectContaining({ sourceArticle: expect.any(Object) as unknown }) as unknown,
    }));
    expect(count).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      items: [{ id: 'content-21' }],
      pagination: { page: 2, limit: 20, total: 41, totalPages: 3 },
    });
  });
});
