import { MediaType } from '@prisma/client';
import { ApplicationException, ErrorCode } from '../common/exceptions/application.exception';
import { VariantImageService } from './variant-image.service';

const png = { bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), mimeType: 'image/png', model: 'vpsttt-image' };
const draft = (extra: Record<string, unknown> = {}) => ({
  id: 'variant-1', platform: { slug: 'bluesky' }, _count: { targets: 0 },
  mediaRecommendation: { type: 'image', prompt: 'Old prompt', altText: 'Mô tả', size: '1536x1024', status: 'failed' }, ...extra,
});

function setup(variant: unknown = draft(), generate = jest.fn().mockResolvedValue(png), ai?: unknown) {
  const prisma = {
    contentVariant: { findFirst: jest.fn().mockResolvedValue(variant), update: jest.fn((args: { data: { mediaRecommendation: unknown } }) => {
      // The stored request is what the background run compares against.
      if (variant && typeof variant === 'object') Object.assign(variant, { mediaRecommendation: args.data.mediaRecommendation });
      return Promise.resolve({});
    }), updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    mediaAsset: { deleteMany: jest.fn().mockResolvedValue({ count: 1 }), count: jest.fn().mockResolvedValue(0) },
  };
  const media = { storeGeneratedImage: jest.fn().mockResolvedValue({ id: 'media-new' }), removeVariantImage: jest.fn().mockResolvedValue({ removed: true }) };
  const images = { status: () => ({ configured: true, model: 'vpsttt-image' }), generate };
  const service = new VariantImageService(prisma as never, media as never, images as never, ai as never);
  return { service, prisma, media, generate };
}
const settle = () => new Promise((resolve) => { setImmediate(resolve); });

describe('review-time image actions', () => {
  it('regenerates from the edited description, replaces the old image and records the result', async () => {
    const { service, prisma, media, generate } = setup();
    await expect(service.regenerate('owner-1', 'variant-1', { prompt: ' New prompt ' })).resolves.toEqual({ status: 'generating' });
    expect(prisma.contentVariant.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'variant-1', content: { ownerId: 'owner-1' } } }));
    expect(prisma.contentVariant.update).toHaveBeenCalledWith({ where: { id: 'variant-1' }, data: { mediaRecommendation: expect.objectContaining({ status: 'generating', prompt: 'New prompt' }) as unknown } });
    await settle(); await settle();
    expect(generate).toHaveBeenCalledWith('New prompt', '1536x1024');
    expect(media.storeGeneratedImage).toHaveBeenCalledWith('owner-1', 'variant-1', png, { altText: 'Mô tả', prompt: 'New prompt' });
    expect(prisma.mediaAsset.deleteMany).toHaveBeenCalledWith({ where: { variantId: 'variant-1', ownerId: 'owner-1', type: MediaType.IMAGE, id: { not: 'media-new' } } });
    expect(prisma.contentVariant.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { mediaRecommendation: expect.objectContaining({ status: 'generated' }) as unknown } }));
  });

  it('drops an image whose request was replaced by a newer one', async () => {
    let deliver: (image: typeof png) => void = () => undefined;
    const { service, prisma, media } = setup(draft(), jest.fn(() => new Promise<typeof png>((resolve) => { deliver = resolve; })));
    await service.regenerate('owner-1', 'variant-1', { prompt: 'First' });
    // A second "Tạo lại ảnh" replaced the request before the first image came back.
    prisma.contentVariant.findFirst.mockResolvedValue(draft({ mediaRecommendation: { status: 'generating', startedAt: '2099-01-01T00:00:00.000Z' } }));
    deliver(png);
    await settle(); await settle();
    expect(media.storeGeneratedImage).not.toHaveBeenCalled();
    expect(prisma.mediaAsset.deleteMany).not.toHaveBeenCalled();
  });

  it('records a failed generation with its reason', async () => {
    const { service, prisma } = setup(draft(), jest.fn().mockRejectedValue(new ApplicationException(ErrorCode.PLATFORM_RATE_LIMITED, 'VPSTTT AI đang giới hạn lượt tạo ảnh.', 429)));
    await service.regenerate('owner-1', 'variant-1', {});
    await settle(); await settle();
    expect(prisma.contentVariant.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { mediaRecommendation: expect.objectContaining({ status: 'failed', error: 'VPSTTT AI đang giới hạn lượt tạo ảnh.', prompt: 'Old prompt' }) as unknown } }));
  });

  it('refuses a second run while one is generating, a variant in a campaign, and another owner', async () => {
    const generatingNow = draft({ mediaRecommendation: { prompt: 'p', status: 'generating', startedAt: new Date().toISOString() } });
    await expect(setup(generatingNow).service.regenerate('owner-1', 'variant-1', {})).rejects.toThrow('đang được tạo');
    await expect(setup(draft({ _count: { targets: 1 } })).service.regenerate('owner-1', 'variant-1', {})).rejects.toThrow('đã vào chiến dịch');
    await expect(setup(null).service.remove('owner-2', 'variant-1', 'media-1')).rejects.toThrow('not found');
  });

  it('designs the image from the post when it has no description, then draws it', async () => {
    const post = draft({ mediaRecommendation: null, contentId: 'content-1', title: null, body: 'Bài về VPS NVMe' });
    const designImage = jest.fn().mockResolvedValue({ prompt: 'Premium 3D render of an NVMe server', altText: 'Máy chủ NVMe' });
    const { service, prisma, generate, media } = setup(post, jest.fn().mockResolvedValue(png), { designImage });
    await expect(service.regenerate('owner-1', 'variant-1', {})).resolves.toEqual({ status: 'generating' });
    await settle(); await settle(); await settle();
    expect(designImage).toHaveBeenCalledWith('owner-1', {
      contentId: 'content-1', platformSlug: 'bluesky', post: { title: null, body: 'Bài về VPS NVMe' },
      image: { need: 'optional', size: '1536x1024', style: expect.stringContaining('editorial') as unknown },
    });
    expect(generate).toHaveBeenCalledWith('Premium 3D render of an NVMe server', '1536x1024');
    expect(media.storeGeneratedImage).toHaveBeenCalledWith('owner-1', 'variant-1', png, { altText: 'Máy chủ NVMe', prompt: 'Premium 3D render of an NVMe server' });
    // The designed description is recorded before drawing, so the screen can show it.
    expect(prisma.contentVariant.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { mediaRecommendation: expect.objectContaining({ status: 'generating', prompt: 'Premium 3D render of an NVMe server' }) as unknown } }));
  });

  it('still asks for a description when no AI writer is available', async () => {
    await expect(setup(draft({ mediaRecommendation: null })).service.regenerate('owner-1', 'variant-1', {})).rejects.toThrow('Chưa có mô tả ảnh');
  });

  it('marks the variant text-only once its last image is removed', async () => {
    const { service, prisma, media } = setup();
    await service.remove('owner-1', 'variant-1', 'media-1');
    expect(media.removeVariantImage).toHaveBeenCalledWith('owner-1', 'variant-1', 'media-1');
    expect(prisma.contentVariant.update).toHaveBeenCalledWith({ where: { id: 'variant-1' }, data: { mediaRecommendation: expect.objectContaining({ status: 'removed' }) as unknown } });
  });
});
