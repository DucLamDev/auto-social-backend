import { ContentStatus, VariantStatus } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { ContentVariantsService } from './content-variants.service';

describe('ContentVariantsService immutability', () => {
  it('creates a versioned manual variant for an owned content and enabled platform', async () => {
    const created = { id: 'variant-3', version: 3 };
    let createInput: { data: Record<string, unknown> } | undefined;
    const createVariant = jest.fn((input: { data: Record<string, unknown> }) => {
      createInput = input;
      return Promise.resolve(created);
    });
    const transaction = {
      content: {
        findFirstOrThrow: jest.fn().mockResolvedValue({ id: 'content-1' }),
        update: jest.fn().mockResolvedValue({ id: 'content-1' }),
      },
      platform: {
        findFirstOrThrow: jest.fn().mockResolvedValue({ id: 'platform-1' }),
      },
      contentVariant: {
        aggregate: jest.fn().mockResolvedValue({ _max: { version: 2 } }),
        create: createVariant,
      },
    };
    const prisma = {
      $transaction: jest.fn((callback: (client: typeof transaction) => unknown) => callback(transaction)),
    } as unknown as PrismaService;

    await expect(new ContentVariantsService(prisma).createManual('owner-1', {
      contentId: 'content-1',
      platformSlug: ' DEVTO ',
      title: '  Manual title  ',
      body: '  Markdown body  ',
      hashtags: ['#NodeJS', ' nodejs ', '', 'NestJS'],
    })).resolves.toBe(created);

    expect(transaction.content.findFirstOrThrow).toHaveBeenCalledWith({
      where: { id: 'content-1', ownerId: 'owner-1' },
      select: { id: true },
    });
    expect(transaction.platform.findFirstOrThrow).toHaveBeenCalledWith({
      where: { slug: 'devto', enabled: true },
      select: { id: true },
    });
    expect(transaction.content.update).toHaveBeenCalledWith({
      where: { id: 'content-1' },
      data: { status: ContentStatus.GENERATED },
    });
    expect(createInput?.data).toMatchObject({
      contentId: 'content-1',
      platformId: 'platform-1',
      title: 'Manual title',
      body: 'Markdown body',
      hashtags: ['NodeJS', 'NestJS'],
      status: VariantStatus.GENERATED,
      version: 3,
    });
  });

  it('rejects a blank manual body before starting a transaction', async () => {
    const transaction = jest.fn();
    const prisma = { $transaction: transaction } as unknown as PrismaService;

    await expect(new ContentVariantsService(prisma).createManual('owner-1', {
      contentId: 'content-1',
      platformSlug: 'devto',
      body: '   ',
    })).rejects.toThrow('must not be blank');
    expect(transaction).not.toHaveBeenCalled();
  });

  it('rejects edits once a campaign target references the variant', async () => {
    const updateMany = jest.fn().mockResolvedValue({ count: 0 });
    const findFirstOrThrow = jest.fn().mockResolvedValue({ id: 'variant-1' });
    const prisma = {
      contentVariant: { updateMany, findFirstOrThrow, findUniqueOrThrow: jest.fn() },
    } as unknown as PrismaService;

    await expect(new ContentVariantsService(prisma).updateUnreferenced(
      'owner-1',
      'variant-1',
      { status: VariantStatus.REJECTED },
    )).rejects.toThrow('immutable');
    expect(updateMany).toHaveBeenCalledWith({
      where: {
        id: 'variant-1',
        content: { ownerId: 'owner-1' },
        targets: { none: {} },
      },
      data: { status: VariantStatus.REJECTED },
    });
  });

  it('updates and returns an unreferenced variant', async () => {
    const variant = { id: 'variant-1', body: 'Updated' };
    const prisma = {
      contentVariant: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findUniqueOrThrow: jest.fn().mockResolvedValue(variant),
      },
    } as unknown as PrismaService;

    await expect(new ContentVariantsService(prisma).updateUnreferenced(
      'owner-1',
      'variant-1',
      { body: 'Updated' },
    )).resolves.toBe(variant);
  });
});
