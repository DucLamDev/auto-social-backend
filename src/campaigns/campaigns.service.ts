import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { CampaignStatus, Prisma, PublishJobStatus, VariantStatus } from '@prisma/client';
import { AiContentService } from '../ai/ai-content.service';
import { storedApprovalProblem, withAiApprovalCurrent } from '../content-variants/ai-approval-gate';
import { stableIdempotencyKey } from '../common/utils/crypto.utils';
import { PrismaService } from '../database/prisma.service';
import { PublishQueueService } from '../queue/publish-queue.service';
import { CreateCampaignDto } from './dto/create-campaign.dto';

function automationAccountIds(request: Prisma.JsonValue | undefined): string[] {
  if (!request || typeof request !== 'object' || Array.isArray(request)) return [];
  return Array.isArray(request.platformAccountIds) ? request.platformAccountIds.filter((id): id is string => typeof id === 'string') : [];
}

@Injectable()
export class CampaignsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: PublishQueueService,
    private readonly ai: AiContentService,
  ) {}

  async listAiReview(ownerId: string) {
    const [campaigns, contents] = await Promise.all([
      this.prisma.campaign.findMany({
        where: { ownerId, OR: [{ automationKey: { not: null } }, { targets: { some: {} } }] },
        include: {
          content: { select: { id: true, title: true, status: true } },
          targets: { select: { platformAccountId: true, contentVariantId: true, contentVariant: { select: { status: true } } } },
        },
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.content.findMany({
        where: { ownerId, OR: [{ status: 'AI_GENERATING' }, { variants: { some: { targets: { none: {} } } } }] },
        select: {
          id: true, title: true, status: true, createdAt: true, updatedAt: true,
          variants: { where: { targets: { none: {} } }, orderBy: { version: 'desc' }, select: { id: true, platformId: true, status: true } },
        },
        orderBy: { createdAt: 'desc' },
      }),
    ]);
    const reservedIds = new Set(campaigns.flatMap((campaign) => campaign.automationVariantIds));
    const generatingContentIds = new Set(campaigns.filter((campaign) => ['QUEUED', 'PROCESSING'].includes(campaign.automationState ?? '')).map((campaign) => campaign.contentId));
    const rows = campaigns.map(({ automationRequest, targets, ...campaign }) => ({
      ...campaign,
      reviewMode: campaign.automationState ? 'AUTOMATION' : 'EXISTING_CAMPAIGN',
      automationState: campaign.automationState ?? (
        campaign.content.status === 'AI_GENERATING' ? 'PROCESSING'
          : targets.length ? (targets.some((target) => target.contentVariant.status === 'GENERATED') ? 'WAITING_REVIEW' : 'APPROVED')
            : campaign.automationErrorCode ? 'FAILED' : 'DRAFT'
      ),
      automationVariantIds: campaign.automationState ? campaign.automationVariantIds : [...new Set(targets.map((target) => target.contentVariantId))],
      automationAccountIds: campaign.automationState ? automationAccountIds(automationRequest) : [...new Set(targets.map((target) => target.platformAccountId))],
    }));
    const standalone = contents.flatMap((content) => {
      if (generatingContentIds.has(content.id)) return [];
      const variants = content.variants.filter((variant) => !reservedIds.has(variant.id));
      if (!variants.length && content.status !== 'AI_GENERATING') return [];
      return [{
        id: content.id, contentId: content.id, name: content.title, content: { id: content.id, title: content.title, status: content.status },
        status: CampaignStatus.DRAFT, createdAt: content.createdAt, updatedAt: content.updatedAt, timezone: 'UTC', scheduledAt: null,
        reviewMode: 'CONTENT', automationAccountIds: [], automationVariantIds: variants.map((variant) => variant.id),
        automationState: content.status === 'AI_GENERATING' ? 'PROCESSING' : variants.some((variant) => variant.status === 'GENERATED' || variant.status === 'DRAFT') ? 'WAITING_REVIEW' : variants.every((variant) => variant.status === 'REJECTED') ? 'REJECTED' : 'APPROVED',
      }];
    });
    return [...rows, ...standalone].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }

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
    return campaigns.map(({ targets, automationRequest, ...campaign }) => {
      const statuses = targets.flatMap((target) => target.publishJobs.map((job) => job.status));
      const count = (values: PublishJobStatus[]) => statuses.filter((status) => values.includes(status)).length;
      return {
        ...campaign,
        automationAccountIds: automationAccountIds(automationRequest),
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

  async get(ownerId: string, id: string) {
    const { automationRequest, ...campaign } = await this.prisma.campaign.findFirstOrThrow({
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
    return {
      ...campaign,
      targets: campaign.targets.map(({ contentVariant, ...target }) => ({ ...target, contentVariant: contentVariant && withAiApprovalCurrent(contentVariant) })),
      automationAccountIds: automationAccountIds(automationRequest),
    };
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
    // Approved before the final AI approver existed (nothing stored): allowed as
    // before. A stored verdict must be "yes" for the variant's current text.
    const approverOn = this.ai.approvalEnabled();
    const unapproved = variants.flatMap((variant) => {
      const problem = storedApprovalProblem(variant, approverOn);
      return problem ? [problem] : [];
    });
    if (unapproved.length) throw new BadRequestException([...new Set(unapproved)].join(' '));
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
