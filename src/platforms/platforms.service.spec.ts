import { PlatformAvailability, PlatformMode } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { PlatformsService } from './platforms.service';

describe('PlatformsService', () => {
  it('paginates and applies catalog filters and search', async () => {
    const item = {
      id: 'platform-1',
      slug: 'medium',
      name: 'Medium',
      connectorKey: 'manual',
      groupKey: 'BLOGGING',
      defaultSettings: { manualUrl: 'https://medium.com/new-story' },
    };
    const findMany = jest.fn().mockResolvedValue([item]);
    const count = jest.fn().mockResolvedValue(21);
    const prisma = {
      platform: { findMany, count },
      $transaction: jest.fn((operations: Array<Promise<unknown>>) => Promise.all(operations)),
    } as unknown as PrismaService;

    const result = await new PlatformsService(prisma).list({
      page: 2,
      limit: 10,
      search: ' med ',
      group: 'BLOGGING',
      mode: PlatformMode.MANUAL,
      availability: PlatformAvailability.MANUAL_ONLY,
      enabled: true,
    });

    const where = {
      groupKey: 'BLOGGING',
      mode: PlatformMode.MANUAL,
      availability: PlatformAvailability.MANUAL_ONLY,
      enabled: true,
      OR: [
        { name: { contains: 'med', mode: 'insensitive' } },
        { slug: { contains: 'med', mode: 'insensitive' } },
      ],
    };
    expect(findMany).toHaveBeenCalledWith({
      where,
      include: { capability: true, _count: { select: { accounts: true } } },
      orderBy: [{ groupKey: 'asc' }, { name: 'asc' }],
      skip: 10,
      take: 10,
    });
    expect(count).toHaveBeenCalledWith({ where });
    expect(result).toEqual({
      items: [item],
      pagination: { page: 2, limit: 10, total: 21, totalPages: 3 },
    });
  });
});
