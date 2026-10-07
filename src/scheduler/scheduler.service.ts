import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { CampaignStatus, PublishJobStatus } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { PublishQueueService } from '../queue/publish-queue.service';
import { CampaignStatusService } from '../campaigns/campaign-status.service';

const STALE_DELIVERY_AFTER_MS = 15 * 60_000;

@Injectable()
export class SchedulerService {
  private readonly logger = new Logger(SchedulerService.name);
  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: PublishQueueService,
    private readonly campaignStatus: CampaignStatusService,
  ) {}

  @Cron(CronExpression.EVERY_10_SECONDS, { name: 'publish-due-jobs', waitForCompletion: true })
  async enqueueDueJobs(): Promise<void> {
    const now = new Date();
    const staleDeliveryBefore = new Date(now.getTime() - STALE_DELIVERY_AFTER_MS);
    const jobs = await this.prisma.publishJob.findMany({
      where: {
        target: { campaign: { status: { in: [CampaignStatus.SCHEDULED, CampaignStatus.RUNNING] } } },
        OR: [
          { status: PublishJobStatus.SCHEDULED, scheduledAt: { lte: now } },
          { status: PublishJobStatus.RETRY, nextAttemptAt: { lte: now } },
          // A process can fail before it creates a publish attempt (for example,
          // while PostgreSQL or Redis is unavailable). RabbitMQ dead-letters the
          // second failed delivery; reclaiming a stale QUEUED row keeps that job
          // recoverable once infrastructure is healthy again.
          { status: PublishJobStatus.QUEUED, updatedAt: { lt: staleDeliveryBefore } },
        ],
      },
      include: {
        platformAccount: { include: { platform: true } },
        target: { select: { campaignId: true } },
      },
      take: 100,
      orderBy: { scheduledAt: 'asc' },
    });
    for (const job of jobs) {
      const claimed = await this.prisma.$transaction(async (transaction) => {
        const result = await transaction.publishJob.updateMany({
          where: { id: job.id, status: job.status },
          data: { status: PublishJobStatus.QUEUED },
        });
        if (result.count) {
          await transaction.campaign.updateMany({
            where: { id: job.target.campaignId, status: CampaignStatus.SCHEDULED },
            data: { status: CampaignStatus.RUNNING },
          });
        }
        return result;
      });
      if (!claimed.count) continue;
      try { await this.queue.enqueue(job.id, job.platformAccount.platform.slug); }
      catch (error) {
        await this.prisma.publishJob.update({ where: { id: job.id }, data: { status: job.status } });
        this.logger.error(`Failed to enqueue ${job.id}: ${error instanceof Error ? error.message : 'unknown error'}`);
      }
    }
    await this.prisma.publishJob.updateMany({
      where: { status: PublishJobStatus.PUBLISHING, lockedAt: { lt: staleDeliveryBefore } },
      data: { status: PublishJobStatus.POSSIBLE_DUPLICATE, lastErrorCode: 'WORKER_CRASH_UNCERTAIN_RESULT', lastErrorMessage: 'Worker stopped after publish began; manual verification is required', lockedAt: null },
    });
    await this.campaignStatus.reconcileTerminal();
  }
}
