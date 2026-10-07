import { Injectable } from '@nestjs/common';
import { CampaignStatus, PublishJobStatus } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';

const TERMINAL_JOB_STATUSES: PublishJobStatus[] = [
  PublishJobStatus.PUBLISHED,
  PublishJobStatus.FAILED,
  PublishJobStatus.NEEDS_ACTION,
  PublishJobStatus.POSSIBLE_DUPLICATE,
  PublishJobStatus.CANCELLED,
];

@Injectable()
export class CampaignStatusService {
  constructor(private readonly prisma: PrismaService) {}

  async refresh(campaignId: string): Promise<void> {
    const jobs = await this.prisma.publishJob.findMany({
      where: { target: { campaignId } },
      select: { status: true },
    });
    if (!jobs.length || !jobs.every((job) => TERMINAL_JOB_STATUSES.includes(job.status))) return;
    const completed = jobs.every((job) => job.status === PublishJobStatus.PUBLISHED);
    await this.prisma.campaign.update({
      where: { id: campaignId },
      data: { status: completed ? CampaignStatus.COMPLETED : CampaignStatus.PARTIAL },
    });
  }

  /** Repair campaign state if a worker stopped after the job state was persisted. */
  async reconcileTerminal(limit = 100): Promise<void> {
    const campaigns = await this.prisma.campaign.findMany({
      where: {
        status: { in: [CampaignStatus.SCHEDULED, CampaignStatus.RUNNING] },
        targets: {
          some: { publishJobs: { some: {} } },
          every: { publishJobs: { every: { status: { in: TERMINAL_JOB_STATUSES } } } },
        },
      },
      select: { id: true },
      take: limit,
    });
    for (const campaign of campaigns) await this.refresh(campaign.id);
  }
}
