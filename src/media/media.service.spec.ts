import { MediaType } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { StorageService } from '../storage/storage.service';
import { MediaService } from './media.service';

describe('MediaService variant immutability', () => {
  it('filters and paginates media in PostgreSQL before returning assets', async () => {
    const findMany = jest.fn().mockResolvedValue([{ id: 'media-1' }]);
    const count = jest.fn().mockResolvedValue(1);
    const prisma = {
      mediaAsset: { findMany, count },
      $transaction: jest.fn((operations: Array<Promise<unknown>>) => Promise.all(operations)),
    } as unknown as PrismaService;
    const service = new MediaService(prisma, {} as StorageService);

    await expect(service.list('owner-1', {
      page: 1,
      limit: 20,
      variantId: '00000000-0000-4000-8000-000000000001',
    })).resolves.toEqual({
      items: [{ id: 'media-1' }],
      pagination: { page: 1, limit: 20, total: 1, totalPages: 1 },
    });
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { ownerId: 'owner-1', variantId: '00000000-0000-4000-8000-000000000001' },
      skip: 0,
      take: 20,
    }));
  });

  it('does not attach media to a variant already referenced by a campaign', async () => {
    const prisma = {
      contentVariant: {
        findFirstOrThrow: jest.fn().mockResolvedValue({ id: 'variant-1', _count: { targets: 1 } }),
      },
    } as unknown as PrismaService;
    const put = jest.fn();
    const service = new MediaService(prisma, { put } as unknown as StorageService);
    const buffer = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const file = {
      mimetype: 'image/png',
      size: buffer.length,
      buffer,
      originalname: 'test.png',
    } as Express.Multer.File;

    await expect(service.upload('owner-1', file, undefined, 'variant-1')).rejects.toThrow(
      'Media cannot be attached',
    );
    expect(put).not.toHaveBeenCalled();
  });

  it('does not attach canonical content media after the content is used by a campaign', async () => {
    const prisma = {
      content: {
        findFirstOrThrow: jest.fn().mockResolvedValue({ id: 'content-1', _count: { campaigns: 1 } }),
      },
    } as unknown as PrismaService;
    const put = jest.fn();
    const service = new MediaService(prisma, { put } as unknown as StorageService);
    const buffer = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const file = {
      mimetype: 'image/png', size: buffer.length, buffer, originalname: 'test.png',
    } as Express.Multer.File;

    await expect(service.upload('owner-1', file, 'content-1')).rejects.toThrow(
      'Media cannot be attached after content has been added',
    );
    expect(put).not.toHaveBeenCalled();
  });

  it('rejects a spoofed MIME type before writing to storage', async () => {
    const put = jest.fn();
    const service = new MediaService({} as PrismaService, { put } as unknown as StorageService);
    const file = {
      mimetype: 'image/png', size: 8, buffer: Buffer.from('not-a-png'), originalname: 'attack.png',
    } as Express.Multer.File;

    await expect(service.upload('owner-1', file)).rejects.toThrow('bytes do not match');
    expect(put).not.toHaveBeenCalled();
  });

  it('uses a canonical extension derived from verified bytes and MIME type', async () => {
    const put = jest
      .fn<Promise<string>, [storageKey: string, body: Buffer, contentType: string]>()
      .mockResolvedValue('https://cdn.example/media.png');
    const create = jest
      .fn<Promise<Record<string, unknown>>, [{ data: Record<string, unknown> }]>()
      .mockImplementation(({ data }) => Promise.resolve(data));
    const prisma = { mediaAsset: { create } } as unknown as PrismaService;
    const service = new MediaService(prisma, { put } as unknown as StorageService);
    const buffer = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const file = {
      mimetype: 'image/png', size: buffer.length, buffer, originalname: 'misleading.jpg',
    } as Express.Multer.File;

    await service.upload('owner-1', file);

    const storageKey = put.mock.calls[0]?.[0];
    expect(storageKey).toBeDefined();
    expect(storageKey).toMatch(/\.png$/);
    expect(storageKey).not.toMatch(/\.jpg$/);
    expect(put).toHaveBeenCalledWith(storageKey, buffer, 'image/png');
    expect(create.mock.calls[0]?.[0].data).toMatchObject({ storageKey, type: MediaType.IMAGE });
  });

  it('stores normalized alt text only in media metadata', async () => {
    const create = jest
      .fn<Promise<Record<string, unknown>>, [{ data: Record<string, unknown> }]>()
      .mockImplementation(({ data }) => Promise.resolve(data));
    const prisma = { mediaAsset: { create } } as unknown as PrismaService;
    const storage = {
      put: jest.fn().mockResolvedValue('https://cdn.example/media.png'),
    } as unknown as StorageService;
    const service = new MediaService(prisma, storage);
    const buffer = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const file = {
      mimetype: 'image/png', size: buffer.length, buffer, originalname: 'diagram.png',
    } as Express.Multer.File;

    await service.upload('owner-1', file, undefined, undefined, '  Service architecture diagram  ');

    const data = create.mock.calls[0]?.[0].data;
    expect(data).toMatchObject({ metadata: { altText: 'Service architecture diagram' } });
    expect(data).not.toHaveProperty('altText');
  });

  describe('AI-generated variant images', () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01]);
    const image = { bytes: png, mimeType: 'image/png', model: 'vpsttt-image' };

    it('stores the image on the draft variant with its alt text and prompt', async () => {
      const create = jest.fn(({ data }: { data: Record<string, unknown> }) => Promise.resolve(data));
      const findFirst = jest.fn().mockResolvedValue({ id: 'variant-1', _count: { targets: 0 } });
      const put = jest.fn().mockResolvedValue('https://cdn.example/media.png');
      const service = new MediaService({ mediaAsset: { create }, contentVariant: { findFirst } } as unknown as PrismaService, { put } as unknown as StorageService);

      await service.storeGeneratedImage('owner-1', 'variant-1', image, { altText: ' Bảng điều khiển VPS ', prompt: 'A calm VPS dashboard' });

      expect(findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'variant-1', content: { ownerId: 'owner-1' } } }));
      expect(put).toHaveBeenCalledWith(expect.stringMatching(/^media\/.+\.png$/), png, 'image/png');
      expect(create.mock.calls[0]?.[0].data).toMatchObject({ ownerId: 'owner-1', variantId: 'variant-1', type: MediaType.IMAGE,
        metadata: { altText: 'Bảng điều khiển VPS', generated: true, model: 'vpsttt-image', prompt: 'A calm VPS dashboard' } });
    });

    it('never changes images of a variant already in a campaign, or of another owner', async () => {
      const put = jest.fn();
      const inCampaign = new MediaService({ contentVariant: { findFirst: jest.fn().mockResolvedValue({ id: 'variant-1', _count: { targets: 1 } }) } } as unknown as PrismaService, { put } as unknown as StorageService);
      await expect(inCampaign.storeGeneratedImage('owner-1', 'variant-1', image, { prompt: 'p' })).rejects.toThrow('cannot change');
      const foreign = new MediaService({ contentVariant: { findFirst: jest.fn().mockResolvedValue(null) } } as unknown as PrismaService, { put } as unknown as StorageService);
      await expect(foreign.removeVariantImage('owner-2', 'variant-1', 'media-1')).rejects.toThrow('not found');
      expect(put).not.toHaveBeenCalled();
    });

    it('removes only an image of that variant and owner', async () => {
      const deleteMany = jest.fn().mockResolvedValue({ count: 1 });
      const service = new MediaService({ mediaAsset: { deleteMany }, contentVariant: { findFirst: jest.fn().mockResolvedValue({ id: 'variant-1', _count: { targets: 0 } }) } } as unknown as PrismaService, {} as StorageService);
      await expect(service.removeVariantImage('owner-1', 'variant-1', 'media-1')).resolves.toEqual({ removed: true });
      expect(deleteMany).toHaveBeenCalledWith({ where: { id: 'media-1', ownerId: 'owner-1', variantId: 'variant-1', type: MediaType.IMAGE } });
    });
  });

  it('rejects alt text over 1000 characters before writing to storage', async () => {
    const put = jest.fn();
    const service = new MediaService({} as PrismaService, { put } as unknown as StorageService);
    const buffer = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const file = {
      mimetype: 'image/png', size: buffer.length, buffer, originalname: 'diagram.png',
    } as Express.Multer.File;

    await expect(service.upload('owner-1', file, undefined, undefined, 'a'.repeat(1_001)))
      .rejects.toThrow('Media alt text exceeds 1000 characters');
    expect(put).not.toHaveBeenCalled();
  });
});
