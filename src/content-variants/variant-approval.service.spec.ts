import { VariantStatus } from '@prisma/client';
import { approvalHash, type AiApproval } from '../ai/content-approval';
import { VariantApprovalService } from './variant-approval.service';

const updatedAt = new Date('2026-11-06T08:00:00.000Z');
const draft = (extra: Record<string, unknown> = {}) => ({
  id: 'variant-1', contentId: 'content-1', platformId: 'platform-1', title: 'Tiêu đề', body: 'Bài về VPS', hashtags: ['vps'],
  reason: 'Hợp người đọc (AI chấm 8/10)', status: VariantStatus.GENERATED, updatedAt, aiRevision: null, aiApproval: null,
  mediaRecommendation: { type: 'image', status: 'generated', prompt: 'Máy chủ trong phòng sáng', altText: 'Máy chủ' },
  platform: { slug: 'discourse' }, _count: { targets: 0 }, ...extra,
});
const settle = () => new Promise((resolve) => { setImmediate(resolve); });
const settleAll = async () => { for (let index = 0; index < 5; index += 1) await settle(); };
type UpdateCall = [{ where: Record<string, unknown>; data: { aiApproval: AiApproval } }];

function setup(variant: Record<string, unknown> = draft(), options: { enabled?: boolean; approveDraft?: jest.Mock; counts?: number[] } = {}) {
  // The stored approval follows the claim, as the database would.
  let stored: unknown = variant.aiApproval;
  let calls = 0;
  const prisma = {
    contentVariant: {
      findFirst: jest.fn(() => Promise.resolve({ ...variant, aiApproval: stored })),
      // `counts`: rows each successive update changes (1 by default).
      updateMany: jest.fn((input: { data: { aiApproval?: unknown } }) => {
        calls += 1;
        const count = options.counts?.[calls - 1] ?? 1;
        if (calls === 1 && count) stored = input.data.aiApproval;
        return Promise.resolve({ count });
      }),
    },
    platformAccount: { findMany: jest.fn().mockResolvedValue([{ settings: { delivery: 'extension', extensionEngine: 'discourse' } }]) },
  };
  const verdict = (input: { title: string | null; body: string; hashtags: string[] }): AiApproval => ({
    status: 'approved', approver: 'vpsttt:claude:opus', approverLabel: 'Claude Opus', textHash: approvalHash(input), score: 9, risk: 'none', seeding: false, reasons: [],
    startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), error: null,
  });
  const approveDraft = options.approveDraft ?? jest.fn((_owner: string, input: { title: string | null; body: string; hashtags: string[] }) => Promise.resolve(verdict(input)));
  const ai = {
    approvalEnabled: jest.fn(() => options.enabled ?? true),
    roles: jest.fn().mockResolvedValue({ approver: { provider: 'vpsttt', model: 'claude:opus', label: 'Claude Opus', configured: true } }),
    approveDraft,
  };
  const service = new VariantApprovalService(prisma as never, ai as never);
  return { service, prisma, ai, approveDraft };
}

describe('final AI approval of one draft', () => {
  it('claims the draft, sends its current text to the approver after the response, and stores the verdict', async () => {
    const { service, prisma, approveDraft } = setup();
    await expect(service.start('owner-1', 'variant-1')).resolves.toEqual({ status: 'running' });
    expect(prisma.contentVariant.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'variant-1', content: { ownerId: 'owner-1' } } }));
    const claim = (prisma.contentVariant.updateMany.mock.calls[0] as UpdateCall)[0];
    expect(claim.where).toEqual({ id: 'variant-1', updatedAt, targets: { none: {} } });
    expect(claim.data.aiApproval).toMatchObject({
      status: 'running', approver: 'vpsttt:claude:opus', approverLabel: 'Claude Opus',
      textHash: approvalHash({ title: 'Tiêu đề', body: 'Bài về VPS', hashtags: ['vps'] }),
    });
    await settleAll();
    expect(approveDraft).toHaveBeenCalledWith('owner-1', {
      contentId: 'content-1', platformSlug: 'discourse', engine: 'discourse',
      title: 'Tiêu đề', body: 'Bài về VPS', hashtags: ['vps'],
      image: { prompt: 'Máy chủ trong phòng sáng', altText: 'Máy chủ' },
      reviewNotes: 'Hợp người đọc (AI chấm 8/10)',
    });
    const saved = (prisma.contentVariant.updateMany.mock.calls[1] as UpdateCall)[0];
    // Only for the text the approver read, and only if this run is still the latest.
    expect(saved.where).toEqual({
      id: 'variant-1', title: 'Tiêu đề', body: 'Bài về VPS', hashtags: { equals: ['vps'] },
      aiApproval: { path: ['startedAt'], equals: claim.data.aiApproval.startedAt },
    });
    expect(saved.data.aiApproval).toMatchObject({ status: 'approved', score: 9, startedAt: claim.data.aiApproval.startedAt, textHash: claim.data.aiApproval.textHash });
  });

  it('drops the verdict when the text changed meanwhile and records why', async () => {
    const { service, prisma } = setup(draft(), { counts: [1, 0] });
    await service.start('owner-1', 'variant-1');
    await settleAll();
    const failed = (prisma.contentVariant.updateMany.mock.calls[2] as UpdateCall)[0];
    expect(failed.where).toMatchObject({ id: 'variant-1', aiApproval: { path: ['startedAt'] } });
    expect(failed.data.aiApproval).toMatchObject({ status: 'failed', error: 'Bài đã sửa trong lúc AI duyệt; bấm Cho AI duyệt lại.' });
  });

  it('does not run when a newer run replaced the claim before it started', async () => {
    const { service, prisma, approveDraft } = setup();
    prisma.contentVariant.findFirst.mockImplementationOnce(() => Promise.resolve({ ...draft(), aiApproval: { status: 'running', textHash: 'x', startedAt: 'another-run' } }));
    service.launch('owner-1', 'variant-1', { status: 'running', approver: '', approverLabel: '', textHash: 'x', startedAt: 'this-run' });
    await settleAll();
    expect(approveDraft).not.toHaveBeenCalled();
    expect(prisma.contentVariant.updateMany).not.toHaveBeenCalled();
  });

  it('stores the approver\'s own failure, and records an unexpected error', async () => {
    const failedVerdict = { status: 'failed', approver: 'vpsttt:claude:opus', approverLabel: 'Claude Opus', textHash: 'ignored', startedAt: 'x', finishedAt: 'y', error: 'Key VPSTTT AI không được dùng model này.' };
    const failing = setup(draft(), { approveDraft: jest.fn().mockResolvedValue(failedVerdict) });
    await failing.service.start('owner-1', 'variant-1');
    await settleAll();
    expect((failing.prisma.contentVariant.updateMany.mock.calls[1] as UpdateCall)[0].data.aiApproval).toMatchObject({ status: 'failed', error: 'Key VPSTTT AI không được dùng model này.' });

    const broken = setup(draft(), { approveDraft: jest.fn().mockRejectedValue(new Error('socket hang up')) });
    await broken.service.start('owner-1', 'variant-1');
    await settleAll();
    expect((broken.prisma.contentVariant.updateMany.mock.calls[1] as UpdateCall)[0].data.aiApproval).toMatchObject({ status: 'failed', error: 'Không chạy được AI duyệt cuối.' });
  });

  it('leaves the engine out when the platform\'s accounts post in different ways', async () => {
    const { service, prisma, approveDraft } = setup(draft({ mediaRecommendation: { type: 'none' } }));
    prisma.platformAccount.findMany.mockResolvedValue([{ settings: { delivery: 'extension', extensionEngine: 'discourse' } }, { settings: {} }]);
    await service.start('owner-1', 'variant-1');
    await settleAll();
    expect(approveDraft).toHaveBeenCalledWith('owner-1', expect.objectContaining({ engine: undefined, image: null }));
  });

  it('refuses when the approver is off, the draft is in a campaign, rejected, being read or rewritten, or changed', async () => {
    await expect(setup(draft(), { enabled: false }).service.start('owner-1', 'variant-1')).rejects.toThrow('AI duyệt cuối đang tắt');
    await expect(setup(draft({ _count: { targets: 1 } })).service.start('owner-1', 'variant-1')).rejects.toThrow('đã vào chiến dịch');
    await expect(setup(draft({ status: VariantStatus.REJECTED })).service.start('owner-1', 'variant-1')).rejects.toThrow('Khôi phục bài');
    const running = { status: 'running', textHash: approvalHash({ title: 'Tiêu đề', body: 'Bài về VPS', hashtags: ['vps'] }), startedAt: new Date().toISOString() };
    await expect(setup(draft({ aiApproval: running })).service.start('owner-1', 'variant-1')).rejects.toThrow('đang đọc bài này');
    await expect(setup(draft({ aiRevision: { status: 'generating', startedAt: new Date().toISOString() } })).service.start('owner-1', 'variant-1')).rejects.toThrow('AI đang viết lại');
    const changed = setup(draft(), { counts: [0] });
    await expect(changed.service.start('owner-1', 'variant-1')).rejects.toThrow('vừa thay đổi');
    expect(changed.approveDraft).not.toHaveBeenCalled();
    const missing = setup();
    missing.prisma.contentVariant.findFirst.mockResolvedValueOnce(null as never);
    await expect(missing.service.start('owner-2', 'variant-1')).rejects.toThrow('not found');
  });

  it('restarts an approval left "running" by a restart after ten minutes', async () => {
    const stale = { status: 'running', textHash: approvalHash({ title: 'Tiêu đề', body: 'Bài về VPS', hashtags: ['vps'] }), startedAt: new Date(Date.now() - 11 * 60 * 1000).toISOString() };
    await expect(setup(draft({ aiApproval: stale })).service.start('owner-1', 'variant-1')).resolves.toEqual({ status: 'running' });
  });
});
