import { VariantStatus } from '@prisma/client';
import { ApplicationException, ErrorCode } from '../common/exceptions/application.exception';
import { VariantRewriteService } from './variant-rewrite.service';

const updatedAt = new Date('2026-11-04T08:00:00.000Z');
const draft = (extra: Record<string, unknown> = {}) => ({
  id: 'variant-1', contentId: 'content-1', title: null, body: 'Bản cũ', hashtags: ['vps'], recommended: false,
  reason: 'Cần xem lại (AI chấm 5/10): Mở bài chung chung', status: VariantStatus.GENERATED, updatedAt, aiRevision: null,
  mediaRecommendation: { type: 'none' }, platform: { slug: 'bluesky' }, _count: { targets: 0, media: 0 }, ...extra,
});
const revised = { platform: 'bluesky', title: null, body: 'Bản mới có số liệu', summary: null, hashtags: ['vps'], cta: null, recommended: true, reason: 'Hợp người đọc (AI chấm 8/10)', media: { type: 'none', altText: '' } };

function setup(variant: unknown = draft(), reviseDraft = jest.fn().mockResolvedValue(revised)) {
  const prisma = { contentVariant: { findFirst: jest.fn().mockResolvedValue(variant), updateMany: jest.fn().mockResolvedValue({ count: 1 }) } };
  const ai = { resolveProvider: jest.fn((provider?: string) => provider ?? 'openai'), assertReady: jest.fn().mockResolvedValue(undefined), reviseDraft };
  const service = new VariantRewriteService(prisma as never, ai as never);
  return { service, prisma, ai, reviseDraft };
}
const settle = () => new Promise((resolve) => { setImmediate(resolve); });
type UpdateCall = [{ where: Record<string, unknown>; data: Record<string, unknown> }];

describe('rewrite one draft with AI', () => {
  it('claims the draft, revises it with the instruction and review notes, and replaces its text in place', async () => {
    const { service, prisma, ai, reviseDraft } = setup();
    await expect(service.start('owner-1', 'variant-1', { instruction: '  Mở bài bằng số liệu  ' })).resolves.toEqual({ status: 'generating' });
    expect(prisma.contentVariant.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'variant-1', content: { ownerId: 'owner-1' } } }));
    expect(ai.assertReady).toHaveBeenCalledWith(['bluesky'], 'openai');
    const claim = (prisma.contentVariant.updateMany.mock.calls[0] as UpdateCall)[0];
    expect(claim.where).toEqual({ id: 'variant-1', updatedAt, targets: { none: {} } });
    expect(claim.data.aiRevision).toMatchObject({ status: 'generating', instruction: 'Mở bài bằng số liệu' });
    await settle(); await settle();
    expect(reviseDraft).toHaveBeenCalledWith('owner-1', {
      contentId: 'content-1', platformSlug: 'bluesky', image: null,
      revision: { previous: { title: null, body: 'Bản cũ', hashtags: ['vps'] }, instruction: 'Mở bài bằng số liệu', notes: 'Cần xem lại (AI chấm 5/10): Mở bài chung chung' },
    }, 'openai');
    const saved = (prisma.contentVariant.updateMany.mock.calls[1] as UpdateCall)[0];
    // Only if the text is unchanged and this is still the latest request.
    expect(saved.where).toMatchObject({ id: 'variant-1', targets: { none: {} }, title: null, body: 'Bản cũ' });
    expect(saved.data).toMatchObject({ body: 'Bản mới có số liệu', recommended: true, reason: 'Hợp người đọc (AI chấm 8/10)', aiRevision: { status: 'done' } });
    expect(saved.data.status).toBeUndefined();
  });

  it('sends an approved draft back to waiting and tells the writer about its image', async () => {
    const { service, prisma, reviseDraft } = setup(draft({ status: VariantStatus.APPROVED, recommended: true, _count: { targets: 0, media: 1 } }));
    await service.start('owner-1', 'variant-1', {});
    await settle(); await settle();
    expect(reviseDraft).toHaveBeenCalledWith('owner-1', expect.objectContaining({
      image: expect.objectContaining({ size: '1536x1024' }) as unknown,
      revision: expect.objectContaining({ instruction: '', notes: null }) as unknown,
    }), 'openai');
    expect((prisma.contentVariant.updateMany.mock.calls[1] as UpdateCall)[0].data.status).toBe(VariantStatus.GENERATED);
  });

  it('keeps an edit saved meanwhile and records why the rewrite was dropped', async () => {
    const { service, prisma } = setup();
    prisma.contentVariant.updateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 });
    await service.start('owner-1', 'variant-1', {});
    await settle(); await settle();
    const failed = (prisma.contentVariant.updateMany.mock.calls[2] as UpdateCall)[0];
    expect(failed.data.aiRevision).toMatchObject({ status: 'failed', error: expect.stringContaining('giữ nguyên bản hiện tại') as unknown });
  });

  it('records an AI failure with its message', async () => {
    const { service, prisma } = setup(draft(), jest.fn().mockRejectedValue(new ApplicationException(ErrorCode.PLATFORM_RATE_LIMITED, 'VPSTTT AI đang giới hạn lượt.', 429)));
    await service.start('owner-1', 'variant-1', {});
    await settle(); await settle();
    const failed = (prisma.contentVariant.updateMany.mock.calls[1] as UpdateCall)[0];
    expect(failed.data.aiRevision).toMatchObject({ status: 'failed', error: 'VPSTTT AI đang giới hạn lượt.' });
  });

  it('refuses a draft in a campaign, a rejected one, one being rewritten, a changed one, another owner and a long instruction', async () => {
    await expect(setup(draft({ _count: { targets: 1, media: 0 } })).service.start('owner-1', 'variant-1', {})).rejects.toThrow('đã vào chiến dịch');
    await expect(setup(draft({ status: VariantStatus.REJECTED })).service.start('owner-1', 'variant-1', {})).rejects.toThrow('Khôi phục bài');
    await expect(setup(draft({ aiRevision: { status: 'generating', startedAt: new Date().toISOString() } })).service.start('owner-1', 'variant-1', {})).rejects.toThrow('AI đang viết lại');
    const changed = setup();
    changed.prisma.contentVariant.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(changed.service.start('owner-1', 'variant-1', {})).rejects.toThrow('vừa thay đổi');
    expect(changed.reviseDraft).not.toHaveBeenCalled();
    await expect(setup(null).service.start('owner-2', 'variant-1', {})).rejects.toThrow('not found');
    await expect(setup().service.start('owner-1', 'variant-1', { instruction: 'x'.repeat(2_001) })).rejects.toThrow('2.000 ký tự');
  });

  it('restarts a rewrite left "generating" by a restart after ten minutes', async () => {
    const stale = draft({ aiRevision: { status: 'generating', startedAt: new Date(Date.now() - 11 * 60 * 1000).toISOString() } });
    await expect(setup(stale).service.start('owner-1', 'variant-1', {})).resolves.toEqual({ status: 'generating' });
  });
});
