import { CampaignStatus, PublishJobStatus } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { PublishQueueService } from '../queue/publish-queue.service';
import { CampaignStatusService } from '../campaigns/campaign-status.service';
import { PublishJobsService } from './publish-jobs.service';

describe('PublishJobsService', () => {
  it('calculates exact dashboard counters without truncating the job list', async () => {
    const count = jest.fn()
      .mockResolvedValueOnce(4)
      .mockResolvedValueOnce(8)
      .mockResolvedValueOnce(2)
      .mockResolvedValueOnce(1);
    const prisma = {
      publishJob: { count },
      $transaction: jest.fn((operations: Array<Promise<unknown>>) => Promise.all(operations)),
    } as unknown as PrismaService;
    const service = new PublishJobsService(prisma, {} as PublishQueueService, {} as CampaignStatusService);

    await expect(service.metrics('owner-1', {
      todayFrom: '2026-10-07T17:00:00.000Z',
      todayTo: '2026-10-08T16:59:59.999Z',
    })).resolves.toEqual({ publishedToday: 4, scheduled: 8, processing: 2, failed: 1 });
    expect(count).toHaveBeenCalledTimes(4);
  });

  it('applies job filters and pagination before loading rows', async () => {
    const findMany = jest.fn().mockResolvedValue([{ id: 'job-1' }]);
    const count = jest.fn().mockResolvedValue(6);
    const prisma = {
      publishJob: { findMany, count },
      $transaction: jest.fn((operations: Array<Promise<unknown>>) => Promise.all(operations)),
    } as unknown as PrismaService;
    const service = new PublishJobsService(
      prisma,
      {} as PublishQueueService,
      {} as CampaignStatusService,
    );

    await expect(service.list('owner-1', {
      page: 2,
      limit: 5,
      status: PublishJobStatus.FAILED,
      search: ' launch ',
      from: '2026-10-01T00:00:00.000Z',
      to: '2026-10-08T23:59:59.999Z',
    })).resolves.toEqual({
      items: [{ id: 'job-1' }],
      pagination: { page: 2, limit: 5, total: 6, totalPages: 2 },
    });
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({
      skip: 5,
      take: 5,
      where: expect.objectContaining({ status: PublishJobStatus.FAILED }) as unknown,
    }));
  });

  it('atomically reopens a partial campaign when a failed job is manually retried', async () => {
    const campaignUpdateMany = jest.fn().mockResolvedValue({ count: 1 });
    const jobUpdateMany = jest.fn().mockResolvedValue({ count: 1 });
    const transaction = {
      publishJob: { updateMany: jobUpdateMany },
      campaign: { updateMany: campaignUpdateMany },
    };
    const prisma = {
      publishJob: {
        findFirstOrThrow: jest.fn().mockResolvedValue({
          id: 'job-1',
          status: PublishJobStatus.FAILED,
          platformAccount: { platform: { slug: 'x' } },
          target: { campaignId: 'campaign-1' },
        }),
      },
      $transaction: jest.fn((callback: (client: typeof transaction) => Promise<void>) => callback(transaction)),
    } as unknown as PrismaService;
    const enqueue = jest.fn().mockResolvedValue(undefined);
    const service = new PublishJobsService(
      prisma,
      { enqueue } as unknown as PublishQueueService,
      {} as CampaignStatusService,
    );

    await expect(service.retry('owner-1', 'job-1')).resolves.toEqual({ queued: true });
    expect(jobUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'job-1', status: { in: [PublishJobStatus.FAILED, PublishJobStatus.RETRY] } },
      data: expect.objectContaining({ status: PublishJobStatus.QUEUED }) as unknown,
    }));
    expect(campaignUpdateMany).toHaveBeenCalledWith({
      where: { id: 'campaign-1', status: CampaignStatus.PARTIAL },
      data: { status: CampaignStatus.RUNNING },
    });
    expect(enqueue).toHaveBeenCalledWith('job-1', 'x');
  });

  it('marks a completed manual job and completes its campaign when all jobs are published', async () => {
    const campaignUpdate = jest.fn().mockResolvedValue({});
    const transaction = {
      publishedPost: { create: jest.fn().mockResolvedValue({}) },
      publishJob: { update: jest.fn().mockResolvedValue({}) },
      publishAttempt: {
        findFirst: jest.fn().mockResolvedValue({ id: 'attempt-1' }),
        update: jest.fn().mockResolvedValue({}),
      },
    };
    const prisma = {
      publishJob: {
        findFirstOrThrow: jest.fn().mockResolvedValue({
          id: 'job-1',
          status: PublishJobStatus.NEEDS_ACTION,
          platformAccountId: 'account-1',
          target: { campaignId: 'campaign-1' },
        }),
        findMany: jest.fn().mockResolvedValue([
          { status: PublishJobStatus.PUBLISHED },
          { status: PublishJobStatus.PUBLISHED },
        ]),
      },
      campaign: { update: campaignUpdate },
      $transaction: jest.fn(async (callback: (client: typeof transaction) => Promise<void>) => callback(transaction)),
    } as unknown as PrismaService;
    const service = new PublishJobsService(
      prisma,
      {} as PublishQueueService,
      new CampaignStatusService(prisma),
    );

    await expect(service.markPublished('owner-1', 'job-1', {
      externalPostId: 'external-1',
      url: 'https://example.com/post/1',
    })).resolves.toEqual({ published: true });
    expect(campaignUpdate).toHaveBeenCalledWith({
      where: { id: 'campaign-1' },
      data: { status: 'COMPLETED' },
    });
  });
});
