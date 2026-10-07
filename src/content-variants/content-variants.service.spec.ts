import { VariantStatus } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { ContentVariantsService } from './content-variants.service';

describe('ContentVariantsService immutability', () => {
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
