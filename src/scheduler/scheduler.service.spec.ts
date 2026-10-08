import { CampaignStatus, PublishJobStatus } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { PublishQueueService } from '../queue/publish-queue.service';
import { CampaignStatusService } from '../campaigns/campaign-status.service';
import { SchedulerService } from './scheduler.service';

describe('SchedulerService worker crash recovery', () => {
  function campaignStatus(): CampaignStatusService {
    return { reconcileTerminal: jest.fn().mockResolvedValue(undefined) } as unknown as CampaignStatusService;
  }

  it('queries only jobs belonging to scheduled or running campaigns so drafts never enqueue', async () => {
    const findMany = jest.fn().mockResolvedValue([]);
    const prisma = {
      publishJob: { findMany, updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
    } as unknown as PrismaService;
    const enqueue = jest.fn();
    await new SchedulerService(
      prisma,
      { enqueue } as unknown as PublishQueueService,
      campaignStatus(),
    ).enqueueDueJobs();

    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        target: { campaign: { status: { in: [CampaignStatus.SCHEDULED, CampaignStatus.RUNNING] } } },
      }) as unknown,
    }));
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('moves stale PUBLISHING and legacy crash-uncertain jobs to NEEDS_ACTION instead of blind retry', async () => {
    const staleUpdate = jest.fn().mockResolvedValue({ count: 1 });
    const attemptUpdate = jest.fn().mockResolvedValue({ count: 1 });
    const prisma = {
      publishJob: {
        findMany: jest.fn().mockResolvedValue([]),
        updateMany: staleUpdate,
      },
      publishAttempt: { updateMany: attemptUpdate },
    } as unknown as PrismaService;
    const queue = { enqueue: jest.fn() } as unknown as PublishQueueService;
    await new SchedulerService(prisma, queue, campaignStatus()).enqueueDueJobs();
    expect(JSON.stringify(staleUpdate.mock.calls)).toContain(`"status":"${PublishJobStatus.PUBLISHING}"`);
    expect(JSON.stringify(staleUpdate.mock.calls)).toContain('WORKER_CRASH_UNCERTAIN_RESULT');
    expect(JSON.stringify(staleUpdate.mock.calls)).toContain(`"status":"${PublishJobStatus.NEEDS_ACTION}"`);
    expect(attemptUpdate).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ status: 'STARTED' }) as unknown,
      data: expect.objectContaining({
        status: 'PERMANENT_FAILURE',
        finishedAt: expect.any(Date) as Date,
        responseMetadata: expect.objectContaining({
          reconciliationRequired: true,
          submissionUncertain: true,
        }) as unknown,
      }) as unknown,
    }));
  });

  it('re-enqueues a stale QUEUED job that may have been dead-lettered before processing began', async () => {
    const queuedJob = {
      id: 'job-stale',
      status: PublishJobStatus.QUEUED,
      platformAccount: { platform: { slug: 'threads' } },
      target: { campaignId: 'campaign-1' },
    };
    const claim = jest.fn().mockResolvedValue({ count: 1 });
    const findMany = jest.fn().mockResolvedValue([queuedJob]);
    const transactionClient = {
      publishJob: { updateMany: claim },
      campaign: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
    };
    const prisma = {
      publishJob: {
        findMany,
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        update: jest.fn(),
      },
      $transaction: jest.fn((callback: (client: typeof transactionClient) => Promise<unknown>) => callback(transactionClient)),
    } as unknown as PrismaService;
    const enqueue = jest.fn().mockResolvedValue(undefined);

    await new SchedulerService(
      prisma,
      { enqueue } as unknown as PublishQueueService,
      campaignStatus(),
    ).enqueueDueJobs();

    expect(enqueue).toHaveBeenCalledWith('job-stale', 'threads');
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        OR: expect.arrayContaining([
          expect.objectContaining({
            status: PublishJobStatus.QUEUED,
            updatedAt: expect.objectContaining({ lt: expect.any(Date) as unknown }) as unknown,
          }),
        ]) as unknown,
      }) as unknown,
    }));
  });

  it('atomically marks a scheduled campaign running when its due job is claimed', async () => {
    const job = {
      id: 'job-due',
      status: PublishJobStatus.SCHEDULED,
      platformAccount: { platform: { slug: 'linkedin' } },
      target: { campaignId: 'campaign-scheduled' },
    };
    const campaignUpdate = jest.fn().mockResolvedValue({ count: 1 });
    const transactionClient = {
      publishJob: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      campaign: { updateMany: campaignUpdate },
    };
    const prisma = {
      publishJob: {
        findMany: jest.fn().mockResolvedValue([job]),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      $transaction: jest.fn((callback: (client: typeof transactionClient) => Promise<unknown>) => callback(transactionClient)),
    } as unknown as PrismaService;
    const enqueue = jest.fn().mockResolvedValue(undefined);

    await new SchedulerService(
      prisma,
      { enqueue } as unknown as PublishQueueService,
      campaignStatus(),
    ).enqueueDueJobs();

    expect(campaignUpdate).toHaveBeenCalledWith({
      where: { id: 'campaign-scheduled', status: CampaignStatus.SCHEDULED },
      data: { status: CampaignStatus.RUNNING },
    });
    expect(enqueue).toHaveBeenCalledWith('job-due', 'linkedin');
  });

  it('uses a QUEUED compare-and-set rollback after an ambiguous scheduler enqueue failure', async () => {
    const job = {
      id: 'job-due',
      status: PublishJobStatus.RETRY,
      platformAccount: { platform: { slug: 'discourse' } },
      target: { campaignId: 'campaign-1' },
    };
    const rollbackAndRecovery = jest.fn()
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 0 });
    const transactionClient = {
      publishJob: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      campaign: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
    };
    const prisma = {
      publishJob: {
        findMany: jest.fn().mockResolvedValue([job]),
        updateMany: rollbackAndRecovery,
      },
      $transaction: jest.fn(
        (callback: (client: typeof transactionClient) => Promise<unknown>) => callback(transactionClient),
      ),
    } as unknown as PrismaService;
    const enqueueError = new Error('confirm response lost');
    const service = new SchedulerService(
      prisma,
      { enqueue: jest.fn().mockRejectedValue(enqueueError) } as unknown as PublishQueueService,
      campaignStatus(),
    );

    await service.enqueueDueJobs();

    expect(rollbackAndRecovery).toHaveBeenNthCalledWith(1, {
      where: { id: 'job-due', status: PublishJobStatus.QUEUED },
      data: { status: PublishJobStatus.RETRY },
    });
  });
});
