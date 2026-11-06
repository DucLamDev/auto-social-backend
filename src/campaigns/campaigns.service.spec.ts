import { CampaignStatus, PublishJobStatus, VariantStatus } from '@prisma/client';
import { approvalHash } from '../ai/content-approval';
import { PrismaService } from '../database/prisma.service';
import { PublishQueueService } from '../queue/publish-queue.service';
import { CampaignsService } from './campaigns.service';
import type { AiContentService } from '../ai/ai-content.service';

/** Final AI approver off unless a test turns it on. */
const approverOff = { approvalEnabled: () => false } as unknown as AiContentService;

describe('CampaignsService', () => {
  it('returns publish progress derived from job states', async () => {
    const findMany = jest.fn().mockResolvedValue([{
      id: 'campaign-1',
      name: 'Launch',
      content: { id: 'content-1', title: 'Article' },
      _count: { targets: 4 },
      targets: [
        { publishJobs: [{ status: PublishJobStatus.PUBLISHED }] },
        { publishJobs: [{ status: PublishJobStatus.FAILED }] },
        { publishJobs: [{ status: PublishJobStatus.QUEUED }] },
        { publishJobs: [{ status: PublishJobStatus.NEEDS_ACTION }] },
      ],
    }]);
    const prisma = { campaign: { findMany } } as unknown as PrismaService;
    const service = new CampaignsService(prisma, {} as PublishQueueService, approverOff);

    const result = await service.list('owner-1');

    expect(result[0]?.progress).toEqual({
      total: 4,
      published: 1,
      failed: 1,
      needsAction: 1,
      active: 1,
      scheduled: 0,
      cancelled: 0,
    });
  });

  it('requires every selected content variant to be approved', async () => {
    const contentId = '11111111-1111-4111-8111-111111111111';
    const accountId = '22222222-2222-4222-8222-222222222222';
    const variantId = '33333333-3333-4333-8333-333333333333';
    const variantFindMany = jest.fn().mockResolvedValue([]);
    const prisma = {
      content: { findFirstOrThrow: jest.fn().mockResolvedValue({ id: contentId }) },
      platformAccount: {
        findMany: jest.fn().mockResolvedValue([{ id: accountId, platformId: 'platform-1', platform: { slug: 'x' } }]),
      },
      contentVariant: { findMany: variantFindMany },
    } as unknown as PrismaService;
    const service = new CampaignsService(prisma, {} as PublishQueueService, approverOff);

    await expect(service.create('owner-1', {
      name: 'Launch',
      contentId,
      targets: [{ platformAccountId: accountId, contentVariantId: variantId }],
    })).rejects.toThrow('approved variant');
    expect(variantFindMany).toHaveBeenCalledWith({
      where: { id: { in: [variantId] }, contentId, status: VariantStatus.APPROVED },
    });
  });

  it.each([
    ['due now', new Date(Date.now() - 1_000), CampaignStatus.RUNNING, 1],
    ['future', new Date(Date.now() + 60_000), CampaignStatus.SCHEDULED, 0],
  ] as const)('moves a %s campaign to the correct state and dispatches only when due', async (
    _label,
    scheduledAt,
    expectedStatus,
    enqueueCount,
  ) => {
    const campaign = {
      id: 'campaign-1',
      ownerId: 'owner-1',
      status: CampaignStatus.DRAFT,
      scheduledAt,
      targets: [{
        platformAccount: { platform: { slug: 'x' } },
        publishJobs: [{ id: 'job-1', status: PublishJobStatus.SCHEDULED }],
      }],
    };
    const campaignUpdate = jest.fn().mockResolvedValue({});
    const prisma = {
      campaign: {
        findFirstOrThrow: jest.fn().mockResolvedValue(campaign),
        update: campaignUpdate,
      },
      publishJob: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        update: jest.fn().mockResolvedValue({}),
      },
    } as unknown as PrismaService;
    const enqueue = jest.fn().mockResolvedValue(undefined);
    const service = new CampaignsService(prisma, { enqueue } as unknown as PublishQueueService, approverOff);

    await service.publish('owner-1', 'campaign-1');

    expect(campaignUpdate).toHaveBeenCalledWith({
      where: { id: 'campaign-1' }, data: { status: expectedStatus },
    });
    expect(enqueue).toHaveBeenCalledTimes(enqueueCount);
  });

  it('does not reopen a terminal campaign when publish is called again', async () => {
    const update = jest.fn();
    const enqueue = jest.fn();
    const prisma = {
      campaign: {
        findFirstOrThrow: jest.fn().mockResolvedValue({
          id: 'campaign-1',
          status: CampaignStatus.COMPLETED,
          scheduledAt: new Date(),
          targets: [],
        }),
        update,
      },
    } as unknown as PrismaService;
    const service = new CampaignsService(
      prisma,
      { enqueue } as unknown as PublishQueueService,
      approverOff,
    );

    await expect(service.publish('owner-1', 'campaign-1')).rejects.toThrow(
      'Only a draft campaign can be published',
    );
    expect(update).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('does not activate a draft campaign with no targets or jobs', async () => {
    const update = jest.fn();
    const prisma = {
      campaign: {
        findFirstOrThrow: jest.fn().mockResolvedValue({
          id: 'campaign-1',
          status: CampaignStatus.DRAFT,
          scheduledAt: new Date(),
          targets: [],
        }),
        update,
      },
    } as unknown as PrismaService;
    const service = new CampaignsService(prisma, {} as PublishQueueService, approverOff);

    await expect(service.publish('owner-1', 'campaign-1'))
      .rejects.toThrow('at least one target with a publish job');
    expect(update).not.toHaveBeenCalled();
  });

  it('does not roll a job back after an ambiguous enqueue failure if a worker already claimed it', async () => {
    const rollback = jest.fn().mockResolvedValue({ count: 0 });
    const prisma = {
      campaign: {
        findFirstOrThrow: jest.fn().mockResolvedValue({
          id: 'campaign-1',
          ownerId: 'owner-1',
          status: CampaignStatus.DRAFT,
          scheduledAt: null,
          targets: [{
            platformAccount: { platform: { slug: 'discourse' } },
            publishJobs: [{ id: 'job-1', status: PublishJobStatus.SCHEDULED }],
          }],
        }),
        update: jest.fn().mockResolvedValue({}),
      },
      publishJob: {
        updateMany: jest.fn()
          .mockResolvedValueOnce({ count: 1 })
          .mockImplementation(rollback),
      },
    } as unknown as PrismaService;
    const enqueueError = new Error('confirm response lost');
    const service = new CampaignsService(
      prisma,
      { enqueue: jest.fn().mockRejectedValue(enqueueError) } as unknown as PublishQueueService,
      approverOff,
    );

    await expect(service.publish('owner-1', 'campaign-1')).rejects.toBe(enqueueError);
    expect(rollback).toHaveBeenCalledWith({
      where: { id: 'job-1', status: PublishJobStatus.QUEUED },
      data: { status: PublishJobStatus.SCHEDULED },
    });
  });

  describe('manual campaign from approved variants with the final AI approver on', () => {
    const contentId = '11111111-1111-4111-8111-111111111111';
    const accountId = '22222222-2222-4222-8222-222222222222';
    const variantId = '33333333-3333-4333-8333-333333333333';
    const post = { title: 'Tiêu đề', body: 'Bài về VPS', hashtags: ['vps'] };
    const approverOn = { approvalEnabled: () => true } as unknown as AiContentService;

    function setup(aiApproval: unknown, ai: AiContentService = approverOn) {
      const campaignCreate = jest.fn().mockResolvedValue({ id: 'campaign-1' });
      const transaction = {
        campaign: { create: campaignCreate },
        campaignTarget: { create: jest.fn().mockResolvedValue({ id: 'target-1' }) },
        publishJob: { create: jest.fn().mockResolvedValue({}) },
      };
      const prisma = {
        content: { findFirstOrThrow: jest.fn().mockResolvedValue({ id: contentId }) },
        platformAccount: { findMany: jest.fn().mockResolvedValue([{ id: accountId, platformId: 'platform-1', platform: { slug: 'devto' } }]) },
        contentVariant: { findMany: jest.fn().mockResolvedValue([{ id: variantId, platformId: 'platform-1', status: VariantStatus.APPROVED, ...post, aiApproval }]) },
        campaign: { findFirstOrThrow: jest.fn().mockResolvedValue({ id: 'campaign-1', targets: [], automationRequest: null }) },
        $transaction: jest.fn((callback: (client: typeof transaction) => unknown) => callback(transaction)),
      } as unknown as PrismaService;
      const service = new CampaignsService(prisma, {} as PublishQueueService, ai);
      const create = () => service.create('owner-1', { name: 'Launch', contentId, targets: [{ platformAccountId: accountId, contentVariantId: variantId }] });
      return { create, campaignCreate };
    }
    const verdict = (status: string, extra: Record<string, unknown> = {}) => ({ status, approver: 'vpsttt:claude:opus', approverLabel: 'Claude Opus', textHash: approvalHash(post), startedAt: new Date().toISOString(), ...extra });

    it('allows a variant approved before the approver existed and one the approver passed', async () => {
      const legacy = setup(null);
      await expect(legacy.create()).resolves.toMatchObject({ id: 'campaign-1' });
      expect(legacy.campaignCreate).toHaveBeenCalled();
      await expect(setup(verdict('approved')).create()).resolves.toMatchObject({ id: 'campaign-1' });
    });

    it('refuses a variant whose stored verdict is not "yes" for its current text', async () => {
      await expect(setup(verdict('rejected', { reasons: ['Seeding vụng'] })).create()).rejects.toThrow('AI duyệt cuối (Claude Opus) từ chối: Seeding vụng');
      await expect(setup(verdict('failed', { error: 'Hết lượt.' })).create()).rejects.toThrow('AI duyệt cuối chưa chạy được: Hết lượt.');
      await expect(setup(verdict('running')).create()).rejects.toThrow('AI duyệt cuối đang đọc bài');
      const edited = setup(verdict('approved', { textHash: 'older-text' }));
      await expect(edited.create()).rejects.toThrow('Bài đã sửa sau khi AI duyệt');
      expect(edited.campaignCreate).not.toHaveBeenCalled();
    });

    it('does not check when the approver is off', async () => {
      await expect(setup(verdict('rejected'), approverOff).create()).resolves.toMatchObject({ id: 'campaign-1' });
    });
  });

  it('returns each target variant with whether its AI approval is for the current text', async () => {
    const post = { title: null, body: 'Bài', hashtags: [] };
    const prisma = {
      campaign: { findFirstOrThrow: jest.fn().mockResolvedValue({
        id: 'campaign-1', automationRequest: null,
        targets: [
          { id: 't1', contentVariant: { id: 'v1', ...post, aiApproval: { status: 'approved', textHash: approvalHash(post), startedAt: 'x' } } },
          { id: 't2', contentVariant: { id: 'v2', ...post, aiApproval: null } },
        ],
      }) },
    } as unknown as PrismaService;
    const campaign = await new CampaignsService(prisma, {} as PublishQueueService, approverOff).get('owner-1', 'campaign-1');
    expect(campaign.targets.map((target) => target.contentVariant.aiApprovalCurrent)).toEqual([true, false]);
  });
});
