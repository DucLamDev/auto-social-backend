import { CampaignStatus, PublishJobStatus } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { PublishQueueService } from '../queue/publish-queue.service';
import { CampaignStatusService } from '../campaigns/campaign-status.service';
import { PublishJobsService } from './publish-jobs.service';
import { WORKER_CRASH_UNCERTAIN_RESULT_CODE } from './publishing.constants';

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

  it('does not overwrite a worker-claimed retry job after an ambiguous enqueue failure', async () => {
    const transactionClient = {
      publishJob: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      campaign: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    };
    const rollback = jest.fn().mockResolvedValue({ count: 0 });
    const prisma = {
      publishJob: {
        findFirstOrThrow: jest.fn().mockResolvedValue({
          id: 'job-1',
          status: PublishJobStatus.FAILED,
          platformAccount: { platform: { slug: 'discourse' } },
          target: { campaignId: 'campaign-1' },
        }),
        updateMany: rollback,
      },
      $transaction: jest.fn(
        (callback: (client: typeof transactionClient) => Promise<void>) => callback(transactionClient),
      ),
    } as unknown as PrismaService;
    const enqueueError = new Error('confirm response lost');
    const service = new PublishJobsService(
      prisma,
      { enqueue: jest.fn().mockRejectedValue(enqueueError) } as unknown as PublishQueueService,
      {} as CampaignStatusService,
    );

    await expect(service.retry('owner-1', 'job-1')).rejects.toBe(enqueueError);
    expect(rollback).toHaveBeenCalledWith({
      where: { id: 'job-1', status: PublishJobStatus.QUEUED },
      data: {
        status: PublishJobStatus.RETRY,
        nextAttemptAt: expect.any(Date) as Date,
      },
    });
  });

  it('queues the same uncertain job only after an explicit provider not-found confirmation', async () => {
    const jobUpdateMany = jest.fn().mockResolvedValue({ count: 1 });
    const attemptUpdate = jest.fn().mockResolvedValue({});
    const campaignUpdateMany = jest.fn().mockResolvedValue({ count: 1 });
    const transaction = {
      publishJob: { updateMany: jobUpdateMany },
      publishAttempt: { update: attemptUpdate },
      campaign: { updateMany: campaignUpdateMany },
    };
    const prisma = {
      publishJob: {
        findFirstOrThrow: jest.fn().mockResolvedValue({
          id: 'job-uncertain',
          status: PublishJobStatus.NEEDS_ACTION,
          platformAccount: { platform: { slug: 'discourse' } },
          target: { campaignId: 'campaign-1' },
          attempts: [{
            id: 'attempt-1',
            responseMetadata: {
              reconciliationRequired: true,
              submissionUncertain: true,
              providerExternalId: 'sp-provider-id',
            },
          }],
        }),
      },
      $transaction: jest.fn(
        (callback: (client: typeof transaction) => Promise<void>) => callback(transaction),
      ),
    } as unknown as PrismaService;
    const enqueue = jest.fn().mockResolvedValue(undefined);
    const service = new PublishJobsService(
      prisma,
      { enqueue } as unknown as PublishQueueService,
      {} as CampaignStatusService,
    );

    await expect(service.reconcileNotFound('owner-1', 'job-uncertain', true))
      .resolves.toEqual({ queued: true });
    expect(jobUpdateMany).toHaveBeenCalledWith({
      where: { id: 'job-uncertain', status: PublishJobStatus.NEEDS_ACTION },
      data: {
        status: PublishJobStatus.QUEUED,
        nextAttemptAt: null,
        lockedAt: null,
        lastErrorCode: null,
        lastErrorMessage: null,
      },
    });
    expect(attemptUpdate).toHaveBeenCalledWith({
      where: { id: 'attempt-1' },
      data: {
        responseMetadata: expect.objectContaining({
          reconciliationRequired: true,
          operatorConfirmedNotFound: true,
          operatorConfirmedNotFoundAt: expect.any(String) as string,
        }) as unknown,
      },
    });
    expect(campaignUpdateMany).toHaveBeenCalledWith({
      where: { id: 'campaign-1', status: CampaignStatus.PARTIAL },
      data: { status: CampaignStatus.RUNNING },
    });
    expect(enqueue).toHaveBeenCalledWith('job-uncertain', 'discourse');
  });

  it('does not overwrite a worker-claimed reconciled job after an ambiguous enqueue failure', async () => {
    const transactionClient = {
      publishJob: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      publishAttempt: { update: jest.fn().mockResolvedValue({}) },
      campaign: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    };
    const rollback = jest.fn().mockResolvedValue({ count: 0 });
    const prisma = {
      publishJob: {
        findFirstOrThrow: jest.fn().mockResolvedValue({
          id: 'job-uncertain',
          status: PublishJobStatus.NEEDS_ACTION,
          platformAccount: { platform: { slug: 'discourse' } },
          target: { campaignId: 'campaign-1' },
          attempts: [{
            id: 'attempt-1',
            responseMetadata: {
              reconciliationRequired: true,
              submissionUncertain: true,
            },
          }],
        }),
        updateMany: rollback,
      },
      $transaction: jest.fn(
        (callback: (client: typeof transactionClient) => Promise<void>) => callback(transactionClient),
      ),
    } as unknown as PrismaService;
    const enqueueError = new Error('confirm response lost');
    const service = new PublishJobsService(
      prisma,
      { enqueue: jest.fn().mockRejectedValue(enqueueError) } as unknown as PublishQueueService,
      {} as CampaignStatusService,
    );

    await expect(service.reconcileNotFound('owner-1', 'job-uncertain', true))
      .rejects.toBe(enqueueError);
    expect(rollback).toHaveBeenCalledWith({
      where: { id: 'job-uncertain', status: PublishJobStatus.QUEUED },
      data: {
        status: PublishJobStatus.RETRY,
        nextAttemptAt: expect.any(Date) as Date,
      },
    });
  });

  it('allows explicit reconciliation of a stale worker delivery migrated to NEEDS_ACTION', async () => {
    const transactionClient = {
      publishJob: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      publishAttempt: { update: jest.fn().mockResolvedValue({}) },
      campaign: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
    };
    const prisma = {
      publishJob: {
        findFirstOrThrow: jest.fn().mockResolvedValue({
          id: 'job-crashed',
          status: PublishJobStatus.NEEDS_ACTION,
          lastErrorCode: WORKER_CRASH_UNCERTAIN_RESULT_CODE,
          platformAccount: { platform: { slug: 'discourse' } },
          target: { campaignId: 'campaign-1' },
          attempts: [{ id: 'attempt-1', responseMetadata: null }],
        }),
      },
      $transaction: jest.fn(
        (callback: (client: typeof transactionClient) => Promise<void>) => callback(transactionClient),
      ),
    } as unknown as PrismaService;
    const enqueue = jest.fn().mockResolvedValue(undefined);
    const service = new PublishJobsService(
      prisma,
      { enqueue } as unknown as PublishQueueService,
      {} as CampaignStatusService,
    );

    await expect(service.reconcileNotFound('owner-1', 'job-crashed', true))
      .resolves.toEqual({ queued: true });
    expect(enqueue).toHaveBeenCalledWith('job-crashed', 'discourse');
  });

  it.each([
    ['moderation result', true, { reconciliationRequired: true, moderationQueue: true }],
    ['non-reconciliation result', true, { moderationQueue: true }],
    ['provider-accepted persistence recovery', true, {
      reconciliationRequired: true,
      submissionUncertain: true,
      providerAccepted: true,
      persistenceRecoveryRequired: true,
    }],
    ['missing explicit confirmation', false, { reconciliationRequired: true }],
  ] as const)('refuses reconciliation retry for %s', async (_label, confirmed, responseMetadata) => {
    const transaction = jest.fn();
    const enqueue = jest.fn();
    const prisma = {
      publishJob: {
        findFirstOrThrow: jest.fn().mockResolvedValue({
          id: 'job-1',
          status: PublishJobStatus.NEEDS_ACTION,
          platformAccount: { platform: { slug: 'discourse' } },
          target: { campaignId: 'campaign-1' },
          attempts: [{ id: 'attempt-1', responseMetadata }],
        }),
      },
      $transaction: transaction,
    } as unknown as PrismaService;
    const service = new PublishJobsService(
      prisma,
      { enqueue } as unknown as PublishQueueService,
      {} as CampaignStatusService,
    );

    await expect(service.reconcileNotFound('owner-1', 'job-1', confirmed)).rejects.toThrow();
    expect(transaction).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('preserves moderation metadata, applies corrected confirmation values, and completes its campaign', async () => {
    const campaignUpdate = jest.fn().mockResolvedValue({});
    const publishedPostCreate = jest.fn().mockResolvedValue({});
    const attemptUpdate = jest.fn().mockResolvedValue({});
    const publishJobUpdateMany = jest.fn().mockResolvedValue({ count: 1 });
    const transaction = {
      publishedPost: { create: publishedPostCreate },
      publishJob: { updateMany: publishJobUpdateMany },
      publishAttempt: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'attempt-1',
          responseMetadata: {
            moderationQueue: true,
            providerExternalId: 'sp-provider-id',
            reviewableId: 55,
            externalPostId: '42',
            url: 'https://forum.example.com/t/topic/42',
          },
        }),
        update: attemptUpdate,
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
      externalPostId: 'approved-42',
      url: 'https://forum.example.com/t/approved-topic/42',
    })).resolves.toEqual({ published: true });
    const expectedMetadata = {
      moderationQueue: true,
      providerExternalId: 'sp-provider-id',
      reviewableId: 55,
      externalPostId: 'approved-42',
      url: 'https://forum.example.com/t/approved-topic/42',
      manual: true,
      manualConfirmed: true,
    };
    expect(publishedPostCreate).toHaveBeenCalledWith({
      data: {
        publishJobId: 'job-1',
        platformAccountId: 'account-1',
        externalPostId: 'approved-42',
        url: 'https://forum.example.com/t/approved-topic/42',
        metadata: expectedMetadata,
      },
    });
    expect(attemptUpdate).toHaveBeenCalledWith({
      where: { id: 'attempt-1' },
      data: {
        status: 'SUCCEEDED',
        finishedAt: expect.any(Date) as Date,
        responseMetadata: expectedMetadata,
        errorCode: null,
        errorMessage: null,
      },
    });
    expect(publishJobUpdateMany).toHaveBeenCalledWith({
      where: { id: 'job-1', status: PublishJobStatus.NEEDS_ACTION },
      data: {
        status: PublishJobStatus.PUBLISHED,
        nextAttemptAt: null,
        lockedAt: null,
        lastErrorCode: null,
        lastErrorMessage: null,
      },
    });
    expect(campaignUpdate).toHaveBeenCalledWith({
      where: { id: 'campaign-1' },
      data: { status: 'COMPLETED' },
    });
  });

  it('does not confirm a topic after reconciliation has already claimed the job for retry', async () => {
    const publishedPostCreate = jest.fn();
    const transaction = {
      publishJob: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
      publishAttempt: { findFirst: jest.fn() },
      publishedPost: { create: publishedPostCreate },
    };
    const prisma = {
      publishJob: {
        findFirstOrThrow: jest.fn().mockResolvedValue({
          id: 'job-1',
          status: PublishJobStatus.NEEDS_ACTION,
          platformAccountId: 'account-1',
          target: { campaignId: 'campaign-1' },
        }),
      },
      $transaction: jest.fn(
        (callback: (client: typeof transaction) => Promise<void>) => callback(transaction),
      ),
    } as unknown as PrismaService;
    const service = new PublishJobsService(
      prisma,
      {} as PublishQueueService,
      {} as CampaignStatusService,
    );

    await expect(service.markPublished('owner-1', 'job-1', {
      externalPostId: 'topic-42',
    })).rejects.toThrow('no longer awaiting confirmation');
    expect(transaction.publishAttempt.findFirst).not.toHaveBeenCalled();
    expect(publishedPostCreate).not.toHaveBeenCalled();
  });
});
