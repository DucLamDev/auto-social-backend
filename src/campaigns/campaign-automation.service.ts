import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import {
  AccountStatus,
  CampaignStatus,
  ContentStatus,
  CredentialStatus,
  MediaType,
  PlatformMode,
  Prisma,
  PublishJobStatus,
  VariantStatus,
} from '@prisma/client';
import { AiContentService } from '../ai/ai-content.service';
import { AiImageService } from '../ai/ai-image.service';
import { AuditService } from '../audit/audit.service';
import { ApplicationException, ErrorCode } from '../common/exceptions/application.exception';
import { sha256, stableIdempotencyKey } from '../common/utils/crypto.utils';
import { PrismaService } from '../database/prisma.service';
import { CredentialsService } from '../credentials/credentials.service';
import { hasUsableBrowserStorageState } from '../connectors/browser/browser-session-readiness';
import { ConnectorRegistryService } from '../connectors/core/connector-registry.service';
import { isExtensionDelivery } from '../connectors/extension/extension-delivery';
import { CONTENT_REVIEW_REQUIRED_CODE } from '../publishing/publishing.constants';
import { MediaService } from '../media/media.service';
import { CampaignsService } from './campaigns.service';
import { PlatformImagePlan, planImages } from './image-plan';
import { AutomateCampaignDto } from './dto/automate-campaign.dto';
import { ApproveAiCampaignDto } from './dto/approve-ai-campaign.dto';
import { ReviewExistingContentDto } from './dto/review-existing-content.dto';

const AUTOMATION_STALE_AFTER_MS = 20 * 60 * 1000;
const MAX_PLATFORMS_PER_AUTOMATION = 50;
const AUTOMATION_PLATFORM_MODES = new Set<PlatformMode>([
  PlatformMode.OFFICIAL_API,
  PlatformMode.COMPATIBLE_API,
  PlatformMode.BROWSER_ASSISTED,
]);

type ConnectedAccount = {
  id: string;
  platformId: string;
  settings: Prisma.JsonValue;
  credential?: {
    status: CredentialStatus;
    expiresAt: Date | null;
  } | null;
  platform: {
    id: string;
    slug: string;
    mode: PlatformMode;
    connectorKey?: string;
    capability?: Prisma.JsonValue;
  };
};

type DraftVariant = {
  id: string;
  platformId: string;
  recommended: boolean;
  reason: string | null;
  mediaRecommendation?: Prisma.JsonValue | null;
};

type SelectedMediaAsset = {
  id: string;
  contentId: string | null;
  variantId: string | null;
};

/** When approved posts go out: now, or a future time with an explicit UTC offset. */
function reviewSchedule(dto: ApproveAiCampaignDto): Date {
  const scheduledAt = dto.publishMode === 'SCHEDULED' ? new Date(dto.scheduledAt ?? '') : new Date();
  if (dto.publishMode === 'SCHEDULED' && (!dto.scheduledAt || !/[zZ]|[+-]\d{2}:?\d{2}$/.test(dto.scheduledAt) || !Number.isFinite(scheduledAt.getTime()) || scheduledAt <= new Date())) {
    throw new BadRequestException('Choose a future scheduledAt with an explicit UTC offset');
  }
  return scheduledAt;
}

@Injectable()
export class CampaignAutomationService {
  private readonly logger = new Logger(CampaignAutomationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ai: AiContentService,
    private readonly campaigns: CampaignsService,
    private readonly audit: AuditService,
    private readonly credentials?: CredentialsService,
    @Optional() private readonly images?: AiImageService,
    @Optional() private readonly media?: MediaService,
    @Optional() private readonly connectors?: ConnectorRegistryService,
  ) {}

  async automate(
    ownerId: string,
    dto: AutomateCampaignDto,
    rawIdempotencyKey: string | undefined,
    requestId?: string,
    background?: { enqueue?: boolean; processingId?: string; assertOwnership?: () => Promise<void> },
  ) {
    const idempotencyKey = this.normalizeIdempotencyKey(rawIdempotencyKey);
    const name = dto.name.trim();
    const brief = dto.brief.trim();
    if (!name) throw new BadRequestException('name must not be blank');
    if (!brief) throw new BadRequestException('brief must not be blank');

    const timezone = dto.timezone?.trim() || 'UTC';
    this.validateTimezone(timezone);
    if (dto.scheduledAt && !/[zZ]|[+-]\d{2}:?\d{2}$/.test(dto.scheduledAt)) {
      throw new BadRequestException('scheduledAt must include Z or an explicit UTC offset');
    }
    const scheduledAt = dto.scheduledAt ? new Date(dto.scheduledAt) : new Date();
    if (Number.isNaN(scheduledAt.getTime())) throw new BadRequestException('scheduledAt must be a valid date');
    const publishImmediately = background ? false : dto.publishImmediately ?? true;
    const aiProvider = this.ai.resolveProvider(dto.aiProvider);
    const mediaAssetIds = [...(dto.mediaAssetIds ?? [])].sort();
    const automationKey = stableIdempotencyKey('campaign-automation', ownerId, idempotencyKey);
    const requestHash = sha256(JSON.stringify({
      name,
      brief,
      platformAccountIds: [...dto.platformAccountIds].sort(),
      mediaAssetIds,
      aiProvider,
      scheduledAt: dto.scheduledAt ?? null,
      timezone,
      publishImmediately,
      ...(background ? { reviewRequired: true } : {}),
      // Only the opt-out changes the hash, so requests stored before images existed still replay.
      ...(dto.generateImages === false ? { generateImages: false } : {}),
    }));

    const alreadyReserved = await this.findReservation(ownerId, automationKey);
    if (alreadyReserved && alreadyReserved.automationRequestHash !== requestHash) {
      await this.audit.recordBestEffort({
        actorId: ownerId,
        action: 'CAMPAIGN_AUTOMATION_REJECTED',
        entityType: 'campaigns',
        entityId: alreadyReserved.id,
        requestId,
        after: { errorCode: ErrorCode.CONFLICT, stage: 'idempotency' },
      });
      throw new ConflictException('Idempotency-Key was already used with a different automation request');
    }
    if (background?.enqueue && alreadyReserved?.automationState) {
      return this.result(ownerId, alreadyReserved.id);
    }
    if (alreadyReserved?.targets.length) {
      return this.replayCompleted(ownerId, alreadyReserved, publishImmediately, requestId);
    }
    if (!alreadyReserved && dto.scheduledAt && scheduledAt <= new Date()) {
      throw new BadRequestException('scheduledAt must be in the future; omit it to publish now');
    }

    let accounts: ConnectedAccount[];
    let platformSlugs: string[];
    let imagePlan = new Map<string, PlatformImagePlan>();
    try {
      await this.validateMediaAssets(ownerId, mediaAssetIds, alreadyReserved?.contentId);
      accounts = await this.loadConnectedAccounts(ownerId, dto.platformAccountIds);
      platformSlugs = [...new Set(accounts.map((account) => account.platform.slug))];
      if (platformSlugs.length > MAX_PLATFORMS_PER_AUTOMATION) {
        throw new BadRequestException(`A campaign automation supports at most ${MAX_PLATFORMS_PER_AUTOMATION} platforms`);
      }
      await this.ai.assertReady(platformSlugs, aiProvider);
      if (this.images?.status().configured && this.media) {
        imagePlan = planImages(accounts, { enabled: dto.generateImages !== false, userImage: mediaAssetIds.length > 0 }, this.connectors);
      }
    } catch (error) {
      await this.audit.recordBestEffort({
        actorId: ownerId,
        action: 'CAMPAIGN_AUTOMATION_FAILED',
        entityType: 'campaigns',
        entityId: alreadyReserved?.id,
        requestId,
        after: { errorCode: this.safeErrorCode(error), stage: 'preflight' },
      });
      throw error;
    }

    const reservation = alreadyReserved
      ? { campaign: alreadyReserved, created: false }
      : await this.findOrCreateReservation({
        ownerId,
        automationKey,
        requestHash,
        name,
        brief,
        scheduledAt,
        timezone,
        ...(background?.enqueue ? { backgroundRequest: { ...dto, aiProvider, publishImmediately: false, idempotencyKey } } : {}),
      });

    if (reservation.campaign.automationRequestHash !== requestHash) {
      throw new ConflictException('Idempotency-Key was already used with a different automation request');
    }

    if (reservation.campaign.targets.length > 0) {
      return this.replayCompleted(ownerId, reservation.campaign, publishImmediately, requestId);
    }

    if (background?.enqueue) return this.result(ownerId, reservation.campaign.id);
    if (background?.processingId && background.processingId !== reservation.campaign.id) {
      throw new ConflictException('Background task does not match its campaign');
    }
    if (!reservation.created && !background?.processingId) await this.claimRetry(ownerId, reservation.campaign);

    await this.audit.recordBestEffort({
      actorId: ownerId,
      action: 'CAMPAIGN_AUTOMATION_STARTED',
      entityType: 'campaigns',
      entityId: reservation.campaign.id,
      requestId,
      after: {
        accountCount: accounts.length,
        platformCount: platformSlugs.length,
        mediaAssetCount: mediaAssetIds.length,
        imagesPlanned: imagePlan.size,
        aiProvider,
        resumed: !reservation.created,
      },
    });

    let targetsCreated = false;
    try {
      await this.attachMediaAssets(ownerId, reservation.campaign.contentId, mediaAssetIds);
      const reusable = reservation.created
        ? []
        : await this.prisma.contentVariant.findMany({
          where: {
            contentId: reservation.campaign.contentId,
            platformId: { in: accounts.map((account) => account.platformId) },
            status: VariantStatus.GENERATED,
            targets: { none: {} },
          },
          orderBy: { version: 'desc' },
          select: { id: true, platformId: true, recommended: true, reason: true, mediaRecommendation: true },
        });
      const reusableByPlatform = new Map<string, (typeof reusable)[number]>();
      for (const variant of reusable) {
        if (!reusableByPlatform.has(variant.platformId)) reusableByPlatform.set(variant.platformId, variant);
      }
      // Drafts of an interrupted run (and edits made to them during it) are kept;
      // only the platforms still without a draft are generated.
      const kept = [...reusableByPlatform.values()];
      const platformIdBySlug = new Map(accounts.map((account) => [account.platform.slug, account.platformId]));
      const missing = platformSlugs.filter((slug) => !reusableByPlatform.has(platformIdBySlug.get(slug) ?? ''));
      const campaignId = reservation.campaign.id;
      if (background?.processingId) {
        // The review page lists every saved draft while the rest are generated.
        await this.prisma.campaign.update({ where: { id: campaignId }, data: { automationVariantIds: kept.map((variant) => variant.id) } });
      }
      const generated: DraftVariant[] = !missing.length ? []
        : background?.assertOwnership
          ? await this.ai.generate(ownerId, reservation.campaign.contentId, missing, aiProvider, background.assertOwnership, imagePlan,
            background.processingId ? async (variant) => {
              await this.prisma.campaign.update({ where: { id: campaignId }, data: { automationVariantIds: { push: variant.id } } });
            } : undefined)
          : await this.ai.generate(ownerId, reservation.campaign.contentId, missing, aiProvider, undefined, imagePlan);
      const drafts: DraftVariant[] = [...kept, ...generated];
      const slugByPlatform = new Map(accounts.map((account) => [account.platformId, account.platform.slug]));
      const variants = await this.attachGeneratedImages(ownerId, drafts, slugByPlatform, imagePlan, background?.assertOwnership);
      const variantByPlatform = new Map(variants.map((variant) => [variant.platformId, variant]));
      if (variantByPlatform.size !== platformSlugs.length) {
        throw new ConflictException('AI did not generate exactly one variant for every selected platform');
      }

      if (background?.processingId) {
        await background.assertOwnership?.();
        await this.prisma.campaign.update({
          where: { id: reservation.campaign.id },
          data: { automationState: 'WAITING_REVIEW', automationErrorCode: null, automationVariantIds: variants.map((variant) => variant.id) },
        });
        return this.result(ownerId, reservation.campaign.id);
      }

      // Credentials and account state can change while the model is generating.
      accounts = await this.loadConnectedAccounts(ownerId, dto.platformAccountIds);

      // Only drafts that passed the AI quality check are auto-approved. The rest
      // wait in "needs action" until an operator approves or edits them.
      const approvable = variants.filter((variant) => variant.recommended);
      await this.prisma.$transaction(async (transaction) => {
        const approved = await transaction.contentVariant.updateMany({
          where: {
            id: { in: approvable.map((variant) => variant.id) },
            contentId: reservation.campaign.contentId,
            status: VariantStatus.GENERATED,
          },
          data: { status: VariantStatus.APPROVED },
        });
        if (approved.count !== approvable.length) {
          throw new ConflictException('One or more generated variants could not be approved');
        }

        for (const account of accounts) {
          const variant = variantByPlatform.get(account.platformId);
          if (!variant) throw new ConflictException(`No generated variant is available for ${account.platform.slug}`);
          const target = await transaction.campaignTarget.create({
            data: {
              campaignId: reservation.campaign.id,
              platformAccountId: account.id,
              contentVariantId: variant.id,
              overrides: {},
            },
          });
          await transaction.publishJob.create({
            data: {
              campaignTargetId: target.id,
              platformAccountId: account.id,
              idempotencyKey: stableIdempotencyKey(reservation.campaign.id, account.id, variant.id),
              scheduledAt,
              ...(variant.recommended
                ? { status: PublishJobStatus.SCHEDULED }
                : {
                  status: PublishJobStatus.NEEDS_ACTION,
                  lastErrorCode: CONTENT_REVIEW_REQUIRED_CODE,
                  lastErrorMessage: (variant.reason ?? 'Nội dung cần được duyệt trước khi đăng').slice(0, 1_000),
                }),
            },
          });
        }

        await transaction.content.update({
          where: { id: reservation.campaign.contentId },
          data: { status: ContentStatus.APPROVED },
        });
        await transaction.campaign.update({
          where: { id: reservation.campaign.id },
          data: { automationErrorCode: null },
        });
      });
      targetsCreated = true;

      if (publishImmediately) await this.campaigns.publish(ownerId, reservation.campaign.id);

      await this.audit.recordBestEffort({
        actorId: ownerId,
        action: 'CAMPAIGN_AUTOMATION_SUCCEEDED',
        entityType: 'campaigns',
        entityId: reservation.campaign.id,
        requestId,
        after: {
          accountCount: accounts.length,
          generatedVariants: variants.length,
          mediaAssetCount: mediaAssetIds.length,
          aiProvider,
          activated: publishImmediately,
        },
      });
      return this.result(ownerId, reservation.campaign.id);
    } catch (error) {
      const errorCode = this.safeErrorCode(error);
      if (!targetsCreated) {
        await this.prisma.campaign.updateMany({
          where: { id: reservation.campaign.id, ownerId, targets: { none: {} } },
          data: { automationErrorCode: errorCode },
        });
      }
      await this.audit.recordBestEffort({
        actorId: ownerId,
        action: 'CAMPAIGN_AUTOMATION_FAILED',
        entityType: 'campaigns',
        entityId: reservation.campaign.id,
        requestId,
        after: { errorCode, stage: targetsCreated ? 'activation' : 'generation' },
      });
      throw error;
    }
  }

  async approveExistingContent(ownerId: string, contentId: string, dto: ReviewExistingContentDto) {
    const automationKey = stableIdempotencyKey('review-existing-content', ownerId, contentId, ...[...dto.variantIds].sort(), ...[...dto.platformAccountIds].sort());
    const existing = await this.prisma.campaign.findFirst({ where: { ownerId, automationKey } });
    if (existing) return this.approve(ownerId, existing.id, dto);
    const content = await this.prisma.content.findFirstOrThrow({ where: { id: contentId, ownerId } });
    const accounts = await this.loadConnectedAccounts(ownerId, dto.platformAccountIds);
    const variants = await this.prisma.contentVariant.findMany({
      where: { id: { in: dto.variantIds }, contentId, status: { in: [VariantStatus.GENERATED, VariantStatus.APPROVED] }, targets: { none: {} } },
    });
    const platforms = new Set(variants.map((variant) => variant.platformId));
    if (variants.length !== dto.variantIds.length || platforms.size !== variants.length || accounts.some((account) => !platforms.has(account.platformId))) {
      throw new ConflictException('Choose one unused variant per destination platform');
    }
    const campaign = await this.prisma.campaign.upsert({
      where: { ownerId_automationKey: { ownerId, automationKey } }, update: {},
      create: {
        ownerId, contentId, name: content.title, status: CampaignStatus.DRAFT,
        automationKey, automationState: 'WAITING_REVIEW', automationVariantIds: dto.variantIds,
        automationRequest: { name: content.title, brief: content.body, platformAccountIds: dto.platformAccountIds, publishImmediately: false },
      },
    });
    return this.approve(ownerId, campaign.id, dto);
  }

  async approve(ownerId: string, id: string, dto: ApproveAiCampaignDto = {}) {
    const campaign = await this.prisma.campaign.findFirstOrThrow({ where: { id, ownerId } });
    if (campaign.automationState === 'APPROVED') {
      if (campaign.status === CampaignStatus.DRAFT) await this.campaigns.publish(ownerId, id);
      return this.result(ownerId, id);
    }
    if (campaign.automationState !== 'WAITING_REVIEW') throw new ConflictException('Campaign is not waiting for review');
    const scheduledAt = reviewSchedule(dto);
    // Some platforms were already approved or rejected one by one: approve the rest.
    if (await this.hasDecidedVariants(campaign)) return this.decideVariants(ownerId, id, 'approve', dto);
    const request = campaign.automationRequest as unknown as AutomateCampaignDto;
    const accounts = await this.loadConnectedAccounts(ownerId, request.platformAccountIds);
    await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.campaign.updateMany({
        where: { id, ownerId, status: CampaignStatus.DRAFT, automationState: 'WAITING_REVIEW' },
        data: { automationState: 'APPROVED', scheduledAt },
      });
      if (!claimed.count) throw new ConflictException('Campaign review has already changed');
      const variants = await tx.contentVariant.findMany({
        where: { id: { in: campaign.automationVariantIds }, contentId: campaign.contentId, status: { in: [VariantStatus.GENERATED, VariantStatus.APPROVED] }, targets: { none: {} } },
      });
      const byPlatform = new Map(variants.map((variant) => [variant.platformId, variant]));
      if (variants.length !== campaign.automationVariantIds.length || accounts.some((account) => !byPlatform.get(account.platformId)?.body.trim())) {
        throw new ConflictException('Every destination needs a non-empty generated variant. Review the content again.');
      }
      await tx.contentVariant.updateMany({ where: { id: { in: variants.map((variant) => variant.id) } }, data: { status: VariantStatus.APPROVED } });
      for (const account of accounts) {
        const variant = byPlatform.get(account.platformId)!;
        const target = await tx.campaignTarget.create({ data: {
          campaignId: id, platformAccountId: account.id, contentVariantId: variant.id, overrides: {},
        } });
        await tx.publishJob.create({ data: {
          campaignTargetId: target.id, platformAccountId: account.id,
          idempotencyKey: stableIdempotencyKey(id, account.id, variant.id),
          scheduledAt, status: PublishJobStatus.SCHEDULED,
        } });
      }
      await tx.content.update({ where: { id: campaign.contentId }, data: { status: ContentStatus.APPROVED } });
    });
    await this.audit.recordBestEffort({ actorId: ownerId, action: 'CAMPAIGN_AI_APPROVED', entityType: 'campaigns', entityId: id });
    await this.campaigns.publish(ownerId, id);
    return this.result(ownerId, id);
  }

  /** Approves one platform's draft: its accounts get publish jobs, the other platforms keep waiting. */
  approveVariant(ownerId: string, id: string, variantId: string, dto: ApproveAiCampaignDto = {}) {
    return this.decideVariants(ownerId, id, 'approve', dto, variantId);
  }

  /** Rejects one platform's draft: it is never published; the other platforms keep waiting. */
  rejectVariant(ownerId: string, id: string, variantId: string) {
    return this.decideVariants(ownerId, id, 'reject', {}, variantId);
  }

  private async hasDecidedVariants(campaign: { automationVariantIds: string[] }): Promise<boolean> {
    return (await this.prisma.contentVariant.count({
      where: { id: { in: campaign.automationVariantIds }, OR: [{ status: VariantStatus.REJECTED }, { targets: { some: {} } }] },
    })) > 0;
  }

  /**
   * Approves or rejects the drafts still waiting (only `variantId` when given).
   * The review stays open until every platform is decided; it then becomes
   * APPROVED, or REJECTED when nothing was approved.
   */
  private async decideVariants(ownerId: string, id: string, action: 'approve' | 'reject', dto: ApproveAiCampaignDto = {}, variantId?: string) {
    const scheduledAt = action === 'approve' ? reviewSchedule(dto) : new Date();
    const campaign = await this.prisma.campaign.findFirstOrThrow({ where: { id, ownerId } });
    if (campaign.automationState !== 'WAITING_REVIEW') throw new ConflictException('Campaign is not waiting for review');
    if (variantId && !campaign.automationVariantIds.includes(variantId)) throw new NotFoundException('This draft is not part of the campaign');
    const request = campaign.automationRequest as unknown as AutomateCampaignDto;
    const accounts = action === 'approve' ? await this.loadConnectedAccounts(ownerId, request.platformAccountIds) : [];
    let publishDraft = false;
    await this.prisma.$transaction(async (tx) => {
      // Serializes decisions on one campaign so a draft never gets two sets of jobs.
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${id}, 7311))::text`;
      const current = await tx.campaign.findFirst({ where: { id, ownerId, automationState: 'WAITING_REVIEW' } });
      if (!current) throw new ConflictException('Campaign review has already changed');
      const pending = await tx.contentVariant.findMany({
        where: { id: { in: variantId ? [variantId] : current.automationVariantIds }, contentId: current.contentId, status: { in: [VariantStatus.GENERATED, VariantStatus.APPROVED] }, targets: { none: {} } },
      });
      if (!pending.length) throw new ConflictException(variantId ? 'This draft was already approved or rejected' : 'No draft is waiting for review');
      if (action === 'approve') {
        for (const variant of pending) {
          if (!variant.body.trim()) throw new ConflictException('A draft is empty. Edit it before approving.');
          if (!accounts.some((account) => account.platformId === variant.platformId)) {
            throw new ConflictException('No connected account is left for this platform. Reconnect it before approving.');
          }
        }
        await tx.contentVariant.updateMany({ where: { id: { in: pending.map((variant) => variant.id) } }, data: { status: VariantStatus.APPROVED } });
        for (const variant of pending) {
          for (const account of accounts.filter((item) => item.platformId === variant.platformId)) {
            const target = await tx.campaignTarget.create({ data: { campaignId: id, platformAccountId: account.id, contentVariantId: variant.id, overrides: {} } });
            await tx.publishJob.create({ data: {
              campaignTargetId: target.id, platformAccountId: account.id,
              idempotencyKey: stableIdempotencyKey(id, account.id, variant.id),
              scheduledAt, status: PublishJobStatus.SCHEDULED,
            } });
          }
        }
        await tx.content.update({ where: { id: current.contentId }, data: { status: ContentStatus.APPROVED } });
      } else {
        await tx.contentVariant.updateMany({ where: { id: { in: pending.map((variant) => variant.id) }, targets: { none: {} } }, data: { status: VariantStatus.REJECTED } });
      }
      const undecided = await tx.contentVariant.count({
        where: { id: { in: current.automationVariantIds }, status: { in: [VariantStatus.GENERATED, VariantStatus.APPROVED] }, targets: { none: {} } },
      });
      const approvedAny = await tx.campaignTarget.count({ where: { campaignId: id } }) > 0;
      publishDraft = action === 'approve' && current.status === CampaignStatus.DRAFT;
      // A campaign that already finished its earlier posts runs again for the new ones;
      // the scheduler then sends every due job of a SCHEDULED or RUNNING campaign.
      const reopen = action === 'approve' && !publishDraft && current.status !== CampaignStatus.RUNNING && current.status !== CampaignStatus.SCHEDULED;
      await tx.campaign.update({
        where: { id },
        data: {
          ...(undecided ? {} : { automationState: approvedAny ? 'APPROVED' : 'REJECTED' }),
          ...(publishDraft ? { scheduledAt } : {}),
          ...(reopen ? { status: scheduledAt > new Date() ? CampaignStatus.SCHEDULED : CampaignStatus.RUNNING } : {}),
        },
      });
    });
    await this.audit.recordBestEffort({
      actorId: ownerId, action: action === 'approve' ? 'CAMPAIGN_AI_APPROVED' : 'CAMPAIGN_AI_REJECTED', entityType: 'campaigns', entityId: id,
      after: { variantId: variantId ?? null, scope: variantId ? 'platform' : 'remaining' },
    });
    if (publishDraft) {
      try { await this.campaigns.publish(ownerId, id); }
      catch (error) {
        // A parallel decision published the campaign first; the scheduler sends these jobs.
        if (!(error instanceof ConflictException)) throw error;
      }
    }
    return this.result(ownerId, id);
  }

  /** Returns rejected drafts to review without regenerating content or creating publish jobs. */
  async restore(ownerId: string, id: string, variantId?: string) {
    await this.prisma.$transaction(async (tx) => {
      // Share the per-platform decision lock; the conditional update also locks out bulk decisions.
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${id}, 7311))::text`;
      const current = await tx.campaign.findFirst({ where: { id, ownerId } });
      if (!current) throw new NotFoundException('Campaign not found');
      if (!['REJECTED', 'WAITING_REVIEW', 'APPROVED'].includes(current.automationState ?? '')) {
        throw new ConflictException('Only rejected content can be restored for review');
      }
      if (variantId && !current.automationVariantIds.includes(variantId)) {
        throw new NotFoundException('This draft is not part of the campaign');
      }
      const claimed = await tx.campaign.updateMany({
        where: { id, ownerId, automationState: current.automationState, updatedAt: current.updatedAt },
        data: { automationState: 'WAITING_REVIEW' },
      });
      if (!claimed.count) throw new ConflictException('Campaign review has already changed');
      // Older bulk rejections changed only the campaign state, leaving drafts GENERATED/APPROVED.
      const statuses = !variantId && current.automationState === 'REJECTED'
        ? [VariantStatus.REJECTED, VariantStatus.GENERATED, VariantStatus.APPROVED]
        : [VariantStatus.REJECTED];
      const restored = await tx.contentVariant.updateMany({
        where: {
          id: { in: variantId ? [variantId] : current.automationVariantIds },
          contentId: current.contentId, content: { ownerId },
          status: { in: statuses }, targets: { none: {} },
        },
        data: { status: VariantStatus.GENERATED },
      });
      if (!restored.count) throw new ConflictException('No rejected, unpublished draft is available to restore');
    });
    await this.audit.recordBestEffort({
      actorId: ownerId, action: 'CAMPAIGN_AI_RESTORED', entityType: 'campaigns', entityId: id,
      after: { variantId: variantId ?? null, scope: variantId ? 'platform' : 'rejected' },
    });
    return this.result(ownerId, id);
  }

  async retry(ownerId: string, id: string) {
    const updated = await this.prisma.campaign.updateMany({
      where: { id, ownerId, automationState: 'FAILED', targets: { none: {} } },
      data: { automationState: 'QUEUED', automationErrorCode: null },
    });
    if (!updated.count) throw new ConflictException('Only failed AI tasks can be retried');
    return this.result(ownerId, id);
  }

  async reject(ownerId: string, id: string) {
    const campaign = await this.prisma.campaign.findFirst({ where: { id, ownerId, automationState: 'WAITING_REVIEW' } });
    // After per-platform decisions, "reject" drops only the drafts still waiting.
    if (campaign && await this.hasDecidedVariants(campaign)) return this.decideVariants(ownerId, id, 'reject');
    const updated = await this.prisma.campaign.updateMany({
      where: { id, ownerId, automationState: 'WAITING_REVIEW', targets: { none: {} } },
      data: { automationState: 'REJECTED' },
    });
    if (!updated.count) throw new ConflictException('Only content waiting for review can be rejected');
    await this.audit.recordBestEffort({ actorId: ownerId, action: 'CAMPAIGN_AI_REJECTED', entityType: 'campaigns', entityId: id });
    return this.result(ownerId, id);
  }

  private async loadConnectedAccounts(ownerId: string, accountIds: string[]): Promise<ConnectedAccount[]> {
    if (new Set(accountIds).size !== accountIds.length) {
      throw new BadRequestException('A platform account can only appear once per automation');
    }
    const found = await this.prisma.platformAccount.findMany({
      where: {
        id: { in: accountIds },
        ownerId,
        enabled: true,
        status: AccountStatus.CONNECTED,
        platform: { enabled: true },
      },
      select: {
        id: true,
        platformId: true,
        settings: true,
        credential: { select: { status: true, expiresAt: true } },
        platform: true,
      },
    });
    if (found.length !== accountIds.length) {
      throw new BadRequestException('Every selected account must belong to you and be enabled, connected, and ready');
    }
    // Extension delivery makes any forum automatic, including catalog MANUAL platforms.
    const unsupported = found.filter((account) => !AUTOMATION_PLATFORM_MODES.has(account.platform.mode) && !isExtensionDelivery(account.settings));
    if (unsupported.length) {
      throw new BadRequestException(
        `Automatic publishing is unavailable for: ${unsupported.map((account) => account.platform.slug).join(', ')}`,
      );
    }
    const browserNotReady: string[] = [];
    for (const account of found) {
      if (isExtensionDelivery(account.settings) && (account.settings as Record<string, unknown>).extensionAutoSubmit === false) {
        throw new BadRequestException('Enable automatic submission for every selected Chrome account before one-click publishing');
      }
      if (account.platform.mode !== PlatformMode.BROWSER_ASSISTED || isExtensionDelivery(account.settings)) continue;
      const settings = account.settings !== null
        && typeof account.settings === 'object'
        && !Array.isArray(account.settings)
        ? account.settings as Record<string, unknown>
        : {};
      const policyReady = settings.automationPermissionAttested === true
        && settings.browserAutoSubmit === true;
      const credentialActive = account.credential?.status === CredentialStatus.ACTIVE
        && (!account.credential.expiresAt || account.credential.expiresAt.getTime() > Date.now());
      let sessionReady = false;
      if (policyReady && credentialActive && this.credentials) {
        try {
          sessionReady = hasUsableBrowserStorageState(await this.credentials.resolve(account.id));
        } catch {
          sessionReady = false;
        }
      }
      if (!policyReady || !credentialActive || !sessionReady) {
        browserNotReady.push(account.platform.slug);
      }
    }
    if (browserNotReady.length) {
      throw new BadRequestException(
        `Browser automation requires a captured login session, permission attestation, and auto-submit for: ${browserNotReady.join(', ')}`,
      );
    }
    const byId = new Map(found.map((account) => [account.id, account]));
    return accountIds.map((id) => byId.get(id)!);
  }

  /**
   * One VPSTTT AI image per planned destination, from the description the
   * writer produced. A failed image never loses the text: optional images
   * leave a note, a required one (Pixelfed) holds the draft for review.
   * Variants that already carry an image (a resumed run) are left as they are.
   */
  private async attachGeneratedImages(
    ownerId: string,
    variants: DraftVariant[],
    slugByPlatform: Map<string, string>,
    plan: Map<string, PlatformImagePlan>,
    assertOwnership?: () => Promise<void>,
  ): Promise<DraftVariant[]> {
    const images = this.images;
    const media = this.media;
    if (!plan.size || !images || !media) return variants;
    const results: DraftVariant[] = [];
    for (const variant of variants) {
      const slug = slugByPlatform.get(variant.platformId);
      const image = slug ? plan.get(slug) : undefined;
      if (!image || await this.prisma.mediaAsset.count({ where: { variantId: variant.id, type: MediaType.IMAGE } })) {
        results.push(variant);
        continue;
      }
      const request = variant.mediaRecommendation && typeof variant.mediaRecommendation === 'object' && !Array.isArray(variant.mediaRecommendation)
        ? variant.mediaRecommendation as Record<string, unknown> : {};
      const prompt = typeof request.prompt === 'string' && request.prompt.trim() ? request.prompt.trim() : image.style;
      const altText = typeof request.altText === 'string' ? request.altText : '';
      // A lost worker lease must stop the run, not be recorded as an image failure.
      await assertOwnership?.();
      let failure: string | undefined;
      try {
        const generated = await images.generate(prompt, image.size);
        await assertOwnership?.();
        await media.storeGeneratedImage(ownerId, variant.id, generated, { altText, prompt });
      } catch (error) {
        if (error instanceof ConflictException) throw error;
        failure = error instanceof ApplicationException ? error.message : 'Không tạo được ảnh bằng VPSTTT AI.';
        this.logger.warn(`AI image for ${slug} failed: ${failure}`);
      }
      const required = image.need === 'required';
      const reason = failure && required ? `Chưa tạo được ảnh bắt buộc cho kênh này: ${failure}`.slice(0, 1_000) : variant.reason;
      await this.prisma.contentVariant.update({
        where: { id: variant.id },
        data: {
          mediaRecommendation: { ...request, type: 'image', prompt, altText, size: image.size, status: failure ? 'failed' : 'generated', ...(failure ? { error: failure } : {}) },
          ...(failure && required ? { recommended: false, reason } : {}),
        },
      });
      results.push(failure && required ? { ...variant, recommended: false, reason } : variant);
    }
    return results;
  }

  private async validateMediaAssets(
    ownerId: string,
    mediaAssetIds: string[],
    reservationContentId?: string,
  ): Promise<void> {
    if (!mediaAssetIds.length) return;
    const assets = await this.prisma.mediaAsset.findMany({
      where: { id: { in: mediaAssetIds }, ownerId },
      select: { id: true, contentId: true, variantId: true },
    });
    if (assets.length !== mediaAssetIds.length) {
      throw new BadRequestException('Every selected media asset must belong to you');
    }
    const unavailable = assets.some((asset: SelectedMediaAsset) => (
      asset.variantId !== null
      || (asset.contentId !== null && asset.contentId !== reservationContentId)
    ));
    if (unavailable) {
      throw new ConflictException('Every selected media asset must be unattached');
    }
  }

  private async attachMediaAssets(
    ownerId: string,
    contentId: string,
    mediaAssetIds: string[],
  ): Promise<void> {
    if (!mediaAssetIds.length) return;
    await this.prisma.$transaction(async (transaction) => {
      const attached = await transaction.mediaAsset.updateMany({
        where: {
          id: { in: mediaAssetIds },
          ownerId,
          variantId: null,
          OR: [{ contentId: null }, { contentId }],
        },
        data: { contentId },
      });
      if (attached.count !== mediaAssetIds.length) {
        throw new ConflictException('One or more selected media assets are no longer available');
      }
    });
  }

  private async findOrCreateReservation(input: {
    ownerId: string;
    automationKey: string;
    requestHash: string;
    name: string;
    brief: string;
    scheduledAt: Date;
    timezone: string;
    backgroundRequest?: AutomateCampaignDto & { idempotencyKey: string };
  }) {
    const existing = await this.findReservation(input.ownerId, input.automationKey);
    if (existing) return { campaign: existing, created: false };

    try {
      const created = await this.prisma.$transaction(async (transaction) => {
        const content = await transaction.content.create({
          data: {
            ownerId: input.ownerId,
            title: input.name,
            body: input.brief,
            summary: input.brief.slice(0, 500),
            language: 'vi',
            // The title is the internal campaign name; the AI writes its own headline.
            aiAnalysis: { kind: 'brief' },
            contentHash: sha256(`${input.name}\n${input.brief}`),
            status: ContentStatus.DRAFT,
          },
        });
        return transaction.campaign.create({
          data: {
            ownerId: input.ownerId,
            contentId: content.id,
            name: input.name,
            scheduledAt: input.scheduledAt,
            timezone: input.timezone,
            status: CampaignStatus.DRAFT,
            automationKey: input.automationKey,
            automationRequestHash: input.requestHash,
            ...(input.backgroundRequest ? {
              automationState: 'QUEUED',
              automationRequest: input.backgroundRequest as unknown as Prisma.InputJsonObject,
            } : {}),
          },
          include: { content: true, targets: { include: { publishJobs: true } } },
        });
      });
      return { campaign: created, created: true };
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') throw error;
      const winner = await this.findReservation(input.ownerId, input.automationKey);
      if (!winner) throw error;
      return { campaign: winner, created: false };
    }
  }

  private findReservation(ownerId: string, automationKey: string) {
    return this.prisma.campaign.findFirst({
      where: { ownerId, automationKey },
      include: { content: true, targets: { include: { publishJobs: true } } },
    });
  }

  private async claimRetry(
    ownerId: string,
    campaign: { id: string; contentId: string; automationErrorCode: string | null; updatedAt: Date },
  ): Promise<void> {
    const staleBefore = new Date(Date.now() - AUTOMATION_STALE_AFTER_MS);
    if (!campaign.automationErrorCode && campaign.updatedAt > staleBefore) {
      throw new ConflictException('This campaign automation is already running');
    }
    const claimed = await this.prisma.campaign.updateMany({
      where: {
        id: campaign.id,
        ownerId,
        targets: { none: {} },
        ...(campaign.automationErrorCode
          ? { automationErrorCode: campaign.automationErrorCode }
          : { automationErrorCode: null, updatedAt: { lte: staleBefore } }),
      },
      data: { automationErrorCode: null },
    });
    if (!claimed.count) throw new ConflictException('This campaign automation is already running');
    if (!campaign.automationErrorCode) {
      await this.prisma.content.updateMany({
        where: { id: campaign.contentId, ownerId, status: ContentStatus.AI_GENERATING },
        data: { status: ContentStatus.DRAFT },
      });
    }
  }

  private async replayCompleted(
    ownerId: string,
    campaign: { id: string; status: CampaignStatus },
    publishImmediately: boolean,
    requestId?: string,
  ) {
    if (publishImmediately && campaign.status === CampaignStatus.DRAFT) {
      await this.campaigns.publish(ownerId, campaign.id);
    }
    await this.audit.recordBestEffort({
      actorId: ownerId,
      action: 'CAMPAIGN_AUTOMATION_REPLAYED',
      entityType: 'campaigns',
      entityId: campaign.id,
      requestId,
    });
    return this.result(ownerId, campaign.id);
  }

  private async result(ownerId: string, campaignId: string) {
    const [campaign, content] = await Promise.all([
      this.campaigns.get(ownerId, campaignId),
      this.prisma.content.findFirstOrThrow({ where: { ownerId, campaigns: { some: { id: campaignId } } } }),
    ]);
    const targetList = campaign.targets ?? [];
    return {
      campaign,
      content,
      generatedVariants: campaign.automationVariantIds?.length || new Set(targetList.map((target) => target.contentVariantId)).size,
      jobsCreated: targetList.reduce((total, target) => total + target.publishJobs.length, 0),
      activated: campaign.status !== CampaignStatus.DRAFT,
    };
  }

  private normalizeIdempotencyKey(value: string | undefined): string {
    const key = value?.trim();
    if (!key) throw new BadRequestException('Idempotency-Key header is required');
    if (key.length < 8 || key.length > 128 || !/^[A-Za-z0-9._:-]+$/.test(key)) {
      throw new BadRequestException('Idempotency-Key must be 8-128 safe ASCII characters');
    }
    return key;
  }

  private validateTimezone(timezone: string): void {
    try {
      new Intl.DateTimeFormat('en', { timeZone: timezone }).format();
    } catch {
      throw new BadRequestException('timezone must be a valid IANA timezone');
    }
  }

  private safeErrorCode(error: unknown): string {
    if (error instanceof ApplicationException) return error.code;
    if (error instanceof BadRequestException) return ErrorCode.VALIDATION_FAILED;
    if (error instanceof ConflictException) return ErrorCode.CONFLICT;
    return ErrorCode.INTERNAL_ERROR;
  }
}
