import { BadRequestException, HttpException, HttpStatus, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, PublishJobStatus } from '@prisma/client';
import { AiContentService } from '../../ai/ai-content.service';
import { AiProvider } from '../../ai/ai-provider';
import { ApplicationException } from '../../common/exceptions/application.exception';
import { EXTENSION_CONNECTOR_KEY, EXTENSION_RECIPES, parseExtensionDeliverySettings } from '../../connectors/extension/extension-delivery';
import { PrismaService } from '../../database/prisma.service';
import { RedisService } from '../../queue/redis.service';
import type { AuthenticatedDevice } from '../extension-agent.service';
import { UiHintField, UiHintRequestDto } from './ui-hint.dto';
import { sanitizeCandidates, UI_HINT_INSTRUCTIONS, UI_HINT_SPEC, UiCandidate, validateHint } from './ui-hint.rules';

const MAX_HINTS_PER_JOB = 2;
/** Shared by UI hints and AI form filling: one hourly budget per Chrome profile. */
export const HINTS_PER_DEVICE_PER_HOUR = 20;
export const uiHintRateKey = (deviceId: string) => `rate_limit:ui-hint:${deviceId}`;
/** The extension's single fetch must stay short (MV3); later answers are polled. */
export const INLINE_WAIT_MS = 8_000;
export const STALE_AFTER_MS = 120_000;
/** `missing` value of the hint rows AI form filling stores; they have their own cap. */
export const FORM_FILL_HINT = 'form';

export interface UiHintSelector { selector: string; approved: boolean; suggestionId: string }
export interface UiHintView {
  hintId: string;
  status: 'RUNNING' | 'READY' | 'FAILED';
  selectors?: Partial<Record<UiHintField, UiHintSelector>>;
  confidence?: number;
  errorCode?: string;
}

/** What the AI and the operator see of an element: never its selector or value. */
function describeCandidate(candidate: UiCandidate): Prisma.InputJsonObject {
  const { index, kind, tag, type, role, label, placeholder, text, name, id, inDialog, inForm, disabled } = candidate;
  return JSON.parse(JSON.stringify({ index, kind, tag, type, role, label, placeholder, text, name, id, inDialog, inForm, disabled })) as Prisma.InputJsonObject;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/**
 * When the extension cannot find a composer control, the AI picks among the
 * visible elements the extension described (by index only). Picks become
 * selector suggestions; an ADMIN approves them before they run with
 * automatic submit.
 */
@Injectable()
export class ExtensionUiRecoveryService {
  private readonly logger = new Logger(ExtensionUiRecoveryService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly ai: AiContentService,
    @Optional() private readonly redis?: RedisService,
  ) {}

  enabled(): boolean {
    return this.config.get<boolean>('EXTENSION_UI_RECOVERY_ENABLED') === true;
  }

  async request(device: AuthenticatedDevice, jobId: string, dto: UiHintRequestDto): Promise<UiHintView> {
    if (!this.enabled()) throw new NotFoundException('AI-assisted UI recovery is disabled');
    const job = await this.prisma.publishJob.findFirst({
      where: {
        id: jobId, status: PublishJobStatus.NEEDS_ACTION, lockedAt: { not: null }, extensionClaimDeviceId: device.id, lastErrorCode: null,
        target: { campaign: { ownerId: device.ownerId } },
        platformAccount: { settings: { path: ['delivery'], equals: EXTENSION_CONNECTOR_KEY } },
      },
      select: { id: true, platformAccount: { select: { settings: true } } },
    });
    if (!job) throw new NotFoundException('Claimed extension task not found');
    const settings = parseExtensionDeliverySettings(job.platformAccount.settings);
    const origin = new URL(settings.targetUrl).origin;
    const page = new URL(dto.url);
    if (page.origin !== origin) throw new BadRequestException('The page is not on this task destination');
    if (await this.prisma.extensionUiHint.count({ where: { publishJobId: job.id, NOT: { missing: { has: FORM_FILL_HINT } } } }) >= MAX_HINTS_PER_JOB) {
      throw new HttpException('This task already used its AI hints', HttpStatus.TOO_MANY_REQUESTS);
    }
    const usage = await this.redis?.consumeRateLimit(uiHintRateKey(device.id), HINTS_PER_DEVICE_PER_HOUR, 3_600);
    if (usage && !usage.allowed) throw new HttpException('Too many AI hints from this Chrome profile; try again later', HttpStatus.TOO_MANY_REQUESTS);
    let candidates: UiCandidate[];
    try { candidates = sanitizeCandidates(dto.candidates); } catch (error) { throw new BadRequestException(error instanceof Error ? error.message : 'Invalid candidates'); }
    const missing = [...new Set(dto.missing)];
    const path = page.pathname.slice(0, 300);
    const hint = await this.prisma.extensionUiHint.create({
      data: {
        ownerId: device.ownerId, publishJobId: job.id, deviceId: device.id, engine: settings.engine, origin, path, missing,
        candidates: candidates.map((candidate) => ({ ...describeCandidate(candidate), selector: candidate.selector })), status: 'RUNNING',
      },
      select: { id: true },
    });
    const work = this.resolve(hint.id, device.ownerId, settings.engine, origin, path, missing, candidates);
    await Promise.race([work, new Promise((resolve) => { setTimeout(resolve, INLINE_WAIT_MS).unref?.(); })]);
    return this.get(device, job.id, hint.id);
  }

  async get(device: AuthenticatedDevice, jobId: string, hintId: string): Promise<UiHintView> {
    const hint = await this.prisma.extensionUiHint.findFirst({
      where: { id: hintId, publishJobId: jobId, deviceId: device.id, ownerId: device.ownerId },
      select: { id: true, status: true, result: true, errorCode: true, createdAt: true },
    });
    if (!hint) throw new NotFoundException('AI hint not found');
    if (hint.status === 'RUNNING' && Date.now() - hint.createdAt.getTime() > STALE_AFTER_MS) {
      await this.prisma.extensionUiHint.updateMany({ where: { id: hint.id, status: 'RUNNING' }, data: { status: 'FAILED', errorCode: 'TIMEOUT', finishedAt: new Date() } });
      return { hintId: hint.id, status: 'FAILED', errorCode: 'TIMEOUT' };
    }
    if (hint.status === 'READY') {
      const result = record(hint.result);
      return { hintId: hint.id, status: 'READY', selectors: record(result.selectors), confidence: typeof result.confidence === 'number' ? result.confidence : undefined };
    }
    return { hintId: hint.id, status: hint.status === 'FAILED' ? 'FAILED' : 'RUNNING', ...(hint.errorCode ? { errorCode: hint.errorCode } : {}) };
  }

  /** Never throws: the outcome is stored on the hint row. */
  private async resolve(hintId: string, ownerId: string, engine: string, origin: string, path: string, missing: UiHintField[], candidates: UiCandidate[]): Promise<void> {
    const provider = this.config.get<AiProvider>('EXTENSION_UI_HINT_PROVIDER');
    try {
      const recipe = EXTENSION_RECIPES[engine as keyof typeof EXTENSION_RECIPES];
      if (!recipe) throw new BadRequestException('Unknown extension engine');
      // Only element descriptions leave the browser; the post being written does not.
      const input = JSON.stringify({ engine, path, missing, titleField: recipe.titleSelectors.length > 0, candidates: candidates.map(describeCandidate) });
      const answer = await this.ai.generateStructured(UI_HINT_SPEC, UI_HINT_INSTRUCTIONS, input, provider);
      const minConfidence = Number(this.config.get<number>('EXTENSION_UI_HINT_MIN_CONFIDENCE', 0.6));
      const picks = validateHint(answer, missing, candidates, recipe, minConfidence);
      const selectors: Partial<Record<UiHintField, UiHintSelector>> = {};
      for (const { field, candidate } of picks) {
        const { selector } = candidate;
        const summary = describeCandidate(candidate);
        const suggestion = await this.prisma.extensionSelectorSuggestion.upsert({
          where: { ownerId_engine_origin_field_selector: { ownerId, engine, origin, field, selector } },
          create: { ownerId, engine, origin, field, selector, sampleUrl: `${origin}${path}`, elementSummary: summary, confidence: answer.confidence, lastHintId: hintId },
          update: { seenCount: { increment: 1 }, sampleUrl: `${origin}${path}`, elementSummary: summary, confidence: answer.confidence, lastHintId: hintId },
          select: { id: true, status: true },
        });
        // A rejected selector is never offered to the extension again.
        if (suggestion.status === 'REJECTED') continue;
        selectors[field] = { selector, approved: suggestion.status === 'APPROVED', suggestionId: suggestion.id };
      }
      await this.prisma.extensionUiHint.update({
        where: { id: hintId },
        data: { status: 'READY', provider: provider ?? null, finishedAt: new Date(),
          result: { selectors, confidence: answer.confidence, reason: answer.reason.slice(0, 300), picked: picks.map((pick) => pick.candidate.index) } as unknown as Prisma.InputJsonObject },
      });
    } catch (error) {
      const code = error instanceof ApplicationException ? error.code : 'AI_HINT_FAILED';
      this.logger.warn(`AI UI hint ${hintId} failed: ${error instanceof Error ? error.message : 'unknown error'}`);
      await this.prisma.extensionUiHint.update({ where: { id: hintId }, data: { status: 'FAILED', errorCode: String(code).slice(0, 80), finishedAt: new Date() } })
        .catch(() => undefined);
    }
  }
}
