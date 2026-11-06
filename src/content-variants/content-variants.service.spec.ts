import { BadRequestException } from '@nestjs/common';
import { ContentStatus, VariantStatus } from '@prisma/client';
import { approvalHash } from '../ai/content-approval';
import { PrismaService } from '../database/prisma.service';
import { ContentVariantsService } from './content-variants.service';
import type { VariantApprovalService } from './variant-approval.service';

/** The final AI approver turned off: these tests cover the checks that do not depend on it. */
const approverOff = { enabled: () => false } as unknown as VariantApprovalService;

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

    await expect(new ContentVariantsService(prisma, approverOff).createManual('owner-1', {
      contentId: 'content-1',
      platformSlug: ' DEVTO ',
      title: '  Manual title  ',
      body: '  Markdown body  ',
      hashtags: ['#NodeJS', ' nodejs ', '', 'NestJS'],
    // Responses carry whether the stored AI approval matches the text (none here).
    })).resolves.toEqual({ ...created, aiApprovalCurrent: false });

    expect(transaction.content.findFirstOrThrow).toHaveBeenCalledWith({
      where: { id: 'content-1', ownerId: 'owner-1' },
      select: { id: true, canonicalUrl: true },
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

    await expect(new ContentVariantsService(prisma, approverOff).createManual('owner-1', {
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

    await expect(new ContentVariantsService(prisma, approverOff).updateUnreferenced(
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
        // The stored post, read to check that the edited text still fits its platform.
        findFirst: jest.fn().mockResolvedValue({ title: 'T', body: 'Old', hashtags: [], platform: { slug: 'devto' }, content: { canonicalUrl: null } }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findUniqueOrThrow: jest.fn().mockResolvedValue(variant),
      },
    } as unknown as PrismaService;

    await expect(new ContentVariantsService(prisma, approverOff).updateUnreferenced(
      'owner-1',
      'variant-1',
      { body: 'Updated' },
    )).resolves.toEqual({ ...variant, aiApprovalCurrent: false });
  });

  describe('posts over the character limit', () => {
    const source = 'https://vpsttt.vn/blog/vps';
    const stored = { title: null, body: 'Bài Mastodon ngắn.', hashtags: ['vps'], platform: { slug: 'mastodon' }, content: { canonicalUrl: source } };
    function editable() {
      const contentVariant = {
        findFirst: jest.fn().mockResolvedValue(stored),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findUniqueOrThrow: jest.fn().mockResolvedValue({ id: 'variant-1' }),
      };
      return { contentVariant, service: new ContentVariantsService({ contentVariant } as unknown as PrismaService, approverOff) };
    }

    it('refuses a manual Mastodon post that would be 545/500 characters with its source line', async () => {
      const create = jest.fn();
      const transaction = {
        content: { findFirstOrThrow: jest.fn().mockResolvedValue({ id: 'content-1', canonicalUrl: source }), update: jest.fn() },
        platform: { findFirstOrThrow: jest.fn().mockResolvedValue({ id: 'platform-1' }) },
        contentVariant: { aggregate: jest.fn(), create },
      };
      const prisma = { $transaction: jest.fn((callback: (client: typeof transaction) => unknown) => callback(transaction)) } as unknown as PrismaService;
      // 513 characters + a blank line, "Nguồn: " and the link counted as 23.
      await expect(new ContentVariantsService(prisma, approverOff).createManual('owner-1', { contentId: 'content-1', platformSlug: 'mastodon', body: 'ạ'.repeat(513) }))
        .rejects.toThrow(new BadRequestException('Bài Mastodon dài 545/500 ký tự, vượt giới hạn của nền tảng. Rút gọn trước khi duyệt hoặc đăng.'));
      expect(transaction.content.update).not.toHaveBeenCalled();
      expect(create).not.toHaveBeenCalled();
    });

    it('refuses an edit that makes the post too long, and checks it with the stored hashtags and source', async () => {
      const { contentVariant, service } = editable();
      await expect(service.updateUnreferenced('owner-1', 'variant-1', { body: 'ạ'.repeat(470) }))
        .rejects.toThrow('Bài Mastodon dài 502/500 ký tự');
      expect(contentVariant.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'variant-1', content: { ownerId: 'owner-1' } } }));
      expect(contentVariant.updateMany).not.toHaveBeenCalled();
      await expect(service.updateUnreferenced('owner-1', 'variant-1', { body: 'ạ'.repeat(460) })).resolves.toMatchObject({ id: 'variant-1' });
    });

    it('refuses to approve a stored post that is too long, but lets it be rejected or annotated', async () => {
      const { contentVariant, service } = editable();
      contentVariant.findFirst.mockResolvedValue({ ...stored, body: 'ạ'.repeat(600) });
      await expect(service.updateUnreferenced('owner-1', 'variant-1', { status: VariantStatus.APPROVED })).rejects.toBeInstanceOf(BadRequestException);
      expect(contentVariant.updateMany).not.toHaveBeenCalled();
      await service.updateUnreferenced('owner-1', 'variant-1', { status: VariantStatus.REJECTED });
      await service.updateUnreferenced('owner-1', 'variant-1', { summary: 'Ghi chú' });
      expect(contentVariant.findFirst).toHaveBeenCalledTimes(1);
      expect(contentVariant.updateMany).toHaveBeenCalledTimes(2);
    });
  });
});

describe('ContentVariantsService and the final AI approver', () => {
  const stored = { title: 'Tiêu đề', body: 'Bài về VPS', hashtags: ['vps'] };
  const verdict = (status: string, extra: Record<string, unknown> = {}) => ({
    status, approver: 'vpsttt:claude:opus', approverLabel: 'Claude Opus', textHash: approvalHash(stored), startedAt: new Date().toISOString(), ...extra,
  });
  const running = { status: 'running', approver: 'vpsttt:claude:opus', approverLabel: 'Claude Opus', textHash: 'new-text', startedAt: '2026-11-06T10:00:00.000Z' };

  function setup(aiApproval: unknown, enabled = true, status: VariantStatus = VariantStatus.GENERATED) {
    const contentVariant = {
      findFirst: jest.fn().mockResolvedValue({ ...stored, status, aiApproval, platform: { slug: 'devto' }, content: { canonicalUrl: null } }),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      findUniqueOrThrow: jest.fn((input: unknown) => Promise.resolve({ id: 'variant-1', ...stored, aiApproval, input })),
    };
    const approvals = { enabled: jest.fn(() => enabled), runningApproval: jest.fn().mockResolvedValue(running), launch: jest.fn() };
    const service = new ContentVariantsService({ contentVariant } as unknown as PrismaService, approvals as unknown as VariantApprovalService);
    return { service, contentVariant, approvals };
  }

  it('sends edited text to the approver again with the edit, after the response', async () => {
    const { service, contentVariant, approvals } = setup(verdict('approved'));
    await service.updateUnreferenced('owner-1', 'variant-1', { body: 'Bài về VPS, đã sửa' });
    expect(approvals.runningApproval).toHaveBeenCalledWith({ title: 'Tiêu đề', body: 'Bài về VPS, đã sửa', hashtags: ['vps'] });
    expect(contentVariant.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { body: 'Bài về VPS, đã sửa', aiApproval: running } }));
    expect(approvals.launch).toHaveBeenCalledWith('owner-1', 'variant-1', running);
  });

  it('reports the old verdict as no longer current once the text changed', async () => {
    const { service, contentVariant } = setup(verdict('approved'));
    contentVariant.findUniqueOrThrow.mockResolvedValue({ id: 'variant-1', ...stored, body: 'Bài về VPS, đã sửa', aiApproval: verdict('approved') } as never);
    await expect(service.updateUnreferenced('owner-1', 'variant-1', { body: 'Bài về VPS, đã sửa' })).resolves.toMatchObject({ aiApprovalCurrent: false });
    contentVariant.findUniqueOrThrow.mockResolvedValue({ id: 'variant-1', ...stored, aiApproval: verdict('approved') } as never);
    await expect(service.updateUnreferenced('owner-1', 'variant-1', { summary: 'Ghi chú' })).resolves.toMatchObject({ aiApprovalCurrent: true });
  });

  it('does not re-run the approver for an edit that leaves the text the same, a rejected draft, or with the approver off', async () => {
    const same = setup(verdict('approved'));
    await same.service.updateUnreferenced('owner-1', 'variant-1', { hashtags: ['#VPS'], summary: 'Tóm tắt' });
    await same.service.updateUnreferenced('owner-1', 'variant-1', { cta: 'Xem thêm' });
    expect(same.approvals.launch).not.toHaveBeenCalled();
    const rejected = setup(verdict('approved'), true, VariantStatus.REJECTED);
    await rejected.service.updateUnreferenced('owner-1', 'variant-1', { body: 'Đã sửa' });
    expect(rejected.approvals.launch).not.toHaveBeenCalled();
    const off = setup(null, false);
    await off.service.updateUnreferenced('owner-1', 'variant-1', { body: 'Đã sửa' });
    expect(off.approvals.runningApproval).not.toHaveBeenCalled();
    expect(off.contentVariant.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { body: 'Đã sửa' } }));
  });

  it('refuses "Duyệt" in Studio with the approver\'s reason unless it approved this text', async () => {
    const cases: Array<[unknown, string]> = [
      [null, 'Chưa được AI duyệt cuối; bấm Cho AI duyệt.'],
      [verdict('running'), 'AI duyệt cuối đang đọc bài…'],
      [verdict('rejected', { reasons: ['Giả làm khách hàng'] }), 'AI duyệt cuối (Claude Opus) từ chối: Giả làm khách hàng'],
      [verdict('failed', { error: 'Hết lượt.' }), 'AI duyệt cuối chưa chạy được: Hết lượt.'],
      [verdict('approved', { textHash: 'older-text' }), 'Bài đã sửa sau khi AI duyệt; đang chờ duyệt lại.'],
    ];
    for (const [aiApproval, message] of cases) {
      const { service, contentVariant } = setup(aiApproval);
      await expect(service.updateUnreferenced('owner-1', 'variant-1', { status: VariantStatus.APPROVED })).rejects.toThrow(new BadRequestException(message));
      expect(contentVariant.updateMany).not.toHaveBeenCalled();
    }
    // Approving and editing at once: the approver has not read the new text.
    await expect(setup(verdict('approved')).service.updateUnreferenced('owner-1', 'variant-1', { status: VariantStatus.APPROVED, body: 'Khác' }))
      .rejects.toThrow('Bài đã sửa sau khi AI duyệt');
    const approved = setup(verdict('approved'));
    await expect(approved.service.updateUnreferenced('owner-1', 'variant-1', { status: VariantStatus.APPROVED })).resolves.toMatchObject({ id: 'variant-1' });
    expect(approved.contentVariant.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { status: VariantStatus.APPROVED } }));
    // Approver off: approved as before.
    await expect(setup(null, false).service.updateUnreferenced('owner-1', 'variant-1', { status: VariantStatus.APPROVED })).resolves.toMatchObject({ id: 'variant-1' });
  });

  it('sends a hand-written variant to the approver once it is created', async () => {
    let createInput: { data: Record<string, unknown> } | undefined;
    const transaction = {
      content: { findFirstOrThrow: jest.fn().mockResolvedValue({ id: 'content-1', canonicalUrl: null }), update: jest.fn() },
      platform: { findFirstOrThrow: jest.fn().mockResolvedValue({ id: 'platform-1' }) },
      contentVariant: {
        aggregate: jest.fn().mockResolvedValue({ _max: { version: null } }),
        create: jest.fn((input: { data: Record<string, unknown> }) => { createInput = input; return Promise.resolve({ id: 'variant-9', ...input.data }); }),
      },
    };
    const prisma = { $transaction: jest.fn((callback: (client: typeof transaction) => unknown) => callback(transaction)) } as unknown as PrismaService;
    const approvals = { enabled: () => true, runningApproval: jest.fn().mockResolvedValue(running), launch: jest.fn() };
    const created = await new ContentVariantsService(prisma, approvals as unknown as VariantApprovalService)
      .createManual('owner-1', { contentId: 'content-1', platformSlug: 'devto', title: 'Tiêu đề', body: 'Bài về VPS', hashtags: ['vps'] });
    expect(approvals.runningApproval).toHaveBeenCalledWith({ title: 'Tiêu đề', body: 'Bài về VPS', hashtags: ['vps'] });
    // Never created approved: it waits for the approver and a person.
    expect(createInput?.data).toMatchObject({ status: VariantStatus.GENERATED, aiApproval: running });
    expect(approvals.launch).toHaveBeenCalledWith('owner-1', 'variant-9', running);
    expect(created).toMatchObject({ id: 'variant-9', aiApprovalCurrent: false });
  });
});
