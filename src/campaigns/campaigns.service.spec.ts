import { CampaignStatus, PublishJobStatus, VariantStatus } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { PublishQueueService } from '../queue/publish-queue.service';
import { CampaignsService } from './campaigns.service';

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
    const service = new CampaignsService(prisma, {} as PublishQueueService);

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
    const service = new CampaignsService(prisma, {} as PublishQueueService);

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
    const service = new CampaignsService(prisma, { enqueue } as unknown as PublishQueueService);

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
    );

    await expect(service.publish('owner-1', 'campaign-1')).rejects.toThrow(
      'Only a draft campaign can be published',
    );
    expect(update).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
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
    );

    await expect(service.publish('owner-1', 'campaign-1')).rejects.toBe(enqueueError);
    expect(rollback).toHaveBeenCalledWith({
      where: { id: 'job-1', status: PublishJobStatus.QUEUED },
      data: { status: PublishJobStatus.SCHEDULED },
    });
  });
});
