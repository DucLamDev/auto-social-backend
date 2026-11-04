import { ConflictException, Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ContentStatus } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { RedisService } from '../queue/redis.service';
import { RedisLockLease } from '../queue/redis-lock-lease';
import { CampaignAutomationService } from './campaign-automation.service';
import { AutomateCampaignDto } from './dto/automate-campaign.dto';

/** Persistent database queue, consumed by the API scheduler independently of HTTP requests. */
@Injectable()
export class CampaignAutomationWorkerService {
  private readonly logger = new Logger(CampaignAutomationWorkerService.name);
  constructor(private readonly prisma: PrismaService, private readonly redis: RedisService, private readonly automation: CampaignAutomationService) {}

  @Cron(CronExpression.EVERY_5_SECONDS, { name: 'generate-ai-campaigns', waitForCompletion: true })
  async processNext(): Promise<void> {
    const key = 'campaign-ai-worker';
    const token = await this.redis.acquireLock(key, 90_000);
    if (!token) return;
    const lease = new RedisLockLease(this.redis, key, token, 90_000);
    lease.start();
    try {
      // A RUNNING record belongs to a process that lost the global lease. Its
      // drafts can be reused; no publish jobs exist before explicit approval.
      const campaign = await this.prisma.campaign.findFirst({
        // Posts approved while the AI was writing may have started the campaign
        // already; the run still finishes its other platforms.
        where: { automationState: { in: ['QUEUED', 'PROCESSING'] }, status: { not: 'CANCELLED' } },
        orderBy: { createdAt: 'asc' },
      });
      if (!campaign) return;
      const claimed = await this.prisma.campaign.updateMany({
        where: { id: campaign.id, automationState: campaign.automationState, updatedAt: campaign.updatedAt },
        data: { automationState: 'PROCESSING', automationErrorCode: null },
      });
      if (!claimed.count) return;
      try {
        await this.prisma.content.updateMany({
          where: { id: campaign.contentId, status: ContentStatus.AI_GENERATING },
          data: { status: ContentStatus.DRAFT },
        });
        const { idempotencyKey, ...dto } = campaign.automationRequest as unknown as AutomateCampaignDto & { idempotencyKey: string };
        await this.automation.automate(campaign.ownerId, dto, idempotencyKey, undefined, {
          processingId: campaign.id,
          assertOwnership: async () => { if (!await lease.verify()) throw new ConflictException('AI worker lease was lost'); },
        });
      } catch (error) {
        if (await lease.verify()) await this.prisma.campaign.updateMany({
          where: { id: campaign.id, automationState: 'PROCESSING' },
          data: { automationState: 'FAILED', automationErrorCode: 'AI_GENERATION_FAILED' },
        });
        this.logger.warn(`AI campaign ${campaign.id} failed (${error instanceof Error ? error.name : 'unknown error'})`);
      }
    } finally {
      await lease.stop();
      await this.redis.releaseLock(key, token);
    }
  }
}
