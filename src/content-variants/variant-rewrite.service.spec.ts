import { VariantStatus } from '@prisma/client';
import { approvalHash } from '../ai/content-approval';
import { ApplicationException, ErrorCode } from '../common/exceptions/application.exception';
import type { VariantApprovalService } from './variant-approval.service';
import { VariantRewriteService } from './variant-rewrite.service';

const updatedAt = new Date('2026-11-04T08:00:00.000Z');
const draft = (extra: Record<string, unknown> = {}) => ({
  id: 'variant-1', contentId: 'content-1', title: null, body: 'Bản cũ', hashtags: ['vps'], recommended: false,
  reason: 'Cần xem lại (AI chấm 5/10): Mở bài chung chung', status: VariantStatus.GENERATED, updatedAt, aiRevision: null,
  mediaRecommendation: { type: 'none' }, platform: { slug: 'bluesky' }, _count: { targets: 0, media: 0 }, ...extra,
});
const revised = { platform: 'bluesky', title: null, body: 'Bản mới có số liệu', summary: null, hashtags: ['vps'], cta: null, recommended: true, reason: 'Hợp người đọc (AI chấm 8/10)', media: { type: 'none', altText: '' } };

function setup(variant: unknown = draft(), reviseDraft = jest.fn().mockResolvedValue(revised), approverOn = false) {
  const prisma = { contentVariant: { findFirst: jest.fn().mockResolvedValue(variant), updateMany: jest.fn().mockResolvedValue({ count: 1 }) } };
  // Claude Opus edits by default (AI_REVISER), whichever writer the campaign used.
  const ai = {
    resolveProvider: jest.fn((provider?: string) => provider ?? 'openai'),
    reviserFor: jest.fn().mockResolvedValue({ provider: 'vpsttt', model: 'claude:opus' }),
    roleLabel: jest.fn(() => 'Claude Opus'),
    assertReady: jest.fn().mockResolvedValue(undefined),
    reviseDraft,
  };
  const rerun = { status: 'running', approver: 'vpsttt:claude:opus', approverLabel: 'Claude Opus', textHash: 'h', startedAt: '2026-11-06T10:00:00.000Z' };
  const approvals = {
    enabled: jest.fn(() => approverOn),
    runningApproval: jest.fn().mockResolvedValue(rerun),
    launch: jest.fn(),
  };
  const service = new VariantRewriteService(prisma as never, ai as never, approvals as unknown as VariantApprovalService);
  return { service, prisma, ai, reviseDraft, approvals, rerun };
}
const settle = () => new Promise((resolve) => { setImmediate(resolve); });
type UpdateCall = [{ where: Record<string, unknown>; data: Record<string, unknown> }];

describe('rewrite one draft with AI', () => {
  it('claims the draft, revises it with the instruction and review notes, and replaces its text in place', async () => {
    const { service, prisma, ai, reviseDraft } = setup();
    await expect(service.start('owner-1', 'variant-1', { instruction: '  Mở bài bằng số liệu  ' })).resolves.toEqual({ status: 'generating' });
    expect(prisma.contentVariant.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'variant-1', content: { ownerId: 'owner-1' } } }));
    // The reviser must be ready, not the campaign's writer.
    expect(ai.reviserFor).toHaveBeenCalledWith('openai');
    expect(ai.assertReady).toHaveBeenCalledWith(['bluesky'], 'vpsttt');
    const claim = (prisma.contentVariant.updateMany.mock.calls[0] as UpdateCall)[0];
    expect(claim.where).toEqual({ id: 'variant-1', updatedAt, targets: { none: {} } });
    expect(claim.data.aiRevision).toMatchObject({ status: 'generating', instruction: 'Mở bài bằng số liệu', provider: 'vpsttt', writerLabel: 'Claude Opus' });
    await settle(); await settle();
    expect(reviseDraft).toHaveBeenCalledWith('owner-1', {
      contentId: 'content-1', platformSlug: 'bluesky', image: null,
      revision: { previous: { title: null, body: 'Bản cũ', hashtags: ['vps'] }, instruction: 'Mở bài bằng số liệu', previousScore: 5, notes: 'Cần xem lại (AI chấm 5/10): Mở bài chung chung' },
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

  it('fixes only the review points the operator chose, in place of the whole last review', async () => {
    const { service, prisma, reviseDraft } = setup();
    await service.start('owner-1', 'variant-1', { notes: ['  Lời mở đầu hơi chung chung ', 'Thêm ví dụ', 'Thêm ví dụ', ' '] });
    expect((prisma.contentVariant.updateMany.mock.calls[0] as UpdateCall)[0].data.aiRevision)
      .toMatchObject({ status: 'generating', instruction: '', notes: ['Lời mở đầu hơi chung chung', 'Thêm ví dụ'] });
    await settle(); await settle();
    expect(reviseDraft).toHaveBeenCalledWith('owner-1', expect.objectContaining({
      // The new version is scored against the stored 5/10.
      revision: { previous: { title: null, body: 'Bản cũ', hashtags: ['vps'] }, instruction: '', previousScore: 5, notes: null, chosenNotes: ['Lời mở đầu hơi chung chung', 'Thêm ví dụ'] },
    }), 'openai');
  });

  it('refuses a request that chose no review point and gave no instruction, or too many points', async () => {
    const empty = setup();
    await expect(empty.service.start('owner-1', 'variant-1', { notes: [' '] })).rejects.toThrow('ít nhất một khuyến nghị');
    expect(empty.prisma.contentVariant.updateMany).not.toHaveBeenCalled();
    // An instruction alone is enough: the review notes are then left out.
    await expect(setup().service.start('owner-1', 'variant-1', { notes: [], instruction: 'Ngắn hơn' })).resolves.toEqual({ status: 'generating' });
    await expect(setup().service.start('owner-1', 'variant-1', { notes: Array.from({ length: 21 }, (_, index) => `Mục ${index}`) })).rejects.toThrow('tối đa 20');
    await expect(setup().service.start('owner-1', 'variant-1', { notes: ['x'.repeat(1_001)] })).rejects.toThrow('1.000 ký tự');
  });

  it('stores the final approver\'s verdict that came with the new text', async () => {
    const approval = { status: 'approved', approver: 'vpsttt:claude:opus', approverLabel: 'Claude Opus', textHash: approvalHash(revised), startedAt: '2026-11-06T10:00:00.000Z', finishedAt: '2026-11-06T10:01:00.000Z' };
    const { service, prisma, approvals } = setup(draft(), jest.fn().mockResolvedValue({ ...revised, approval }), true);
    await service.start('owner-1', 'variant-1', {});
    await settle(); await settle();
    const saved = (prisma.contentVariant.updateMany.mock.calls[1] as UpdateCall)[0];
    expect(saved.data).toMatchObject({ body: 'Bản mới có số liệu', aiApproval: approval });
    // A verdict for exactly this text: no second approver run.
    expect(approvals.launch).not.toHaveBeenCalled();
  });

  it('runs the approver again when the verdict does not match the stored text, and keeps the old verdict when the approver is off', async () => {
    const stale = { status: 'approved', textHash: 'other-text', approver: 'x', approverLabel: 'X', startedAt: '2026-11-06T10:00:00.000Z' };
    const on = setup(draft(), jest.fn().mockResolvedValue({ ...revised, approval: stale }), true);
    await on.service.start('owner-1', 'variant-1', {});
    await settle(); await settle();
    expect(on.approvals.runningApproval).toHaveBeenCalledWith({ title: null, body: 'Bản mới có số liệu', hashtags: ['vps'] });
    expect((on.prisma.contentVariant.updateMany.mock.calls[1] as UpdateCall)[0].data.aiApproval).toBe(on.rerun);
    expect(on.approvals.launch).toHaveBeenCalledWith('owner-1', 'variant-1', on.rerun);

    const off = setup();
    await off.service.start('owner-1', 'variant-1', {});
    await settle(); await settle();
    expect((off.prisma.contentVariant.updateMany.mock.calls[1] as UpdateCall)[0].data).not.toHaveProperty('aiApproval');
    expect(off.approvals.launch).not.toHaveBeenCalled();
  });

  it('does not start an approver run for a rewrite that was dropped', async () => {
    const { service, prisma, approvals } = setup(draft(), jest.fn().mockResolvedValue(revised), true);
    prisma.contentVariant.updateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 });
    await service.start('owner-1', 'variant-1', {});
    await settle(); await settle();
    expect(approvals.launch).not.toHaveBeenCalled();
  });

  it('keeps the stored draft when the edit still fails and scores lower, and says why', async () => {
    const worse = { ...revised, recommended: false, reason: 'Cần xem lại (AI chấm 4/10): Lạc đề' };
    const { service, prisma, approvals } = setup(draft(), jest.fn().mockResolvedValue(worse), true);
    await service.start('owner-1', 'variant-1', { notes: ['Mở bài chung chung'] });
    await settle(); await settle();
    expect(prisma.contentVariant.updateMany).toHaveBeenCalledTimes(2);
    const kept = (prisma.contentVariant.updateMany.mock.calls[1] as UpdateCall)[0];
    expect(kept.data).not.toHaveProperty('body');
    expect(kept.data.aiRevision).toMatchObject({ status: 'failed', error: 'Bản AI sửa chỉ được 4/10, thấp hơn bản hiện tại (5/10), nên giữ nguyên bản hiện tại. Sửa tay hoặc chọn khuyến nghị khác rồi thử lại.' });
    expect(approvals.launch).not.toHaveBeenCalled();
  });

  it('saves an edit that scores lower but passes, or that scores the same', async () => {
    const passing = setup(draft({ reason: 'AI duyệt cuối (Claude Opus) từ chối: Lộ chỉ dẫn (AI chấm 9/10)' }), jest.fn().mockResolvedValue({ ...revised, reason: 'Hợp người đọc (AI chấm 8/10)' }));
    await passing.service.start('owner-1', 'variant-1', {});
    await settle(); await settle();
    expect((passing.prisma.contentVariant.updateMany.mock.calls[1] as UpdateCall)[0].data).toMatchObject({ body: 'Bản mới có số liệu', aiRevision: { status: 'done' } });
    const same = setup(draft(), jest.fn().mockResolvedValue({ ...revised, recommended: false, reason: 'Cần xem lại (AI chấm 5/10): Còn chung chung' }));
    await same.service.start('owner-1', 'variant-1', {});
    await settle(); await settle();
    expect((same.prisma.contentVariant.updateMany.mock.calls[1] as UpdateCall)[0].data).toMatchObject({ body: 'Bản mới có số liệu', aiRevision: { status: 'done' } });
  });

  it('restarts a rewrite left "generating" by a restart after ten minutes', async () => {
    const stale = draft({ aiRevision: { status: 'generating', startedAt: new Date(Date.now() - 11 * 60 * 1000).toISOString() } });
    await expect(setup(stale).service.start('owner-1', 'variant-1', {})).resolves.toEqual({ status: 'generating' });
  });
});
