import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import {
  AccountStatus,
  AttemptStatus,
  CampaignStatus,
  Prisma,
  PublishJobStatus,
  VariantStatus,
} from '@prisma/client';
import { AiContentService } from '../ai/ai-content.service';
import { CampaignStatusService } from '../campaigns/campaign-status.service';
import { stableIdempotencyKey } from '../common/utils/crypto.utils';
import { PrismaService } from '../database/prisma.service';
import { PublishQueueService } from '../queue/publish-queue.service';
import { ApproveContentDto } from './dto/approve-content.dto';
import { ManualPublishedDto } from './dto/manual-published.dto';
import { ListPublishJobsQueryDto } from './dto/list-publish-jobs-query.dto';
import { paginatedData } from '../common/interceptors/api-response.interceptor';
import { PublishJobMetricsQueryDto } from './dto/publish-job-metrics-query.dto';
import { CONTENT_REVIEW_REQUIRED_CODE, SUBMITTED_EXTENSION_CODES, WORKER_CRASH_UNCERTAIN_RESULT_CODE } from './publishing.constants';
import { collectPublishMedia } from './publishing.service';
import { reviewDestination } from './review-destination';
import { contractFor, deliveryEngine } from '../platforms/post-length';
import { postFooter } from '../platforms/post-text';

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

/** Same normalization as Studio: no leading #, no blanks, case-insensitive duplicates removed. */
function uniqueHashtags(values: string[]): string[] {
  const seen = new Set<string>();
  return values.map((value) => value.trim().replace(/^#+/, '').trim()).filter((tag) => {
    const key = tag.toLowerCase();
    if (!tag || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const SAFE_BROWSER_RESUME_REASONS = new Set([
  'AUTOMATION_BUSY',
  'AUTOMATION_DISABLED',
  'AUTOMATION_FAILED',
  'CAPTCHA_REQUIRED',
  'EDITOR_NOT_FOUND',
  'LOGIN_REQUIRED',
  'SECURITY_CHECK_REQUIRED',
  'SUBMISSION_CONFIRMATION_REQUIRED',
  'TWO_FACTOR_REQUIRED',
]);

@Injectable()
export class PublishJobsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: PublishQueueService,
    private readonly campaignStatus: CampaignStatusService,
    private readonly ai: AiContentService,
  ) {}

  async list(ownerId: string, query: ListPublishJobsQueryDto) {
    const search = query.search?.trim();
    const where: Prisma.PublishJobWhereInput = {
      target: { campaign: { ownerId } },
      ...(query.status ? { status: query.status } : {}),
      ...(query.reviewState === 'MODERATION' ? {
        AND: [
          { status: PublishJobStatus.NEEDS_ACTION },
          { OR: [
            { lastErrorCode: { in: SUBMITTED_EXTENSION_CODES } },
            { attempts: { some: { responseMetadata: { path: ['moderationQueue'], equals: true } } } },
          ] },
        ],
      } : {}),
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
        platformAccount: {
          select: {
            id: true,
            name: true,
            enabled: true,
            status: true,
            settings: true,
            platform: { select: { slug: true, name: true } },
          },
        },
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
    const publicItems = items.map(item => {
      const { settings, ...account } = item.platformAccount;
      return { ...item, platformAccount: account, ...reviewDestination(asRecord(settings)) };
    });
    return paginatedData(publicItems, {
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
      await this.prisma.publishJob.updateMany({
        where: { id, status: PublishJobStatus.QUEUED },
        data: {
          status: PublishJobStatus.RETRY,
          nextAttemptAt: new Date(Date.now() + 30_000),
        },
      });
      throw error;
    }
    return { queued: true };
  }

  /**
   * Releases a job the AI quality check held back. Variants are immutable once
   * in a campaign, so the approved (optionally edited) text becomes a new
   * variant version and the target points to it. Nothing was sent before, so
   * scheduling it cannot duplicate a post.
   */
  async approveContent(ownerId: string, id: string, dto: ApproveContentDto) {
    // This creates an approved version straight from (possibly edited) text,
    // which the final AI approver never read.
    if (this.ai.approvalEnabled()) {
      throw new BadRequestException('AI duyệt cuối đang bật: bài phải được AI duyệt trước khi đăng. Sửa và duyệt bài ở "Content đợi duyệt".');
    }
    const job = await this.prisma.publishJob.findFirstOrThrow({
      where: { id, target: { campaign: { ownerId } } },
      include: {
        target: { include: { contentVariant: { include: { media: { select: { id: true } } } } } },
        _count: { select: { attempts: true } },
      },
    });
    if (job.status !== PublishJobStatus.NEEDS_ACTION || job.lastErrorCode !== CONTENT_REVIEW_REQUIRED_CODE || job._count.attempts > 0) {
      throw new BadRequestException('Only jobs held by the AI content review can be approved here');
    }
    const previous = job.target.contentVariant;
    if (previous.media.length) {
      throw new BadRequestException('This variant has its own media; approve it from Studio instead');
    }
    const body = dto.body === undefined ? previous.body : dto.body.trim();
    if (!body) throw new BadRequestException('body must not be blank');
    const title = dto.title === undefined ? previous.title : dto.title?.trim() || null;
    const hashtags = dto.hashtags === undefined ? previous.hashtags : uniqueHashtags(dto.hashtags);
    const variantId = await this.prisma.$transaction(async (transaction) => {
      const latest = await transaction.contentVariant.aggregate({
        where: { contentId: previous.contentId, platformId: previous.platformId },
        _max: { version: true },
      });
      const variant = await transaction.contentVariant.create({
        data: {
          contentId: previous.contentId,
          platformId: previous.platformId,
          title,
          body,
          summary: previous.summary,
          hashtags,
          cta: previous.cta,
          recommended: true,
          reason: 'Người vận hành đã duyệt sau khi AI giữ lại',
          mediaRecommendation: previous.mediaRecommendation ?? Prisma.JsonNull,
          status: VariantStatus.APPROVED,
          version: (latest._max.version ?? 0) + 1,
        },
      });
      const released = await transaction.publishJob.updateMany({
        where: { id, status: PublishJobStatus.NEEDS_ACTION, lastErrorCode: CONTENT_REVIEW_REQUIRED_CODE, attempts: { none: {} } },
        data: {
          status: PublishJobStatus.SCHEDULED,
          lastErrorCode: null,
          lastErrorMessage: null,
          idempotencyKey: stableIdempotencyKey(job.target.campaignId, job.platformAccountId, variant.id),
        },
      });
      if (!released.count) throw new ConflictException('The job changed while it was being approved');
      await transaction.campaignTarget.update({ where: { id: job.campaignTargetId }, data: { contentVariantId: variant.id } });
      await transaction.campaign.updateMany({
        where: { id: job.target.campaignId, status: CampaignStatus.PARTIAL },
        data: { status: CampaignStatus.RUNNING },
      });
      return variant.id;
    }).catch((error: unknown) => {
      // A concurrent approval took the same variant version number.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException('The job changed while it was being approved');
      }
      throw error;
    });
    return { queued: true, contentVariantId: variantId };
  }

  async reconcileNotFound(ownerId: string, id: string, confirmedNotFound: boolean) {
    if (confirmedNotFound !== true) {
      throw new BadRequestException('Explicit not-found confirmation is required');
    }
    const job = await this.prisma.publishJob.findFirstOrThrow({
      where: { id, target: { campaign: { ownerId } } },
      include: {
        platformAccount: { include: { platform: true } },
        target: { select: { campaignId: true } },
        attempts: { orderBy: { attemptNumber: 'desc' }, take: 1 },
      },
    });
    const attempt = job.attempts[0];
    const responseMetadata = attempt?.responseMetadata
      && typeof attempt.responseMetadata === 'object'
      && !Array.isArray(attempt.responseMetadata)
      ? attempt.responseMetadata as Record<string, unknown>
      : {};
    const workerCrashUncertain = job.lastErrorCode === WORKER_CRASH_UNCERTAIN_RESULT_CODE;
    const connectorSubmissionUncertain = responseMetadata.reconciliationRequired === true
      && responseMetadata.submissionUncertain === true
      && responseMetadata.moderationQueue !== true
      && responseMetadata.providerAccepted !== true
      && responseMetadata.persistenceRecoveryRequired !== true;
    if (
      job.status !== PublishJobStatus.NEEDS_ACTION
      || (!connectorSubmissionUncertain && !workerCrashUncertain)
    ) {
      throw new BadRequestException(
        'Only an uncertain submission confirmed absent from the provider can be queued again',
      );
    }

    await this.prisma.$transaction(async (transaction) => {
      const claimed = await transaction.publishJob.updateMany({
        where: { id, status: PublishJobStatus.NEEDS_ACTION },
        data: {
          status: PublishJobStatus.QUEUED,
          nextAttemptAt: null,
          lockedAt: null,
          lastErrorCode: null,
          lastErrorMessage: null,
        },
      });
      if (!claimed.count) {
        throw new BadRequestException('The publish job is no longer awaiting reconciliation');
      }
      if (attempt) {
        await transaction.publishAttempt.update({
          where: { id: attempt.id },
          data: {
            responseMetadata: {
              ...responseMetadata,
              operatorConfirmedNotFound: true,
              operatorConfirmedNotFoundAt: new Date().toISOString(),
            },
          },
        });
      }
      await transaction.campaign.updateMany({
        where: { id: job.target.campaignId, status: CampaignStatus.PARTIAL },
        data: { status: CampaignStatus.RUNNING },
      });
    });
    try {
      await this.queue.enqueue(job.id, job.platformAccount.platform.slug);
    } catch (error) {
      await this.prisma.publishJob.updateMany({
        where: { id, status: PublishJobStatus.QUEUED },
        data: {
          status: PublishJobStatus.RETRY,
          nextAttemptAt: new Date(Date.now() + 30_000),
        },
      });
      throw error;
    }
    return { queued: true };
  }

  /**
   * Requeues only browser attempts which explicitly stopped before the final
   * provider boundary. An uncertain/accepted submission can only use the
   * reconciliation flow, so this endpoint can never become a blind retry.
   */
  async resumeBrowser(ownerId: string, id: string) {
    const job = await this.prisma.publishJob.findFirstOrThrow({
      where: { id, target: { campaign: { ownerId } } },
      include: {
        platformAccount: { include: { platform: true } },
        target: { select: { campaignId: true } },
        attempts: { orderBy: { attemptNumber: 'desc' }, take: 1 },
      },
    });
    const attempt = job.attempts[0];
    const responseMetadata = asRecord(attempt?.responseMetadata);
    const reason = responseMetadata.reason;
    const knownPreSubmitPause = responseMetadata.browserAssisted === true
      && typeof reason === 'string'
      && SAFE_BROWSER_RESUME_REASONS.has(reason)
      && responseMetadata.submissionUncertain !== true
      && responseMetadata.reconciliationRequired !== true
      && responseMetadata.providerAccepted !== true
      && responseMetadata.persistenceRecoveryRequired !== true
      && responseMetadata.moderationQueue !== true;
    if (job.status !== PublishJobStatus.NEEDS_ACTION || !knownPreSubmitPause) {
      throw new BadRequestException(
        'Only a browser task known to have paused before submission can be resumed',
      );
    }
    if (
      !job.platformAccount.enabled
      || job.platformAccount.status !== AccountStatus.CONNECTED
      || job.platformAccount.platform.connectorKey !== 'browser-assisted'
    ) {
      throw new BadRequestException(
        'Reconnect and test the browser-assisted account before resuming this job',
      );
    }

    await this.prisma.$transaction(async (transaction) => {
      const claimed = await transaction.publishJob.updateMany({
        where: { id, status: PublishJobStatus.NEEDS_ACTION },
        data: {
          status: PublishJobStatus.QUEUED,
          nextAttemptAt: null,
          lockedAt: null,
          lastErrorCode: null,
          lastErrorMessage: null,
        },
      });
      if (!claimed.count) {
        throw new BadRequestException('The browser publish job is no longer awaiting action');
      }
      if (attempt) {
        await transaction.publishAttempt.update({
          where: { id: attempt.id },
          data: {
            responseMetadata: {
              ...responseMetadata,
              operatorResumed: true,
              operatorResumedAt: new Date().toISOString(),
            },
          },
        });
      }
      await transaction.campaign.updateMany({
        where: { id: job.target.campaignId, status: CampaignStatus.PARTIAL },
        data: { status: CampaignStatus.RUNNING },
      });
    });
    try {
      await this.queue.enqueue(job.id, job.platformAccount.platform.slug);
    } catch (error) {
      // Returning to NEEDS_ACTION is conservative. A confirm response may have
      // been lost; if a worker already claimed the row this conditional update
      // changes nothing, and otherwise there is still no automatic replay.
      await this.prisma.publishJob.updateMany({
        where: { id, status: PublishJobStatus.QUEUED },
        data: { status: PublishJobStatus.NEEDS_ACTION },
      });
      await this.campaignStatus.refresh(job.target.campaignId);
      throw error;
    }
    return { queued: true };
  }

  async manualPayload(ownerId: string, id: string) {
    const job = await this.prisma.publishJob.findFirstOrThrow({
      where: { id, target: { campaign: { ownerId } } },
      include: {
        platformAccount: { include: { platform: true } },
        target: {
          include: {
            contentVariant: {
              include: { content: { include: { media: true } }, media: true },
            },
          },
        },
        attempts: { orderBy: { attemptNumber: 'desc' }, take: 1 },
      },
    });
    const defaults: Record<string, string> = {
      reddit: 'https://www.reddit.com/submit',
      tiktok: 'https://www.tiktok.com/upload',
    };
    const settings = asRecord(job.platformAccount.settings);
    const platformDefaults = asRecord(job.platformAccount.platform.defaultSettings);
    const manualUrl = settings.manualUrl;
    const defaultManualUrl = platformDefaults.manualUrl;
    const blogUrl = settings.blogUrl;
    const responseMetadata = job.attempts[0]?.responseMetadata;
    const result = responseMetadata && typeof responseMetadata === 'object' && !Array.isArray(responseMetadata)
      ? responseMetadata as Record<string, unknown>
      : {};
    return {
      jobId: job.id,
      status: job.status,
      platform: job.platformAccount.platform.slug,
      platformName: job.platformAccount.platform.name,
      accountName: job.platformAccount.name,
      moderationPending: job.status === PublishJobStatus.NEEDS_ACTION
        && (job.lastErrorCode === 'EXTENSION_MODERATION_PENDING' || result.moderationQueue === true),
      contentUpdatedAt: job.target.contentVariant.updatedAt,
      ...reviewDestination(settings),
      title: job.target.contentVariant.title,
      body: job.target.contentVariant.body,
      summary: job.target.contentVariant.summary,
      hashtags: job.target.contentVariant.hashtags,
      cta: job.target.contentVariant.cta,
      canonicalUrl: job.target.contentVariant.content.canonicalUrl,
      // The company footer the post ends with on this destination ('' → null), printed last by the copy.
      footer: postFooter(
        job.target.contentVariant,
        contractFor({ platformSlug: job.platformAccount.platform.slug, engine: deliveryEngine(settings), body: job.target.contentVariant.body }),
        job.target.contentVariant.content.canonicalUrl,
      ) || null,
      media: collectPublishMedia(
        job.target.contentVariant.content.media,
        job.target.contentVariant.media,
      ),
      suggestedExternalPostId: typeof result.externalPostId === 'string' ? result.externalPostId : undefined,
      openUrl: typeof manualUrl === 'string'
        ? manualUrl
        : typeof result.url === 'string'
          ? result.url
          : typeof blogUrl === 'string'
            ? blogUrl
            : typeof defaultManualUrl === 'string'
              ? defaultManualUrl
              : defaults[job.platformAccount.platform.slug],
    };
  }

  async markPublished(ownerId: string, id: string, dto: ManualPublishedDto) {
    const job = await this.prisma.publishJob.findFirstOrThrow({
      where: { id, target: { campaign: { ownerId } } },
      include: { target: { select: { campaignId: true } }, attempts: { orderBy: { attemptNumber: 'desc' }, take: 1, select: { responseMetadata: true } } },
    });
    if (job.status !== PublishJobStatus.NEEDS_ACTION) throw new BadRequestException('Only NEEDS_ACTION jobs can be manually marked published');
    // An extension run that stopped before sending the post (sign-in, CAPTCHA, editor…) has
    // nothing on the platform to confirm: it goes back to the extension instead. Only a post
    // the platform received (waiting for its moderators) or one sent without confirmation can be.
    const [latest] = job.attempts ?? [];
    const metadata = asRecord(latest?.responseMetadata);
    if (metadata.extensionQueued === true && !SUBMITTED_EXTENSION_CODES.includes(job.lastErrorCode ?? '')) {
      throw new BadRequestException('This post was never sent to the platform; hand it to the extension again instead of marking it published');
    }
    await this.confirmPublished(job.id, { platformAccountId: job.platformAccountId, externalPostId: dto.externalPostId, url: dto.url, source: 'manual' });
    await this.campaignStatus.refresh(job.target.campaignId);
    return { published: true };
  }

  /**
   * Turns a post awaiting confirmation into a published post: by hand, or when the
   * moderation sync finds it on the platform. Fails when the job left NEEDS_ACTION.
   */
  async confirmPublished(id: string, input: { platformAccountId: string; externalPostId: string; url?: string; source: 'manual' | 'sync' }) {
    await this.prisma.$transaction(async (transaction) => {
      const claimed = await transaction.publishJob.updateMany({
        where: { id, status: PublishJobStatus.NEEDS_ACTION },
        data: {
          status: PublishJobStatus.PUBLISHED,
          nextAttemptAt: null,
          lockedAt: null,
          lastErrorCode: null,
          lastErrorMessage: null,
        },
      });
      if (!claimed.count) {
        throw new BadRequestException('The publish job is no longer awaiting confirmation');
      }
      const attempt = await transaction.publishAttempt.findFirst({ where: { publishJobId: id }, orderBy: { attemptNumber: 'desc' } });
      const existingMetadata = attempt?.responseMetadata
        && typeof attempt.responseMetadata === 'object'
        && !Array.isArray(attempt.responseMetadata)
        ? attempt.responseMetadata as Record<string, unknown>
        : {};
      const existingUrl = typeof existingMetadata.url === 'string'
        ? existingMetadata.url
        : undefined;
      const publishedUrl = input.url ?? existingUrl;
      const confirmationMetadata = {
        ...existingMetadata,
        ...(input.source === 'manual' ? { manual: true, manualConfirmed: true } : { autoSynced: true, autoSyncedAt: new Date().toISOString() }),
        externalPostId: input.externalPostId,
        ...(publishedUrl ? { url: publishedUrl } : {}),
      } as Prisma.InputJsonObject;
      await transaction.publishedPost.create({ data: { publishJobId: id, platformAccountId: input.platformAccountId, externalPostId: input.externalPostId, url: publishedUrl, metadata: confirmationMetadata } });
      if (attempt) {
        await transaction.publishAttempt.update({
          where: { id: attempt.id },
          data: {
            status: AttemptStatus.SUCCEEDED,
            finishedAt: new Date(),
            responseMetadata: confirmationMetadata,
            errorCode: null,
            errorMessage: null,
          },
        });
      }
    });
  }
}
