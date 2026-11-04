import { BadRequestException, HttpException, HttpStatus, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, PublishJobStatus } from '@prisma/client';
import { AiContentService } from '../../ai/ai-content.service';
import { AiProvider } from '../../ai/ai-provider';
import { ApplicationException } from '../../common/exceptions/application.exception';
import { EXTENSION_CONNECTOR_KEY, parseExtensionDeliverySettings } from '../../connectors/extension/extension-delivery';
import { PrismaService } from '../../database/prisma.service';
import { renderForExtension } from '../../platforms/post-text';
import { RedisService } from '../../queue/redis.service';
import { taskPostLanguage, type AuthenticatedDevice } from '../extension-agent.service';
import { FormFillRequestDto } from './form-fill.dto';
import {
  describeControl, FORM_FILL_INSTRUCTIONS, FORM_FILL_SPEC, FormAction, FormControl, sanitizeControls, validateFormActions,
} from './form-fill.rules';
import { FORM_FILL_HINT, HINTS_PER_DEVICE_PER_HOUR, INLINE_WAIT_MS, STALE_AFTER_MS, uiHintRateKey } from './ui-recovery.service';

/** Separate from the UI hint cap: a form can need one look before and one after a page step. */
const MAX_FORM_FILLS_PER_JOB = 2;

export interface FormFillView {
  hintId: string;
  status: 'RUNNING' | 'READY' | 'FAILED';
  actions?: FormAction[];
  confidence?: number;
  errorCode?: string;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/**
 * When a post form has extra controls the recipe does not know (post
 * language, Lemmy / Discuit community, NSFW flag, flair…), the AI proposes
 * values from the post's own facts. The backend keeps only actions on the
 * controls the extension described, with values from their own options, and
 * never on title / body editors, credentials or consent boxes.
 */
@Injectable()
export class ExtensionFormFillService {
  private readonly logger = new Logger(ExtensionFormFillService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly ai: AiContentService,
    @Optional() private readonly redis?: RedisService,
  ) {}

  enabled(): boolean {
    return this.config.get<boolean>('EXTENSION_AI_FORM_FILL_ENABLED') === true;
  }

  async request(device: AuthenticatedDevice, jobId: string, dto: FormFillRequestDto): Promise<FormFillView> {
    if (!this.enabled()) throw new NotFoundException('AI form filling is disabled');
    const job = await this.prisma.publishJob.findFirst({
      where: {
        id: jobId, status: PublishJobStatus.NEEDS_ACTION, lockedAt: { not: null }, extensionClaimDeviceId: device.id, lastErrorCode: null,
        target: { campaign: { ownerId: device.ownerId } },
        platformAccount: { settings: { path: ['delivery'], equals: EXTENSION_CONNECTOR_KEY } },
      },
      select: {
        id: true,
        platformAccount: { select: { settings: true, platform: { select: { name: true, slug: true } } } },
        target: { select: { contentVariant: { select: { title: true, body: true, hashtags: true, content: { select: { canonicalUrl: true } } } } } },
      },
    });
    if (!job) throw new NotFoundException('Claimed extension task not found');
    const settings = parseExtensionDeliverySettings(job.platformAccount.settings);
    const origin = new URL(settings.targetUrl).origin;
    const page = new URL(dto.url);
    if (page.origin !== origin) throw new BadRequestException('The page is not on this task destination');
    if (await this.prisma.extensionUiHint.count({ where: { publishJobId: job.id, missing: { has: FORM_FILL_HINT } } }) >= MAX_FORM_FILLS_PER_JOB) {
      throw new HttpException('This task already used its AI form fills', HttpStatus.TOO_MANY_REQUESTS);
    }
    const usage = await this.redis?.consumeRateLimit(uiHintRateKey(device.id), HINTS_PER_DEVICE_PER_HOUR, 3_600);
    if (usage && !usage.allowed) throw new HttpException('Too many AI hints from this Chrome profile; try again later', HttpStatus.TOO_MANY_REQUESTS);
    let controls: FormControl[];
    try { controls = sanitizeControls(dto.controls); } catch (error) { throw new BadRequestException(error instanceof Error ? error.message : 'Invalid controls'); }
    const path = page.pathname.slice(0, 300);

    // Facts come from the job on the server, never from the page.
    const { platform } = job.platformAccount;
    const variant = job.target.contentVariant;
    const post = renderForExtension(variant, platform.slug, settings.engine, variant.content.canonicalUrl);
    const language = taskPostLanguage(post.body, variant, platform.slug, settings.engine);
    // Configured tags first, then the post's own; duplicates in any letter case once.
    const seen = new Set<string>();
    const tags = [...(settings.tags ?? []), ...variant.hashtags].map((tag) => tag.trim().replace(/^#+/, '').trim())
      .filter((tag) => tag && !seen.has(tag.toLowerCase()) && seen.add(tag.toLowerCase())).slice(0, 10);
    const input = JSON.stringify({
      engine: settings.engine,
      path,
      post: {
        platform: platform.name,
        language: language === 'vi' ? 'Vietnamese' : 'English',
        title: post.title.slice(0, 300),
        tags,
        community: settings.category || null,
        flair: settings.flair || null,
      },
      controls: controls.map(describeControl),
    });

    const hint = await this.prisma.extensionUiHint.create({
      data: {
        ownerId: device.ownerId, publishJobId: job.id, deviceId: device.id, engine: settings.engine, origin, path, missing: [FORM_FILL_HINT],
        candidates: controls.map((control) => ({ ...describeControl(control), selector: control.selector })), status: 'RUNNING',
      },
      select: { id: true },
    });
    const work = this.resolve(hint.id, input, controls);
    await Promise.race([work, new Promise((resolve) => { setTimeout(resolve, INLINE_WAIT_MS).unref?.(); })]);
    return this.get(device, job.id, hint.id);
  }

  async get(device: AuthenticatedDevice, jobId: string, hintId: string): Promise<FormFillView> {
    if (!this.enabled()) throw new NotFoundException('AI form filling is disabled');
    const hint = await this.prisma.extensionUiHint.findFirst({
      where: { id: hintId, publishJobId: jobId, deviceId: device.id, ownerId: device.ownerId, missing: { has: FORM_FILL_HINT } },
      select: { id: true, status: true, result: true, errorCode: true, createdAt: true },
    });
    if (!hint) throw new NotFoundException('AI form fill not found');
    if (hint.status === 'RUNNING' && Date.now() - hint.createdAt.getTime() > STALE_AFTER_MS) {
      await this.prisma.extensionUiHint.updateMany({ where: { id: hint.id, status: 'RUNNING' }, data: { status: 'FAILED', errorCode: 'TIMEOUT', finishedAt: new Date() } });
      return { hintId: hint.id, status: 'FAILED', errorCode: 'TIMEOUT' };
    }
    if (hint.status === 'READY') {
      const result = record(hint.result);
      return {
        hintId: hint.id, status: 'READY',
        actions: Array.isArray(result.actions) ? result.actions as FormAction[] : [],
        ...(typeof result.confidence === 'number' ? { confidence: result.confidence } : {}),
        ...(hint.errorCode ? { errorCode: hint.errorCode } : {}),
      };
    }
    return { hintId: hint.id, status: hint.status === 'FAILED' ? 'FAILED' : 'RUNNING', ...(hint.errorCode ? { errorCode: hint.errorCode } : {}) };
  }

  /** Never throws: the outcome is stored on the hint row. */
  private async resolve(hintId: string, input: string, controls: FormControl[]): Promise<void> {
    const provider = this.config.get<AiProvider>('EXTENSION_UI_HINT_PROVIDER');
    try {
      const answer = await this.ai.generateStructured(FORM_FILL_SPEC, FORM_FILL_INSTRUCTIONS, input, provider);
      const minConfidence = Number(this.config.get<number>('EXTENSION_UI_HINT_MIN_CONFIDENCE', 0.6));
      const decision = validateFormActions(answer, controls, minConfidence);
      await this.prisma.extensionUiHint.update({
        where: { id: hintId },
        data: {
          status: 'READY', provider: provider ?? null, finishedAt: new Date(), errorCode: decision.errorCode ?? null,
          result: { actions: decision.actions, confidence: answer.confidence, reason: answer.reason.slice(0, 300), proposed: answer.actions.length } as unknown as Prisma.InputJsonObject,
        },
      });
    } catch (error) {
      const code = error instanceof ApplicationException ? error.code : 'AI_FORM_FILL_FAILED';
      this.logger.warn(`AI form fill ${hintId} failed: ${error instanceof Error ? error.message : 'unknown error'}`);
      await this.prisma.extensionUiHint.update({ where: { id: hintId }, data: { status: 'FAILED', errorCode: String(code).slice(0, 80), finishedAt: new Date() } })
        .catch(() => undefined);
    }
  }
}
