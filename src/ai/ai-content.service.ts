import { HttpStatus, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ContentStatus, Prisma, VariantStatus } from '@prisma/client';
import OpenAI from 'openai';
import { zodResponseFormat } from 'openai/helpers/zod';
import { z } from 'zod';
import { ApplicationException, ErrorCode } from '../common/exceptions/application.exception';
import { PrismaService } from '../database/prisma.service';
import { repairEscapedNewlines } from '../common/utils/escaped-text';
import { PlatformContract, platformContract } from '../platforms/platform-contract';
import { markdownToPlain } from '../platforms/post-text';
import { BrandProfile, brandProfileBlock, BrandProfileService } from './brand-profile.service';
import {
  clampReview,
  ContentReview,
  deterministicIssues,
  QUALITY_PASS_SCORE,
  reviewInstructions,
  reviewJsonSchema,
  reviewPassed,
  ReviewSchema,
  rewriteFeedback,
} from './content-quality';
import { GeminiKeyPoolService } from './gemini-key-pool.service';
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
const GENERATION_RETRY_DELAY_MS = 2_000;
const INVALID_JSON_MESSAGE = 'AI returned invalid JSON';
const SCHEMA_MISMATCH_MESSAGE = 'AI output did not match the required schema';
const MAX_REASON_LENGTH = 1_000;
const RETRYABLE_GENERATION_STATUSES = new Set<number>([HttpStatus.TOO_MANY_REQUESTS, HttpStatus.SERVICE_UNAVAILABLE, HttpStatus.GATEWAY_TIMEOUT]);

interface StructuredSpec<T> {
  name: string;
  jsonSchema: Record<string, unknown>;
  zod: z.ZodType<T>;
}

const VARIANT_SPEC: StructuredSpec<GeneratedVariant> = { name: 'content_variant', jsonSchema: outputSchema, zod: VariantSchema };
const REVIEW_SPEC: StructuredSpec<ContentReview> = { name: 'content_review', jsonSchema: reviewJsonSchema, zod: ReviewSchema };

type SourceContent = {
  title: string;
  body: string;
  summary: string | null;
  canonicalUrl: string | null;
  aiAnalysis?: Prisma.JsonValue | null;
};

interface ModelOptions {
  contract?: PlatformContract;
  brand?: BrandProfile | null;
  feedback?: string;
}

const LANGUAGE_NAMES = { vi: 'Vietnamese', en: 'English' } as const;

const FORMAT_RULES = {
  markdown: 'Markdown (headings, lists, links and code blocks render).',
  plain: 'plain text: no Markdown symbols (#, **, [text](url), backticks). Separate paragraphs with a blank line; start list items with "• ".',
  html: 'simple HTML: <h2>, <h3>, <p>, <ul>, <ol>, <li>, <a>, <strong>, <em>, <code>. No Markdown.',
} as const;

/** Rules derived from the destination; appended to the stored prompt so they always apply. */
export function contractInstructions(contract: PlatformContract): string {
  const hashtags = {
    inline: `put at most ${contract.maxHashtags} relevant hashtags inside the body (at the end or naturally in a sentence) and list the same tags without # in "hashtags".`,
    appended: `do not put hashtags in the body; list at most ${contract.maxHashtags} in "hashtags" without #, they are appended automatically.`,
    tags: `do not put hashtags in the body; "hashtags" holds at most ${contract.maxHashtags} topic tags without #.`,
  }[contract.hashtagMode];
  return [
    `Destination contract for ${contract.name} (mandatory):`,
    `- Write every field in ${LANGUAGE_NAMES[contract.language]}. If the brief is in another language, convey its meaning naturally; never mix languages.`,
    `- Body format: ${FORMAT_RULES[contract.format]}`,
    contract.maxChars
      ? `- Hard limit: the published body, including hashtags and links, must be at most ${contract.maxChars} characters; aim for about ${Math.floor(contract.maxChars * 0.85)}.${contract.counting === 'x' ? ' On X, letters with Vietnamese diacritics count as two characters and every link counts as 23.' : ''}`
      : '',
    `- Hashtags: ${hashtags}`,
    contract.titleRequired
      ? `- title is required: specific, at most ${contract.titleMaxChars} characters, and not a copy of the first sentence.`
      : '- title: null unless this destination shows a separate title.',
  ].filter(Boolean).join('\n');
}

function isBrief(content: SourceContent): boolean {
  const analysis = content.aiAnalysis;
  return analysis !== null && typeof analysis === 'object' && !Array.isArray(analysis) && analysis.kind === 'brief';
}

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
  private readonly logger = new Logger(AiContentService.name);
  private readonly clients: Partial<Record<AiProvider, OpenAI>> = {};
  private readonly models: Record<AiProvider, string>;
  private readonly defaultProvider: AiProvider;
  private readonly geminiFallbackModel?: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly geminiKeys: GeminiKeyPoolService,
    @Optional() private readonly brandProfiles?: BrandProfileService,
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
      if (provider === 'gemini') continue;
      const apiKey = config.get<string>(PROVIDER_API_KEY_ENV[provider])?.trim();
      if (!apiKey) continue;
      this.clients[provider] = new OpenAI({
        apiKey,
        timeout,
        ...(provider === 'deepseek' ? { baseURL: 'https://api.deepseek.com' } : {}),
      });
    }
  }

  async providers(): Promise<AiProviderDescriptor[]> {
    const geminiConfigured = await this.geminiKeys.configured();
    return AI_PROVIDER_IDS.map((provider) => ({
      id: provider,
      label: AI_PROVIDER_LABELS[provider],
      model: this.models[provider],
      configured: provider === 'gemini' ? geminiConfigured : Boolean(this.clients[provider]),
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
    await this.assertConfigured(provider);
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
    await this.assertConfigured(provider);
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
      const brand = await this.brandProfiles?.load() ?? null;
      const generatedByPlatform: Array<{ platform: (typeof platforms)[number]; generated: GeneratedVariant }> = [];
      // Bound provider concurrency for large multi-platform campaigns.
      for (let offset = 0; offset < platforms.length; offset += 4) {
        generatedByPlatform.push(...await Promise.all(platforms.slice(offset, offset + 4).map(async (platform) => {
        const prompt = platform.prompts[0];
        if (!prompt) throw new ApplicationException(ErrorCode.RESOURCE_NOT_FOUND, `No active prompt for ${platform.slug}`, HttpStatus.NOT_FOUND);
        const generated = await this.generateChecked(provider, platform.slug, prompt.systemPrompt, prompt.userTemplate, content, brand);
        return { platform, generated };
        })));
      }
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
              body: repairEscapedNewlines(generated.body),
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
    return this.parseStructured(value, VARIANT_SPEC);
  }

  private parseStructured<T>(value: string, spec: StructuredSpec<T>): T {
    let parsed: unknown;
    try { parsed = JSON.parse(value); } catch { throw new ApplicationException(ErrorCode.PLATFORM_API_ERROR, INVALID_JSON_MESSAGE, HttpStatus.BAD_GATEWAY); }
    return this.validateStructured(parsed, spec);
  }

  private validateStructured<T>(value: unknown, spec: StructuredSpec<T>): T {
    const result = spec.zod.safeParse(value);
    if (!result.success) throw new ApplicationException(ErrorCode.PLATFORM_API_ERROR, SCHEMA_MISMATCH_MESSAGE, HttpStatus.BAD_GATEWAY, z.flattenError(result.error));
    return result.data;
  }

  /**
   * Writes, checks and, when needed, rewrites once. A draft that still falls
   * short is returned with recommended=false so it is never auto-approved.
   */
  private async generateChecked(
    provider: AiProvider,
    platform: string,
    systemPrompt: string,
    userTemplate: string,
    content: SourceContent,
    brand: BrandProfile | null,
  ): Promise<GeneratedVariant> {
    const contract = platformContract(platform, {
      sourceText: content.body,
      defaultLanguage: brand?.defaultLanguage,
      platformLanguages: brand?.platformLanguages,
    });
    // Plain-text destinations get clean paragraphs whatever the route (API or
    // extension), so stray Markdown never reaches readers.
    const write = async (feedback?: string) => {
      const generated = await this.withGenerationRetry(() => (
        this.callModel(provider, platform, systemPrompt, userTemplate, content, { contract, brand, feedback })
      ));
      return contract.format === 'plain' ? { ...generated, body: markdownToPlain(generated.body) } : generated;
    };
    let draft = await write();
    let assessment = await this.assess(provider, draft, contract, content, brand);
    // A draft the writer itself flags as off-topic for this audience
    // (recommended=false) is not fixed by rewriting; it goes to the operator.
    if (!assessment.passed) {
      draft = await write(rewriteFeedback(assessment.issues, assessment.review));
      assessment = await this.assess(provider, draft, contract, content, brand);
    }
    const hashtags = [...new Set(draft.hashtags.map((tag) => tag.trim().replace(/^#+/, '')).filter(Boolean))];
    const scoreText = assessment.review ? `AI chấm ${assessment.review.score}/10` : 'AI chưa chấm được';
    const recommended = assessment.passed && draft.recommended;
    const problems = [
      ...(!draft.recommended ? [`AI đánh giá không hợp nơi đăng: ${draft.reason}`] : []),
      ...assessment.issues,
      ...(assessment.review && !reviewPassed(assessment.review) ? assessment.review.unsupportedClaims.map((claim) => `Thông tin chưa có căn cứ: ${claim}`) : []),
      ...(assessment.review && !reviewPassed(assessment.review) ? assessment.review.issues : []),
    ];
    const reason = recommended
      ? `${draft.reason} (${scoreText})`
      : `Cần xem lại (${scoreText}): ${[...new Set(problems)].join('; ') || `điểm dưới ${QUALITY_PASS_SCORE}/10`}`;
    return {
      ...draft,
      hashtags: contract.hashtagMode === 'inline' ? hashtags : hashtags.slice(0, contract.maxHashtags),
      recommended,
      reason: reason.slice(0, MAX_REASON_LENGTH),
    };
  }

  private async assess(
    provider: AiProvider,
    draft: GeneratedVariant,
    contract: PlatformContract,
    content: SourceContent,
    brand: BrandProfile | null,
  ): Promise<{ passed: boolean; issues: string[]; review: ContentReview | null }> {
    const issues = deterministicIssues(draft, contract, content.canonicalUrl);
    let review: ContentReview | null = null;
    try {
      review = clampReview(await this.withGenerationRetry(() => this.requestStructured(
        provider,
        reviewInstructions(contract),
        [
          `Brief or source (${isBrief(content) ? 'short marketing brief' : 'source content'}):\n${content.body.slice(0, 20_000)}`,
          brandProfileBlock(brand),
          `Draft:\n${JSON.stringify({ title: draft.title, body: draft.body, hashtags: draft.hashtags })}`,
        ].filter(Boolean).join('\n\n'),
        REVIEW_SPEC,
      )));
    } catch (error) {
      // The draft itself was generated; a reviewer outage must not block every
      // campaign. Machine checks still apply and the reason says it was unscored.
      this.logger.warn(`AI review unavailable for ${contract.slug}: ${error instanceof Error ? error.message : String(error)}`);
    }
    const passed = issues.length === 0 && reviewPassedOrMissing(review);
    return { passed, issues, review };
  }

  private async withGenerationRetry<T>(request: () => Promise<T>): Promise<T> {
    try {
      return await request();
    } catch (error) {
      if (!isRetryableGenerationError(error)) throw error;
      await this.delay(GENERATION_RETRY_DELAY_MS);
      return request();
    }
  }

  private async callModel(
    provider: AiProvider,
    platform: string,
    systemPrompt: string,
    userTemplate: string,
    content: SourceContent,
    options: ModelOptions = {},
  ): Promise<GeneratedVariant> {
    const brief = isBrief(content);
    const filled = userTemplate
      .replaceAll('{{platform}}', platform)
      .replaceAll('{{title}}', brief ? '(none: write your own headline; the campaign name is an internal label)' : content.title)
      .replaceAll('{{body}}', content.body.slice(0, 100_000))
      .replaceAll('{{summary}}', brief ? '' : content.summary ?? '')
      .replaceAll('{{canonicalUrl}}', content.canonicalUrl ?? '');
    const input = [
      brief ? 'Input type: a short marketing brief, not a finished article. Expand it into a complete post using the brand facts and widely known domain knowledge; never invent brand facts.' : '',
      filled,
      brandProfileBlock(options.brand ?? null),
      options.feedback ? `Your previous draft was rejected by the editor. Rewrite it from scratch and fix:\n${options.feedback}` : '',
    ].filter(Boolean).join('\n\n');
    const instructions = options.contract ? `${systemPrompt}\n\n${contractInstructions(options.contract)}` : systemPrompt;
    return this.requestStructured(provider, instructions, input, VARIANT_SPEC);
  }

  private async requestStructured<T>(provider: AiProvider, instructions: string, input: string, spec: StructuredSpec<T>): Promise<T> {
    if (provider === 'gemini') return this.callGemini(instructions, input, spec);
    const client = this.clientFor(provider);
    const model = this.models[provider];
    if (provider === 'openai') {
      const response = await this.requestFromProvider(provider, () => (
        client.responses.create({
          model,
          instructions,
          input,
          store: false,
          text: { format: { type: 'json_schema', name: spec.name, strict: true, schema: spec.jsonSchema } },
        })
      ));
      return this.parseStructured(response.output_text, spec);
    }

    const response = await this.requestFromProvider(provider, () => (
      client.chat.completions.create({
        model,
        messages: [
          {
            role: 'system',
            content: `${instructions}\nReturn only a valid JSON object matching this JSON Schema:\n${JSON.stringify(spec.jsonSchema)}`,
          },
          { role: 'user', content: input },
        ],
        response_format: { type: 'json_object' },
        max_tokens: 8192,
      })
    ));
    return this.parseStructured(response.choices[0]?.message.content ?? '', spec);
  }

  private async requestFromGemini<T>(request: (model: string) => Promise<T>): Promise<T> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= GEMINI_PRIMARY_MAX_ATTEMPTS; attempt += 1) {
      try {
        return await request(this.models.gemini);
      } catch (error) {
        lastError = error;
        if ([429, 402].includes(this.readNumericErrorProperty(error, 'status') ?? 0)) throw error;
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
        if ([429, 402].includes(this.readNumericErrorProperty(error, 'status') ?? 0)) throw error;
      }
    }

    throw this.normalizeProviderError('gemini', lastError);
  }

  private createGeminiClient(apiKey: string): OpenAI {
    return new OpenAI({ apiKey, maxRetries: 0,
      timeout: this.config.get<number>('AI_TIMEOUT_MS', this.config.get<number>('OPENAI_TIMEOUT_MS', 60_000)),
      baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/',
      defaultHeaders: { 'x-goog-api-client': 'social-publisher-oai/0.1.0' },
    });
  }

  private async callGemini<T = GeneratedVariant>(
    instructions: string,
    input: string,
    spec: StructuredSpec<T> = VARIANT_SPEC as unknown as StructuredSpec<T>,
  ): Promise<T> {
    const response = await this.requestFromProvider('gemini', () => this.geminiKeys.run((apiKey) => {
      const client = this.createGeminiClient(apiKey);
      return this.requestFromGemini((model) => client.chat.completions.parse({ model,
        messages: [{ role: 'system', content: instructions }, { role: 'user', content: input }],
        response_format: zodResponseFormat(spec.zod, spec.name),
      }));
    }));
    const parsed: unknown = response.choices[0]?.message.parsed;
    if (!parsed) return this.parseStructured(response.choices[0]?.message.content ?? '', spec);
    return this.validateStructured(parsed, spec);
  }

  private async assertConfigured(provider: AiProvider): Promise<void> {
    if (provider !== 'gemini') { this.clientFor(provider); return; }
    if (!await this.geminiKeys.configured()) throw new ApplicationException(ErrorCode.INFRASTRUCTURE_UNAVAILABLE, 'GEMINI_API_KEY is not configured', HttpStatus.SERVICE_UNAVAILABLE);
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

function reviewPassedOrMissing(review: ContentReview | null): boolean {
  return review === null || reviewPassed(review);
}

/** Rate limits, provider outages and malformed JSON are worth one more attempt. */
function isRetryableGenerationError(error: unknown): boolean {
  if (!(error instanceof ApplicationException)) return false;
  return RETRYABLE_GENERATION_STATUSES.has(error.getStatus())
    || error.message === INVALID_JSON_MESSAGE
    || error.message === SCHEMA_MISMATCH_MESSAGE;
}
