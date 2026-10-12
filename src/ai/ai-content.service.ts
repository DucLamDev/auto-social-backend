import { HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ContentStatus, VariantStatus } from '@prisma/client';
import OpenAI from 'openai';
import { zodResponseFormat } from 'openai/helpers/zod';
import { z } from 'zod';
import { ApplicationException, ErrorCode } from '../common/exceptions/application.exception';
import { PrismaService } from '../database/prisma.service';
import {
  AI_PROVIDER_IDS,
  AI_PROVIDER_LABELS,
  AiProvider,
  isAiProvider,
} from './ai-provider';

const VariantSchema = z.object({
  platform: z.string(),
  title: z.string().nullable(),
  body: z.string().min(1),
  summary: z.string().nullable(),
  hashtags: z.array(z.string()),
  cta: z.string().nullable(),
  recommended: z.boolean(),
  reason: z.string(),
  media: z.object({ type: z.enum(['none', 'image', 'video', 'document']), altText: z.string() }),
});

export type GeneratedVariant = z.infer<typeof VariantSchema>;

const outputSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['platform', 'title', 'body', 'summary', 'hashtags', 'cta', 'recommended', 'reason', 'media'],
  properties: {
    platform: { type: 'string' },
    title: { type: ['string', 'null'] },
    body: { type: 'string' },
    summary: { type: ['string', 'null'] },
    hashtags: { type: 'array', items: { type: 'string' } },
    cta: { type: ['string', 'null'] },
    recommended: { type: 'boolean' },
    reason: { type: 'string' },
    media: {
      type: 'object',
      additionalProperties: false,
      required: ['type', 'altText'],
      properties: {
        type: { type: 'string', enum: ['none', 'image', 'video', 'document'] },
        altText: { type: 'string' },
      },
    },
  },
} as const;

const PROVIDER_API_KEY_ENV: Record<AiProvider, string> = {
  openai: 'OPENAI_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
  gemini: 'GEMINI_API_KEY',
};

const PROVIDER_MODEL_ENV: Record<AiProvider, string> = {
  openai: 'OPENAI_MODEL',
  deepseek: 'DEEPSEEK_MODEL',
  gemini: 'GEMINI_MODEL',
};

const PROVIDER_DEFAULT_MODELS: Record<AiProvider, string> = {
  openai: 'gpt-5-mini',
  deepseek: 'deepseek-flash',
  gemini: 'gemini-3.5-flash',
};

const DEFAULT_GEMINI_FALLBACK_MODEL = 'gemini-3.5-flash-lite';
const GEMINI_PRIMARY_MAX_ATTEMPTS = 2;
const GEMINI_RETRY_DELAY_MS = 750;

const CONNECTION_ERROR_NAMES = new Set([
  'APIConnectionError',
  'FetchError',
]);

const CONNECTION_ERROR_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOTFOUND',
  'EAI_AGAIN',
  'UND_ERR_CONNECT',
]);

const TIMEOUT_ERROR_NAMES = new Set([
  'APIConnectionTimeoutError',
  'TimeoutError',
]);

const TIMEOUT_ERROR_CODES = new Set([
  'ETIMEDOUT',
  'ESOCKETTIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
]);

export interface AiProviderDescriptor {
  id: AiProvider;
  label: string;
  model: string;
  configured: boolean;
  isDefault: boolean;
}

@Injectable()
export class AiContentService {
  private readonly clients: Partial<Record<AiProvider, OpenAI>> = {};
  private readonly models: Record<AiProvider, string>;
  private readonly defaultProvider: AiProvider;
  private readonly geminiFallbackModel?: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {
    const configuredDefault = config.get<string>('AI_DEFAULT_PROVIDER', 'openai').trim().toLowerCase();
    this.defaultProvider = isAiProvider(configuredDefault) ? configuredDefault : 'openai';
    this.models = Object.fromEntries(AI_PROVIDER_IDS.map((provider) => [
      provider,
      config.get<string>(PROVIDER_MODEL_ENV[provider], PROVIDER_DEFAULT_MODELS[provider]).trim()
        || PROVIDER_DEFAULT_MODELS[provider],
    ])) as Record<AiProvider, string>;
    const configuredGeminiFallback = config
      .get<string>('GEMINI_FALLBACK_MODEL', DEFAULT_GEMINI_FALLBACK_MODEL)
      .trim();
    this.geminiFallbackModel = configuredGeminiFallback
      && configuredGeminiFallback !== this.models.gemini
      ? configuredGeminiFallback
      : undefined;

    const timeout = config.get<number>(
      'AI_TIMEOUT_MS',
      config.get<number>('OPENAI_TIMEOUT_MS', 60_000),
    );
    for (const provider of AI_PROVIDER_IDS) {
      const apiKey = config.get<string>(PROVIDER_API_KEY_ENV[provider])?.trim();
      if (!apiKey) continue;
      this.clients[provider] = new OpenAI({
        apiKey,
        timeout,
        ...(provider === 'gemini' ? { maxRetries: 0 } : {}),
        ...(provider === 'deepseek' ? { baseURL: 'https://api.deepseek.com' } : {}),
        ...(provider === 'gemini'
          ? {
              baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/',
              defaultHeaders: { 'x-goog-api-client': 'social-publisher-oai/0.1.0' },
            }
          : {}),
      });
    }
  }

  providers(): AiProviderDescriptor[] {
    return AI_PROVIDER_IDS.map((provider) => ({
      id: provider,
      label: AI_PROVIDER_LABELS[provider],
      model: this.models[provider],
      configured: Boolean(this.clients[provider]),
      isDefault: provider === this.defaultProvider,
    }));
  }

  resolveProvider(requested?: string): AiProvider {
    const provider = requested ?? this.defaultProvider;
    if (!isAiProvider(provider)) {
      throw new ApplicationException(
        ErrorCode.VALIDATION_FAILED,
        `Unsupported AI provider '${String(provider)}'`,
        HttpStatus.BAD_REQUEST,
      );
    }
    return provider;
  }

  async assertReady(platformSlugs: string[], requestedProvider?: AiProvider): Promise<void> {
    const provider = this.resolveProvider(requestedProvider);
    this.clientFor(provider);
    const uniqueSlugs = [...new Set(platformSlugs)];
    const platforms = await this.prisma.platform.findMany({
      where: { slug: { in: uniqueSlugs }, enabled: true },
      select: {
        slug: true,
        prompts: { where: { active: true }, select: { id: true }, take: 1 },
      },
    });
    if (platforms.length !== uniqueSlugs.length) {
      throw new ApplicationException(
        ErrorCode.RESOURCE_NOT_FOUND,
        'One or more selected platforms are missing or disabled',
        HttpStatus.NOT_FOUND,
      );
    }
    const withoutPrompt = platforms.filter((platform) => platform.prompts.length === 0).map((platform) => platform.slug);
    if (withoutPrompt.length) {
      throw new ApplicationException(
        ErrorCode.RESOURCE_NOT_FOUND,
        `No active AI prompt for: ${withoutPrompt.join(', ')}`,
        HttpStatus.NOT_FOUND,
      );
    }
  }

  async generate(
    ownerId: string,
    contentId: string,
    platformSlugs: string[],
    requestedProvider?: AiProvider,
  ) {
    const provider = this.resolveProvider(requestedProvider);
    this.clientFor(provider);
    const content = await this.prisma.content.findFirstOrThrow({ where: { id: contentId, ownerId } });
    const platforms = await this.prisma.platform.findMany({
      where: { slug: { in: platformSlugs }, enabled: true },
      include: { prompts: { where: { active: true }, orderBy: { version: 'desc' }, take: 1 } },
    });
    if (platforms.length !== new Set(platformSlugs).size) throw new ApplicationException(ErrorCode.RESOURCE_NOT_FOUND, 'One or more platforms are missing or disabled', HttpStatus.NOT_FOUND);
    if (content.status === ContentStatus.AI_GENERATING) {
      throw new ApplicationException(ErrorCode.CONFLICT, 'Content generation is already running', HttpStatus.CONFLICT);
    }
    const claimed = await this.prisma.content.updateMany({
      where: { id: contentId, ownerId, status: content.status },
      data: { status: ContentStatus.AI_GENERATING },
    });
    if (!claimed.count) {
      throw new ApplicationException(ErrorCode.CONFLICT, 'Content changed while generation was starting', HttpStatus.CONFLICT);
    }
    try {
      const generatedByPlatform = await Promise.all(platforms.map(async (platform) => {
        const prompt = platform.prompts[0];
        if (!prompt) throw new ApplicationException(ErrorCode.RESOURCE_NOT_FOUND, `No active prompt for ${platform.slug}`, HttpStatus.NOT_FOUND);
        const generated = await this.callModel(provider, platform.slug, prompt.systemPrompt, prompt.userTemplate, content);
        return { platform, generated };
      }));
      return await this.prisma.$transaction(async (transaction) => {
        const results = [];
        for (const { platform, generated } of generatedByPlatform) {
          const latest = await transaction.contentVariant.aggregate({
            where: { contentId, platformId: platform.id },
            _max: { version: true },
          });
          results.push(await transaction.contentVariant.create({
            data: {
              contentId,
              platformId: platform.id,
              title: generated.title,
              body: generated.body,
              summary: generated.summary,
              hashtags: generated.hashtags,
              cta: generated.cta,
              recommended: generated.recommended,
              reason: generated.reason,
              mediaRecommendation: generated.media,
              status: VariantStatus.GENERATED,
              version: (latest._max.version ?? 0) + 1,
            },
          }));
        }
        const completed = await transaction.content.updateMany({
          where: { id: contentId, ownerId, status: ContentStatus.AI_GENERATING },
          data: { status: ContentStatus.GENERATED },
        });
        if (!completed.count) {
          throw new ApplicationException(ErrorCode.CONFLICT, 'Content changed while generation was completing', HttpStatus.CONFLICT);
        }
        return results;
      });
    } catch (error) {
      await this.prisma.content.updateMany({
        where: { id: contentId, ownerId, status: ContentStatus.AI_GENERATING },
        data: { status: content.status },
      });
      throw error;
    }
  }

  parseOutput(value: string): GeneratedVariant {
    let parsed: unknown;
    try { parsed = JSON.parse(value); } catch { throw new ApplicationException(ErrorCode.PLATFORM_API_ERROR, 'AI returned invalid JSON', HttpStatus.BAD_GATEWAY); }
    const result = VariantSchema.safeParse(parsed);
    if (!result.success) throw new ApplicationException(ErrorCode.PLATFORM_API_ERROR, 'AI output did not match the required schema', HttpStatus.BAD_GATEWAY, result.error.flatten());
    return result.data;
  }

  private async callModel(
    provider: AiProvider,
    platform: string,
    systemPrompt: string,
    userTemplate: string,
    content: { title: string; body: string; summary: string | null; canonicalUrl: string | null },
  ): Promise<GeneratedVariant> {
    const input = userTemplate
      .replaceAll('{{platform}}', platform)
      .replaceAll('{{title}}', content.title)
      .replaceAll('{{body}}', content.body.slice(0, 100_000))
      .replaceAll('{{summary}}', content.summary ?? '')
      .replaceAll('{{canonicalUrl}}', content.canonicalUrl ?? '');
    const client = this.clientFor(provider);
    const model = this.models[provider];
    if (provider === 'openai') {
      const response = await this.requestFromProvider(provider, () => (
        client.responses.create({
          model,
          instructions: systemPrompt,
          input,
          store: false,
          text: { format: { type: 'json_schema', name: 'content_variant', strict: true, schema: outputSchema } },
        })
      ));
      return this.parseOutput(response.output_text);
    }

    const messages = [
      { role: 'system' as const, content: systemPrompt },
      { role: 'user' as const, content: input },
    ];
    if (provider === 'gemini') {
      const response = await this.requestFromGemini((selectedModel) => (
        client.chat.completions.parse({
          model: selectedModel,
          messages,
          response_format: zodResponseFormat(VariantSchema, 'content_variant'),
        })
      ));
      const parsed = response.choices[0]?.message.parsed;
      if (!parsed) return this.parseOutput(response.choices[0]?.message.content ?? '');
      const result = VariantSchema.safeParse(parsed);
      if (!result.success) {
        throw new ApplicationException(
          ErrorCode.PLATFORM_API_ERROR,
          'AI output did not match the required schema',
          HttpStatus.BAD_GATEWAY,
          result.error.flatten(),
        );
      }
      return result.data;
    }

    const response = await this.requestFromProvider(provider, () => (
      client.chat.completions.create({
        model,
        messages: [
          {
            role: 'system',
            content: `${systemPrompt}\nReturn only a valid JSON object matching this JSON Schema:\n${JSON.stringify(outputSchema)}`,
          },
          { role: 'user', content: input },
        ],
        response_format: { type: 'json_object' },
        max_tokens: 8192,
      })
    ));
    return this.parseOutput(response.choices[0]?.message.content ?? '');
  }

  private async requestFromGemini<T>(request: (model: string) => Promise<T>): Promise<T> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= GEMINI_PRIMARY_MAX_ATTEMPTS; attempt += 1) {
      try {
        return await request(this.models.gemini);
      } catch (error) {
        lastError = error;
        if (!this.isRetryableGeminiError(error)) {
          throw this.normalizeProviderError('gemini', error);
        }
        if (attempt < GEMINI_PRIMARY_MAX_ATTEMPTS) {
          await this.delay(GEMINI_RETRY_DELAY_MS * attempt);
        }
      }
    }

    if (this.geminiFallbackModel) {
      try {
        return await request(this.geminiFallbackModel);
      } catch (error) {
        lastError = error;
      }
    }

    throw this.normalizeProviderError('gemini', lastError);
  }

  private async requestFromProvider<T>(provider: AiProvider, request: () => Promise<T>): Promise<T> {
    try {
      return await request();
    } catch (error) {
      if (error instanceof ApplicationException) throw error;
      throw this.normalizeProviderError(provider, error);
    }
  }

  private normalizeProviderError(provider: AiProvider, error: unknown): ApplicationException {
    const label = AI_PROVIDER_LABELS[provider];
    const status = this.readNumericErrorProperty(error, 'status');

    if (status === 401 || status === 403) {
      return new ApplicationException(
        ErrorCode.PLATFORM_AUTH_FAILED,
        `${label} rejected the configured API credentials`,
        HttpStatus.BAD_GATEWAY,
      );
    }
    if (status === 402) {
      return new ApplicationException(
        ErrorCode.INFRASTRUCTURE_UNAVAILABLE,
        `${label} account has insufficient balance or quota`,
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    if (status === 429) {
      return new ApplicationException(
        ErrorCode.PLATFORM_RATE_LIMITED,
        `${label} rate limit was reached. Try again later`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    if (status !== undefined && status >= 500) {
      return new ApplicationException(
        ErrorCode.INFRASTRUCTURE_UNAVAILABLE,
        `${label} is temporarily unavailable`,
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    if (this.isTimeoutError(error)) {
      return new ApplicationException(
        ErrorCode.INFRASTRUCTURE_UNAVAILABLE,
        `${label} request timed out. Try again later`,
        HttpStatus.GATEWAY_TIMEOUT,
      );
    }
    if (this.isConnectionError(error)) {
      return new ApplicationException(
        ErrorCode.INFRASTRUCTURE_UNAVAILABLE,
        `${label} could not be reached. Try again later`,
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    return new ApplicationException(
      ErrorCode.PLATFORM_API_ERROR,
      `${label} request failed`,
      HttpStatus.BAD_GATEWAY,
    );
  }

  private isRetryableGeminiError(error: unknown): boolean {
    const status = this.readNumericErrorProperty(error, 'status');
    return status === 429 || (status !== undefined && status >= 500);
  }

  private async delay(milliseconds: number): Promise<void> {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, milliseconds);
    });
  }

  private isTimeoutError(error: unknown): boolean {
    const name = this.readStringErrorProperty(error, 'name');
    const code = this.readStringErrorProperty(error, 'code');
    return (name !== undefined && TIMEOUT_ERROR_NAMES.has(name))
      || (code !== undefined && TIMEOUT_ERROR_CODES.has(code));
  }

  private isConnectionError(error: unknown): boolean {
    const name = this.readStringErrorProperty(error, 'name');
    const code = this.readStringErrorProperty(error, 'code');
    return (name !== undefined && CONNECTION_ERROR_NAMES.has(name))
      || (code !== undefined && CONNECTION_ERROR_CODES.has(code));
  }

  private readNumericErrorProperty(error: unknown, property: string): number | undefined {
    if (typeof error !== 'object' || error === null) return undefined;
    const value = (error as Record<string, unknown>)[property];
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
  }

  private readStringErrorProperty(error: unknown, property: string): string | undefined {
    if (typeof error !== 'object' || error === null) return undefined;
    const value = (error as Record<string, unknown>)[property];
    return typeof value === 'string' ? value : undefined;
  }

  private clientFor(provider: AiProvider): OpenAI {
    const client = this.clients[provider];
    if (!client) {
      throw new ApplicationException(
        ErrorCode.INFRASTRUCTURE_UNAVAILABLE,
        `${PROVIDER_API_KEY_ENV[provider]} is not configured`,
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    return client;
  }
}
