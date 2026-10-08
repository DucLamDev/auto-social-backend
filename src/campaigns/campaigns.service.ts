import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { CampaignStatus, Prisma, PublishJobStatus, VariantStatus } from '@prisma/client';
import { stableIdempotencyKey } from '../common/utils/crypto.utils';
import { PrismaService } from '../database/prisma.service';
import { PublishQueueService } from '../queue/publish-queue.service';
import { CreateCampaignDto } from './dto/create-campaign.dto';

@Injectable()
export class CampaignsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: PublishQueueService,
  ) {}

  async list(ownerId: string) {
    const campaigns = await this.prisma.campaign.findMany({
      where: { ownerId },
      include: {
        content: { select: { id: true, title: true } },
        _count: { select: { targets: true } },
        targets: { select: { publishJobs: { select: { status: true } } } },
      },
      orderBy: { createdAt: 'desc' },
    });
    return campaigns.map(({ targets, ...campaign }) => {
      const statuses = targets.flatMap((target) => target.publishJobs.map((job) => job.status));
      const count = (values: PublishJobStatus[]) => statuses.filter((status) => values.includes(status)).length;
      return {
        ...campaign,
        progress: {
          total: statuses.length,
          published: count([PublishJobStatus.PUBLISHED]),
          failed: count([PublishJobStatus.FAILED, PublishJobStatus.POSSIBLE_DUPLICATE]),
          needsAction: count([PublishJobStatus.NEEDS_ACTION]),
          active: count([PublishJobStatus.QUEUED, PublishJobStatus.PUBLISHING, PublishJobStatus.PROCESSING, PublishJobStatus.RETRY]),
          scheduled: count([PublishJobStatus.SCHEDULED]),
          cancelled: count([PublishJobStatus.CANCELLED]),
        },
      };
    });
  }

  get(ownerId: string, id: string) {
    return this.prisma.campaign.findFirstOrThrow({
      where: { id, ownerId },
      include: {
        content: { select: { id: true, title: true, status: true } },
        targets: {
          include: {
            platformAccount: { select: { id: true, name: true, platform: { select: { slug: true, name: true } } } },
            contentVariant: true,
            publishJobs: true,
          },
        },
      },
    });
  }

  async create(ownerId: string, dto: CreateCampaignDto) {
    this.validateTimezone(dto.timezone ?? 'UTC');
    const scheduledAt = dto.scheduledAt ? new Date(dto.scheduledAt) : new Date();
    if (dto.scheduledAt && !/[zZ]|[+-]\d{2}:?\d{2}$/.test(dto.scheduledAt)) {
      throw new BadRequestException('scheduledAt must include Z or an explicit UTC offset');
    }
    const content = await this.prisma.content.findFirstOrThrow({ where: { id: dto.contentId, ownerId } });
    const accountIds = dto.targets.map((target) => target.platformAccountId);
    if (new Set(accountIds).size !== accountIds.length) throw new BadRequestException('A platform account can only appear once per campaign');
    const variantIds = [...new Set(dto.targets.map((target) => target.contentVariantId))];
    const [accounts, variants] = await Promise.all([
      this.prisma.platformAccount.findMany({
        where: {
          id: { in: accountIds },
          ownerId,
          enabled: true,
          status: 'CONNECTED',
          platform: { enabled: true },
        },
        include: { platform: true },
      }),
      this.prisma.contentVariant.findMany({
        where: { id: { in: variantIds }, contentId: content.id, status: VariantStatus.APPROVED },
      }),
    ]);
    if (accounts.length !== dto.targets.length || variants.length !== variantIds.length) {
      throw new BadRequestException('Every target needs an enabled, connected account and an approved variant from this content');
    }
    const accountMap = new Map(accounts.map((account) => [account.id, account]));
    const variantMap = new Map(variants.map((variant) => [variant.id, variant]));
    for (const target of dto.targets) {
      if (accountMap.get(target.platformAccountId)?.platformId !== variantMap.get(target.contentVariantId)?.platformId) {
        throw new BadRequestException('Content variant platform does not match target account platform');
      }
    }
    const campaign = await this.prisma.$transaction(async (transaction) => {
      const created = await transaction.campaign.create({
        data: { ownerId, contentId: content.id, name: dto.name.trim(), scheduledAt, timezone: dto.timezone ?? 'UTC', status: CampaignStatus.DRAFT },
      });
      for (const target of dto.targets) {
        const createdTarget = await transaction.campaignTarget.create({
          data: { campaignId: created.id, platformAccountId: target.platformAccountId, contentVariantId: target.contentVariantId, overrides: (target.overrides ?? {}) as Prisma.InputJsonObject },
        });
        await transaction.publishJob.create({
          data: {
            campaignTargetId: createdTarget.id,
            platformAccountId: target.platformAccountId,
            idempotencyKey: stableIdempotencyKey(created.id, target.platformAccountId, target.contentVariantId),
            scheduledAt,
            status: PublishJobStatus.SCHEDULED,
          },
        });
      }
      return created;
    });
    return this.get(ownerId, campaign.id);
  }

  async publish(ownerId: string, id: string) {
    const campaign = await this.prisma.campaign.findFirstOrThrow({
      where: { id, ownerId },
      include: { targets: { include: { platformAccount: { include: { platform: true } }, publishJobs: true } } },
    });
    if (campaign.status !== CampaignStatus.DRAFT) {
      throw new ConflictException('Only a draft campaign can be published');
    }
    if (!campaign.targets.length || campaign.targets.some((target) => target.publishJobs.length === 0)) {
      throw new BadRequestException('A campaign needs at least one target with a publish job before activation');
    }
    const now = new Date();
    const publishNow = !campaign.scheduledAt || campaign.scheduledAt <= now;
    await this.prisma.campaign.update({
      where: { id },
      data: { status: publishNow ? CampaignStatus.RUNNING : CampaignStatus.SCHEDULED },
    });
    if (publishNow) {
      for (const target of campaign.targets) {
        for (const job of target.publishJobs.filter((item) => item.status === PublishJobStatus.SCHEDULED)) {
          await this.dispatch(job.id, target.platformAccount.platform.slug);
        }
      }
    }
    return this.get(ownerId, id);
  }

  private async dispatch(jobId: string, platform: string): Promise<void> {
    const claimed = await this.prisma.publishJob.updateMany({
      where: { id: jobId, status: { in: [PublishJobStatus.SCHEDULED, PublishJobStatus.RETRY] } },
      data: { status: PublishJobStatus.QUEUED },
    });
    if (!claimed.count) return;
    try { await this.queue.enqueue(jobId, platform); }
    catch (error) {
      await this.prisma.publishJob.updateMany({
        where: { id: jobId, status: PublishJobStatus.QUEUED },
        data: { status: PublishJobStatus.SCHEDULED },
      });
      throw error;
    }
  }

  private validateTimezone(timezone: string): void {
    try { new Intl.DateTimeFormat('en', { timeZone: timezone }).format(); }
    catch { throw new BadRequestException('timezone must be a valid IANA timezone'); }
  }
}
