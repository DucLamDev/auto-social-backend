import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import {
  AccountStatus,
  CampaignStatus,
  ContentStatus,
  PlatformMode,
  Prisma,
  PublishJobStatus,
  VariantStatus,
} from '@prisma/client';
import { AiContentService } from '../ai/ai-content.service';
import { AuditService } from '../audit/audit.service';
import { ApplicationException, ErrorCode } from '../common/exceptions/application.exception';
import { sha256, stableIdempotencyKey } from '../common/utils/crypto.utils';
import { PrismaService } from '../database/prisma.service';
import { CampaignsService } from './campaigns.service';
import { AutomateCampaignDto } from './dto/automate-campaign.dto';

const AUTOMATION_STALE_AFTER_MS = 20 * 60 * 1000;
const MAX_PLATFORMS_PER_AUTOMATION = 12;
const AUTOMATIC_PLATFORM_MODES = new Set<PlatformMode>([
  PlatformMode.OFFICIAL_API,
  PlatformMode.COMPATIBLE_API,
]);

type ConnectedAccount = {
  id: string;
  platformId: string;
  platform: { id: string; slug: string; mode: PlatformMode };
};

@Injectable()
export class CampaignAutomationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ai: AiContentService,
    private readonly campaigns: CampaignsService,
    private readonly audit: AuditService,
  ) {}

  async automate(
    ownerId: string,
    dto: AutomateCampaignDto,
    rawIdempotencyKey: string | undefined,
    requestId?: string,
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
    const publishImmediately = dto.publishImmediately ?? true;
    const automationKey = stableIdempotencyKey('campaign-automation', ownerId, idempotencyKey);
    const requestHash = sha256(JSON.stringify({
      name,
      brief,
      platformAccountIds: [...dto.platformAccountIds].sort(),
      scheduledAt: dto.scheduledAt ?? null,
      timezone,
      publishImmediately,
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
    if (alreadyReserved?.targets.length) {
      return this.replayCompleted(ownerId, alreadyReserved, publishImmediately, requestId);
    }
    if (!alreadyReserved && dto.scheduledAt && scheduledAt <= new Date()) {
      throw new BadRequestException('scheduledAt must be in the future; omit it to publish now');
    }

    let accounts: ConnectedAccount[];
    let platformSlugs: string[];
    try {
      accounts = await this.loadConnectedAccounts(ownerId, dto.platformAccountIds);
      platformSlugs = [...new Set(accounts.map((account) => account.platform.slug))];
      if (platformSlugs.length > MAX_PLATFORMS_PER_AUTOMATION) {
        throw new BadRequestException(`A campaign automation supports at most ${MAX_PLATFORMS_PER_AUTOMATION} platforms`);
      }
      await this.ai.assertReady(platformSlugs);
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
      });

    if (reservation.campaign.automationRequestHash !== requestHash) {
      throw new ConflictException('Idempotency-Key was already used with a different automation request');
    }

    if (reservation.campaign.targets.length > 0) {
      return this.replayCompleted(ownerId, reservation.campaign, publishImmediately, requestId);
    }

    if (!reservation.created) await this.claimRetry(ownerId, reservation.campaign);

    await this.audit.recordBestEffort({
      actorId: ownerId,
      action: 'CAMPAIGN_AUTOMATION_STARTED',
      entityType: 'campaigns',
      entityId: reservation.campaign.id,
      requestId,
      after: { accountCount: accounts.length, platformCount: platformSlugs.length, resumed: !reservation.created },
    });

    let targetsCreated = false;
    try {
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
          select: { id: true, platformId: true },
        });
      const reusableByPlatform = new Map<string, { id: string; platformId: string }>();
      for (const variant of reusable) {
        if (!reusableByPlatform.has(variant.platformId)) reusableByPlatform.set(variant.platformId, variant);
      }
      if (reusable.length && reusableByPlatform.size !== platformSlugs.length) {
        await this.prisma.contentVariant.updateMany({
          where: { id: { in: reusable.map((variant) => variant.id) }, targets: { none: {} } },
          data: { status: VariantStatus.REJECTED },
        });
      }
      const variants = reusableByPlatform.size === platformSlugs.length
        ? [...reusableByPlatform.values()]
        : await this.ai.generate(ownerId, reservation.campaign.contentId, platformSlugs);
      const variantByPlatform = new Map(variants.map((variant) => [variant.platformId, variant]));
      if (variantByPlatform.size !== platformSlugs.length) {
        throw new ConflictException('AI did not generate exactly one variant for every selected platform');
      }

      // Credentials and account state can change while the model is generating.
      accounts = await this.loadConnectedAccounts(ownerId, dto.platformAccountIds);

      await this.prisma.$transaction(async (transaction) => {
        const approved = await transaction.contentVariant.updateMany({
          where: {
            id: { in: variants.map((variant) => variant.id) },
            contentId: reservation.campaign.contentId,
            status: VariantStatus.GENERATED,
          },
          data: { status: VariantStatus.APPROVED },
        });
        if (approved.count !== variants.length) {
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
              status: PublishJobStatus.SCHEDULED,
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
      select: { id: true, platformId: true, platform: { select: { id: true, slug: true, mode: true } } },
    });
    if (found.length !== accountIds.length) {
      throw new BadRequestException('Every selected account must belong to you and be enabled, connected, and ready');
    }
    const manual = found.filter((account) => !AUTOMATIC_PLATFORM_MODES.has(account.platform.mode));
    if (manual.length) {
      throw new BadRequestException(
        `Automatic publishing is unavailable for: ${manual.map((account) => account.platform.slug).join(', ')}`,
      );
    }
    const byId = new Map(found.map((account) => [account.id, account]));
    return accountIds.map((id) => byId.get(id)!);
  }

  private async findOrCreateReservation(input: {
    ownerId: string;
    automationKey: string;
    requestHash: string;
    name: string;
    brief: string;
    scheduledAt: Date;
    timezone: string;
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
      generatedVariants: new Set(targetList.map((target) => target.contentVariantId)).size,
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
