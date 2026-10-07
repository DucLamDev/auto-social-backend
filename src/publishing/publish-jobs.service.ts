import { BadRequestException, Injectable } from '@nestjs/common';
import { AttemptStatus, CampaignStatus, Prisma, PublishJobStatus } from '@prisma/client';
import { CampaignStatusService } from '../campaigns/campaign-status.service';
import { PrismaService } from '../database/prisma.service';
import { PublishQueueService } from '../queue/publish-queue.service';
import { ManualPublishedDto } from './dto/manual-published.dto';
import { ListPublishJobsQueryDto } from './dto/list-publish-jobs-query.dto';
import { paginatedData } from '../common/interceptors/api-response.interceptor';
import { PublishJobMetricsQueryDto } from './dto/publish-job-metrics-query.dto';

@Injectable()
export class PublishJobsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: PublishQueueService,
    private readonly campaignStatus: CampaignStatusService,
  ) {}

  async list(ownerId: string, query: ListPublishJobsQueryDto) {
    const search = query.search?.trim();
    const where: Prisma.PublishJobWhereInput = {
      target: { campaign: { ownerId } },
      ...(query.status ? { status: query.status } : {}),
      ...(query.from || query.to ? {
        scheduledAt: {
          ...(query.from ? { gte: new Date(query.from) } : {}),
          ...(query.to ? { lte: new Date(query.to) } : {}),
        },
      } : {}),
      ...(search ? {
        OR: [
          { platformAccount: { name: { contains: search, mode: 'insensitive' } } },
          { platformAccount: { platform: { name: { contains: search, mode: 'insensitive' } } } },
          { target: { campaign: { name: { contains: search, mode: 'insensitive' } } } },
          { target: { contentVariant: { title: { contains: search, mode: 'insensitive' } } } },
        ],
      } : {}),
    };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.publishJob.findMany({
      where,
      include: {
        platformAccount: { select: { id: true, name: true, platform: { select: { slug: true, name: true } } } },
        target: { select: { campaign: { select: { id: true, name: true } }, contentVariant: { select: { id: true, title: true } } } },
        publishedPost: true,
        attempts: { orderBy: { attemptNumber: 'desc' }, take: 3 },
      },
      orderBy: { createdAt: 'desc' },
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    }),
      this.prisma.publishJob.count({ where }),
    ]);
    return paginatedData(items, {
      page: query.page,
      limit: query.limit,
      total,
      totalPages: total ? Math.ceil(total / query.limit) : 0,
    });
  }

  async metrics(ownerId: string, query: PublishJobMetricsQueryDto) {
    const owner = { target: { campaign: { ownerId } } };
    const [publishedToday, scheduled, processing, failed] = await this.prisma.$transaction([
      this.prisma.publishJob.count({
        where: {
          ...owner,
          status: PublishJobStatus.PUBLISHED,
          publishedPost: { publishedAt: { gte: new Date(query.todayFrom), lte: new Date(query.todayTo) } },
        },
      }),
      this.prisma.publishJob.count({
        where: { ...owner, status: { in: [PublishJobStatus.SCHEDULED, PublishJobStatus.QUEUED] } },
      }),
      this.prisma.publishJob.count({
        where: { ...owner, status: { in: [PublishJobStatus.PUBLISHING, PublishJobStatus.PROCESSING] } },
      }),
      this.prisma.publishJob.count({
        where: { ...owner, status: { in: [PublishJobStatus.FAILED, PublishJobStatus.POSSIBLE_DUPLICATE] } },
      }),
    ]);
    return { publishedToday, scheduled, processing, failed };
  }

  async retry(ownerId: string, id: string) {
    const job = await this.prisma.publishJob.findFirstOrThrow({
      where: { id, target: { campaign: { ownerId } } },
      include: {
        platformAccount: { include: { platform: true } },
        target: { select: { campaignId: true } },
      },
    });
    if (job.status !== PublishJobStatus.FAILED && job.status !== PublishJobStatus.RETRY) throw new BadRequestException('Only failed or retrying jobs can be retried');
    await this.prisma.$transaction(async (transaction) => {
      const claimed = await transaction.publishJob.updateMany({
        where: { id, status: { in: [PublishJobStatus.FAILED, PublishJobStatus.RETRY] } },
        data: {
          status: PublishJobStatus.QUEUED,
          nextAttemptAt: null,
          lockedAt: null,
          lastErrorCode: null,
          lastErrorMessage: null,
        },
      });
      if (!claimed.count) throw new BadRequestException('Only failed or retrying jobs can be retried');
      await transaction.campaign.updateMany({
        where: { id: job.target.campaignId, status: CampaignStatus.PARTIAL },
        data: { status: CampaignStatus.RUNNING },
      });
    });
    try { await this.queue.enqueue(job.id, job.platformAccount.platform.slug); }
    catch (error) {
      await this.prisma.publishJob.update({ where: { id }, data: { status: PublishJobStatus.RETRY, nextAttemptAt: new Date(Date.now() + 30_000) } });
      throw error;
    }
    return { queued: true };
  }

  async manualPayload(ownerId: string, id: string) {
    const job = await this.prisma.publishJob.findFirstOrThrow({
      where: { id, target: { campaign: { ownerId } } },
      include: {
        platformAccount: { include: { platform: true } },
        target: { include: { contentVariant: true } },
        attempts: { orderBy: { attemptNumber: 'desc' }, take: 1 },
      },
    });
    const defaults: Record<string, string> = {
      reddit: 'https://www.reddit.com/submit',
      tiktok: 'https://www.tiktok.com/upload',
    };
    const settings = job.platformAccount.settings;
    const manualUrl = settings && typeof settings === 'object' && !Array.isArray(settings)
      ? (settings as Record<string, unknown>).manualUrl
      : undefined;
    const blogUrl = settings && typeof settings === 'object' && !Array.isArray(settings)
      ? (settings as Record<string, unknown>).blogUrl
      : undefined;
    const responseMetadata = job.attempts[0]?.responseMetadata;
    const result = responseMetadata && typeof responseMetadata === 'object' && !Array.isArray(responseMetadata)
      ? responseMetadata as Record<string, unknown>
      : {};
    return {
      jobId: job.id,
      status: job.status,
      platform: job.platformAccount.platform.slug,
      accountName: job.platformAccount.name,
      title: job.target.contentVariant.title,
      body: job.target.contentVariant.body,
      hashtags: job.target.contentVariant.hashtags,
      suggestedExternalPostId: typeof result.externalPostId === 'string' ? result.externalPostId : undefined,
      openUrl: typeof manualUrl === 'string'
        ? manualUrl
        : typeof result.url === 'string'
          ? result.url
          : typeof blogUrl === 'string'
            ? blogUrl
            : defaults[job.platformAccount.platform.slug],
    };
  }

  async markPublished(ownerId: string, id: string, dto: ManualPublishedDto) {
    const job = await this.prisma.publishJob.findFirstOrThrow({
      where: { id, target: { campaign: { ownerId } } },
      include: { target: { select: { campaignId: true } } },
    });
    if (job.status !== PublishJobStatus.NEEDS_ACTION) throw new BadRequestException('Only NEEDS_ACTION jobs can be manually marked published');
    await this.prisma.$transaction(async (transaction) => {
      await transaction.publishedPost.create({ data: { publishJobId: job.id, platformAccountId: job.platformAccountId, externalPostId: dto.externalPostId, url: dto.url, metadata: { manual: true } } });
      await transaction.publishJob.update({ where: { id }, data: { status: PublishJobStatus.PUBLISHED } });
      const attempt = await transaction.publishAttempt.findFirst({ where: { publishJobId: id }, orderBy: { attemptNumber: 'desc' } });
      if (attempt) await transaction.publishAttempt.update({ where: { id: attempt.id }, data: { status: AttemptStatus.SUCCEEDED, finishedAt: new Date(), responseMetadata: { manual: true } } });
    });
    await this.campaignStatus.refresh(job.target.campaignId);
    return { published: true };
  }
}
