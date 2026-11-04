import { HttpStatus, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ContentStatus, ContentVariant, Prisma, VariantStatus } from '@prisma/client';
import OpenAI from 'openai';
import { zodResponseFormat } from 'openai/helpers/zod';
import { z } from 'zod';
import { ApplicationException, ErrorCode } from '../common/exceptions/application.exception';
import { PrismaService } from '../database/prisma.service';
import { repairEscapedNewlines } from '../common/utils/escaped-text';
import { countChars, PlatformContract, platformContract } from '../platforms/platform-contract';
import { markdownToPlain, publishedLength, sourceLine } from '../platforms/post-text';
import { checkPostLength, contractFor, fitToLimit } from '../platforms/post-length';
import { extensionFlowForPlatform } from '../connectors/extension/extension-flows';
import { tagStyle } from '../connectors/extension/extension-tags';
import { BrandProfile, brandProfileBlock, BrandProfileService } from './brand-profile.service';
import {
  clampReview,
  ContentReview,
  deterministicIssues,
  DraftForCheck,
  draftRank,
  QUALITY_MAX_REWRITES,
  QUALITY_PASS_SCORE,
  qualityInstructions,
  reviewInstructions,
  reviewJsonSchema,
  reviewPassed,
  ReviewSchema,
  rewriteFeedback,
} from './content-quality';
import type { PlatformImagePlan } from '../campaigns/image-plan';
import { GeminiKeyPoolService } from './gemini-key-pool.service';
import { ProviderThrottle } from './provider-throttle';
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
  media: z.object({
    type: z.enum(['none', 'image', 'video', 'document']), altText: z.string(), prompt: z.string().nullable().optional(),
    // Set by the backend, never by the model: where the planned image stands.
    status: z.enum(['pending', 'generating', 'generated', 'failed', 'removed']).nullable().optional(),
  }),
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
      required: ['type', 'altText', 'prompt'],
      properties: {
        type: { type: 'string', enum: ['none', 'image', 'video', 'document'] },
        altText: { type: 'string' },
        prompt: { type: ['string', 'null'] },
      },
    },
  },
} as const;

const PROVIDER_API_KEY_ENV: Record<AiProvider, string> = {
  openai: 'OPENAI_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
  gemini: 'GEMINI_API_KEY',
  vpsttt: 'VPSTTT_AI_API_KEY',
};

const PROVIDER_MODEL_ENV: Record<AiProvider, string> = {
  openai: 'OPENAI_MODEL',
  deepseek: 'DEEPSEEK_MODEL',
  gemini: 'GEMINI_MODEL',
  vpsttt: 'VPSTTT_AI_MODEL',
};

const PROVIDER_DEFAULT_MODELS: Record<AiProvider, string> = {
  openai: 'gpt-5-mini',
  deepseek: 'deepseek-flash',
  gemini: 'gemini-3.5-flash',
  vpsttt: 'claude:sonnet',
};

const DEFAULT_GEMINI_FALLBACK_MODEL = 'gemini-3.5-flash-lite';
const GEMINI_PRIMARY_MAX_ATTEMPTS = 2;
const GEMINI_RETRY_DELAY_MS = 750;
const GENERATION_RETRY_DELAY_MS = 2_000;
const INVALID_JSON_MESSAGE = 'AI returned invalid JSON';
const SCHEMA_MISMATCH_MESSAGE = 'AI output did not match the required schema';
const MAX_REASON_LENGTH = 1_000;
const RETRYABLE_GENERATION_STATUSES = new Set<number>([HttpStatus.TOO_MANY_REQUESTS, HttpStatus.SERVICE_UNAVAILABLE, HttpStatus.GATEWAY_TIMEOUT]);
// The IDE AI API accepts at most 100,000 characters across all messages.
const VPSTTT_MAX_TOTAL_CHARS = 100_000;
const VPSTTT_CHAR_MARGIN = 500;

export interface StructuredSpec<T> {
  name: string;
  jsonSchema: Record<string, unknown>;
  zod: z.ZodType<T>;
}

const VARIANT_SPEC: StructuredSpec<GeneratedVariant> = { name: 'content_variant', jsonSchema: outputSchema, zod: VariantSchema };

const briefText = z.string().trim().min(1);
const briefList = z.array(z.string().trim().min(1)).transform((items) => items.slice(0, 6));
/** The art director's design of one image, assembled into the generator prompt by composeImagePrompt. */
export const ImageBriefSchema = z.object({
  subject: briefText, scene: briefText, composition: briefText, lighting: briefText,
  palette: briefText, style: briefText, mood: briefText, details: briefList, avoid: briefList, altText: briefText,
});
export type ImageBrief = z.infer<typeof ImageBriefSchema>;
const IMAGE_BRIEF_FIELDS = ['subject', 'scene', 'composition', 'lighting', 'palette', 'style', 'mood', 'details', 'avoid', 'altText'] as const;
const IMAGE_BRIEF_SPEC: StructuredSpec<ImageBrief> = {
  name: 'image_brief',
  jsonSchema: {
    type: 'object',
    additionalProperties: false,
    required: [...IMAGE_BRIEF_FIELDS],
    properties: Object.fromEntries(IMAGE_BRIEF_FIELDS.map((field) => [field, field === 'details' || field === 'avoid' ? { type: 'array', items: { type: 'string' } } : { type: 'string' }])),
  },
  zod: ImageBriefSchema,
};
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
  /** Operator-requested revision of a stored draft (see revisionBrief). */
  revision?: string;
  /** Extension engine of the destination, for engine-specific quality rules. */
  engine?: string;
  /** Set when this destination's post carries one AI image; absent means text only. */
  image?: PlatformImagePlan | null;
}

/** An operator's "rewrite this post" request for one stored draft. */
export interface DraftRevision {
  previous: DraftForCheck;
  instruction: string;
  /** The last review of the stored draft ("Cần xem lại …"), if any. */
  notes?: string | null;
  /** "Sửa theo khuyến nghị": the review points the operator chose; the other earlier notes do not apply. */
  chosenNotes?: string[] | null;
}

function revisionBrief(revision: DraftRevision): string {
  return [
    'Revise your previous draft for this destination: keep what works, follow the operator\'s instructions and fix the editor\'s notes. Return the complete new post.',
    `Previous draft:\n${JSON.stringify({ title: revision.previous.title, body: revision.previous.body.slice(0, 20_000), hashtags: revision.previous.hashtags })}`,
    revision.instruction ? `Operator's instructions (highest priority, within the destination contract):\n${revision.instruction}` : '',
    revision.notes ? `Editor's notes from the last review:\n${revision.notes}` : '',
    revision.chosenNotes?.length
      ? `Fix each of these points from the editor's last review, chosen by the operator (other earlier notes do not apply):\n${revision.chosenNotes.map((note) => `- ${note}`).join('\n')}`
      : '',
  ].filter(Boolean).join('\n\n');
}

/**
 * The one "shorten only" request made when the best draft is still over the
 * limit after the rewrites: the exact numbers, and nothing else to change.
 */
export function shortenBrief(draft: DraftForCheck, contract: PlatformContract, length: number, canonicalUrl?: string | null): string {
  const maxChars = contract.maxChars ?? length;
  const source = sourceLineCost(contract, canonicalUrl);
  const budget = maxChars - (source?.length ?? 0);
  return [
    `Shorten your draft for ${contract.name}. As published it has ${length} characters; the limit is ${maxChars}. Cut at least ${length - maxChars} characters, aiming for about ${Math.floor(maxChars * 0.9)} in total.`,
    source ? `The source line "${source.line}" (${source.length} characters) is added below the body automatically, so the body with its hashtags must stay within ${budget} characters; do not repeat that link in the body.` : '',
    `Hashtags and links count toward the limit.${COUNTING_RULES[contract.counting]}${contract.hashtagMode === 'inline' ? ` Keep at most ${contract.maxHashtags} hashtags, fewer if needed.` : ''}`,
    'Only shorten: keep the meaning, the key facts, the language and the tone. Remove filler, repetition and secondary details first; add nothing new. Return the complete shortened post.',
    `Draft:\n${JSON.stringify({ title: draft.title, body: draft.body, hashtags: draft.hashtags })}`,
  ].filter(Boolean).join('\n\n');
}

type Assessment = {
  passed: boolean;
  issues: string[];
  review: ContentReview | null;
  /** Characters the destination counts; 0 when it has no limit. */
  length: number;
  overLimit: boolean;
};

/** How an over-limit draft was brought within its limit: by the writer, or cut by the machine. */
type Shortening = 'writer' | 'cut' | null;

const LANGUAGE_NAMES = { vi: 'Vietnamese', en: 'English' } as const;

const FORMAT_RULES = {
  markdown: 'Markdown (headings, lists, links and code blocks render).',
  plain: 'plain text: no Markdown symbols (#, **, [text](url), backticks). Separate paragraphs with a blank line; start list items with "• ".',
  html: 'simple HTML: <h2>, <h3>, <p>, <ul>, <ol>, <li>, <a>, <strong>, <em>, <code>. No Markdown.',
} as const;

const COUNTING_RULES = {
  graphemes: '',
  x: ' On X, letters with Vietnamese diacritics count as two characters and every link, also a bare domain such as example.com, counts as 23.',
  mastodon: ' On Mastodon every link counts as 23 characters, however long.',
} as const;

/** What the source line the system adds under the post costs: the line and the blank line before it. */
function sourceLineCost(contract: PlatformContract, canonicalUrl?: string | null): { line: string; length: number } | null {
  if (!canonicalUrl) return null;
  const line = sourceLine(contract.language, canonicalUrl);
  return { line, length: countChars(`\n\n${line}`, contract.counting) };
}

/** Rules derived from the destination; appended to the stored prompt so they always apply. */
export function contractInstructions(contract: PlatformContract, canonicalUrl?: string | null): string {
  const hashtags = {
    inline: `put at most ${contract.maxHashtags} relevant hashtags inside the body (at the end or naturally in a sentence) and list the same tags without # in "hashtags".`,
    appended: `do not put hashtags in the body; list at most ${contract.maxHashtags} in "hashtags" without #, they are appended automatically.`,
    tags: `do not put hashtags in the body; "hashtags" holds at most ${contract.maxHashtags} topic tags without #.`,
  }[contract.hashtagMode];
  const style = contract.hashtagMode === 'tags' ? tagStyle(extensionFlowForPlatform(contract.slug)?.engine) : undefined;
  const source = sourceLineCost(contract, canonicalUrl);
  // The body gets what the source line leaves of the limit.
  const budget = contract.maxChars ? contract.maxChars - (source?.length ?? 0) : 0;
  return [
    `Destination contract for ${contract.name} (mandatory):`,
    `- Write every field in ${LANGUAGE_NAMES[contract.language]}. If the brief is in another language, convey its meaning naturally; never mix languages.`,
    `- Body format: ${FORMAT_RULES[contract.format]}`,
    contract.maxChars
      ? [
        `- Hard limit: the published post, including hashtags and links, must be at most ${contract.maxChars} characters.`,
        source
          ? ` The system adds the line "${source.line}" below the body (${source.length} characters with the blank line before it), so the body with its hashtags gets at most ${budget} characters; do not repeat that link in the body.`
          : '',
        ` Aim for about ${Math.floor(budget * 0.85)} characters in the body.`,
        COUNTING_RULES[contract.counting],
      ].join('')
      : '',
    `- Hashtags: ${hashtags}${style ? ` Tag format: ${style}.` : ''}`,
    contract.titleRequired
      ? `- title is required: specific, at most ${contract.titleMaxChars} characters, and not a copy of the first sentence.`
      : '- title: null unless this destination shows a separate title.',
  ].filter(Boolean).join('\n');
}

/**
 * Tells the writer whether an image goes with this post, so the caption fits
 * it and text-only destinations never promise a picture.
 */
export function imageInstructions(platformName: string, image?: PlatformImagePlan | null): string {
  if (!image) {
    return `Image: no image is attached to this ${platformName} post. Set media.type to "none", media.prompt to null and media.altText to "", and never mention an image, photo, picture or visual in the text.`;
  }
  const shape = image.size === '1024x1024' ? 'square 1:1' : image.size === '1536x1024' ? 'landscape 3:2' : 'portrait 2:3';
  return [
    `Image (mandatory): one image generated from your description is attached to this ${platformName} post.`,
    '- Set media.type to "image".',
    `- media.prompt: an English prompt for an image generator, 60 to 150 words, written like a brief to a designer: the subject and its concrete details, composition or camera angle, lighting, colour palette and rendering style. Show the one idea this post is about, as ${image.style}; ${shape} framing. Use the brand colours if the brand profile names them. The image must contain no words, letters, numbers, logos, watermarks, screenshots of real products or recognisable people.`,
    // Generic, cosy stock scenes did not show what is being promoted (a coffee
    // cup next to a mini PC for a VPS post); keep the picture on the subject.
    '- Subject: depict the product or service the brief promotes and the technical idea of this post concretely (for example servers and racks, cloud infrastructure, proxies and network routes between nodes, terminals or dashboards drawn as abstract shapes without readable text, data flowing between devices). A reader should guess the topic from the image alone.',
    '- Look: modern technology. Deep navy or dark backgrounds with blue, cyan or violet light, clean geometric, isometric or 3D-render style, subtle glow and depth. Do not use lifestyle props (coffee cups, plants, wooden desks, printed photos), countryside or nature metaphors (meadows, gates, hills, sky landscapes) or generic office stock scenes.',
    '- media.altText: one sentence in the language of the post describing what the image shows, for screen readers.',
    image.need === 'required'
      ? '- The image is the post here: the caption complements what it shows.'
      : '- The text may refer to the visual naturally but must stand on its own.',
  ].join('\n');
}

function isBrief(content: SourceContent): boolean {
  const analysis = content.aiAnalysis;
  return analysis !== null && typeof analysis === 'object' && !Array.isArray(analysis) && analysis.kind === 'brief';
}

const shapeOf = (image: PlatformImagePlan) => image.size === '1024x1024' ? 'square 1:1' : image.size === '1536x1024' ? 'landscape 3:2' : 'portrait 2:3';

/**
 * Instructions for the art director: a second, dedicated pass that designs the
 * image from the finished post, instead of the one line the writer adds while
 * writing. Image generators follow a structured brief far more faithfully.
 */
export function imageBriefInstructions(platformName: string, image: PlatformImagePlan, language: string): string {
  return [
    `You are the art director of a technology company's social media team. Design ONE image for a ${platformName} post so that a reader connects it at a glance to the product being promoted and to this exact post.`,
    'Return JSON with these fields:',
    '- subject: the main subject, concrete and specific to the post: the product or service and the technical idea (servers, racks, cloud regions, proxy routes between nodes, network traffic, a terminal or dashboard drawn as abstract shapes). Describe real object types and their details, not metaphors.',
    '- scene: the environment and background around the subject.',
    `- composition: framing for a ${shapeOf(image)} image in a feed: one focal point, the camera angle or view (for example three-quarter isometric, low-angle hero shot, close-up with shallow depth of field), depth layers and where the empty space is. Keep the subject centred with safe margins: feeds crop the edges.`,
    '- lighting: direction, quality and accents of the light.',
    '- palette: 3 to 5 colours. Use the brand colours if the brand profile names them; otherwise deep navy or indigo with cyan and violet accents.',
    `- style: one rendering style that fits ${image.style}: a premium 3D render, an isometric 3D illustration or a cinematic product photograph. Never flat clip-art or cartoon.`,
    '- mood: two or three words.',
    '- details: 3 to 6 small concrete details tying the image to this post. Turn figures into visible quantities (three server nodes, a doubled data stream), never written digits.',
    '- avoid: what would look cheap or mislead for this post.',
    `- altText: one sentence in ${language === 'vi' ? 'Vietnamese' : 'English'} describing the image for screen readers.`,
    'Rules: write every field except altText in English. No text, letters, numbers, logos, brand marks, interface text, real people or faces. No clichés: hooded hacker, binary-code rain, glowing brain, handshake, rocket launch, generic gears, a padlock unless the post is about security. No lifestyle props (coffee cups, plants, wooden desks, printed photos) and no landscapes or nature metaphors. Hardware must look physically plausible and modern.',
  ].join('\n');
}

/** The prompt sent to the image generator, built from the art director's brief. */
export function composeImagePrompt(brief: ImageBrief, platformName: string, image: PlatformImagePlan): string {
  const line = (label: string, text: string) => `${label}: ${text.replace(/\s+/g, ' ').trim().replace(/[.;]+$/, '')}.`;
  return [
    `${brief.style.replace(/[.;]+$/, '')} for a ${platformName} post, ${shapeOf(image)} frame.`,
    line('Subject', brief.subject),
    line('Scene', brief.scene),
    line('Composition', brief.composition),
    line('Lighting', brief.lighting),
    line('Colour palette', brief.palette),
    line('Mood', brief.mood),
    brief.details.length ? line('Details', brief.details.join('; ')) : '',
    line('Avoid', [...brief.avoid, 'any text, letters, numbers, logos or watermarks'].join(', ')),
  ].filter(Boolean).join('\n').slice(0, 3_000);
}

/**
 * The image decision belongs to the route, not the writer: a destination
 * without an image never carries a media request, and one with an image always
 * has a prompt to draw from, even when the model left it empty.
 */
function mediaForPlan(generated: GeneratedVariant, image: PlatformImagePlan | null): GeneratedVariant['media'] {
  if (!image) return { type: 'none', altText: '', prompt: null };
  const prompt = generated.media.prompt?.trim()
    || `${image.style}, modern technology look with dark navy background and blue or cyan light. It illustrates: ${(generated.title ?? generated.body).replace(/\s+/g, ' ').slice(0, 300)}. No text, letters, logos or recognisable people.`;
  return { type: 'image', altText: generated.media.altText.trim(), prompt };
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
  private readonly vpstttThrottle: ProviderThrottle;
  private readonly vpstttBaseUrl?: string;

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
    this.vpstttBaseUrl = config.get<string>('VPSTTT_AI_BASE_URL')?.trim() || undefined;
    this.vpstttThrottle = new ProviderThrottle(
      Number(config.get<number>('VPSTTT_AI_MAX_CONCURRENCY', 2)),
      Number(config.get<number>('VPSTTT_AI_RPM', 10)),
    );
    for (const provider of AI_PROVIDER_IDS) {
      if (provider === 'gemini') continue;
      const apiKey = config.get<string>(PROVIDER_API_KEY_ENV[provider])?.trim();
      if (!apiKey) continue;
      if (provider === 'vpsttt') {
        if (!this.vpstttBaseUrl) continue;
        // Each request runs a Claude/Codex session, so it is slow and counted
        // against a small per-key quota: no SDK retries, a longer timeout.
        this.clients.vpsttt = new OpenAI({
          apiKey,
          baseURL: this.vpstttBaseUrl,
          timeout: Number(config.get<number>('VPSTTT_AI_TIMEOUT_MS', 180_000)),
          maxRetries: 0,
        });
        continue;
      }
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
    assertOwnership?: () => Promise<void>,
    images?: ReadonlyMap<string, PlatformImagePlan>,
    /**
     * Saves each platform's variant as soon as it is generated and reports it, so
     * a long run can be reviewed while it goes on. Without it, nothing is saved
     * unless every platform succeeds (Content Studio keeps that all-or-nothing).
     */
    onVariant?: (variant: ContentVariant) => Promise<void>,
  ) {
    await assertOwnership?.();
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
      const generated: Array<GeneratedVariant | undefined> = [];
      const saved: Array<ContentVariant | undefined> = [];
      let failure: { error: unknown } | undefined;
      let next = 0;
      // Bound provider concurrency for large multi-platform campaigns: four at a
      // time, and a finished platform frees its slot for the next one at once.
      // After a failure no new platform starts; the ones in flight still finish.
      const worker = async () => {
        while (!failure && next < platforms.length) {
          const index = next++;
          const platform = platforms[index]!;
          try {
            const prompt = platform.prompts[0];
            if (!prompt) throw new ApplicationException(ErrorCode.RESOURCE_NOT_FOUND, `No active prompt for ${platform.slug}`, HttpStatus.NOT_FOUND);
            const result = await this.generateChecked(provider, platform.slug, prompt.systemPrompt, prompt.userTemplate, content, brand, images?.get(platform.slug) ?? null);
            if (!onVariant) { generated[index] = result; continue; }
            await assertOwnership?.();
            const variant = await this.saveVariant(this.prisma, contentId, platform.id, result);
            saved[index] = variant;
            await onVariant(variant);
          } catch (error) { failure ??= { error }; }
        }
      };
      await Promise.all(Array.from({ length: Math.min(4, platforms.length) }, worker));
      if (failure) throw failure.error;
      await assertOwnership?.();
      if (onVariant) {
        const completed = await this.prisma.content.updateMany({
          where: { id: contentId, ownerId, status: ContentStatus.AI_GENERATING },
          data: { status: ContentStatus.GENERATED },
        });
        if (!completed.count) {
          throw new ApplicationException(ErrorCode.CONFLICT, 'Content changed while generation was completing', HttpStatus.CONFLICT);
        }
        return saved.filter((variant): variant is ContentVariant => Boolean(variant));
      }
      return await this.prisma.$transaction(async (transaction) => {
        const results: ContentVariant[] = [];
        for (const [index, platform] of platforms.entries()) results.push(await this.saveVariant(transaction, contentId, platform.id, generated[index]!));
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
      // A replaced background worker must not reset the new worker's claim.
      if (assertOwnership) {
        try { await assertOwnership(); } catch { throw error; }
      }
      await this.prisma.content.updateMany({
        where: { id: contentId, ownerId, status: ContentStatus.AI_GENERATING },
        data: { status: content.status },
      });
      throw error;
    }
  }

  /** The next version of this platform's variant for the content. */
  private async saveVariant(db: Prisma.TransactionClient, contentId: string, platformId: string, generated: GeneratedVariant): Promise<ContentVariant> {
    const latest = await db.contentVariant.aggregate({ where: { contentId, platformId }, _max: { version: true } });
    return db.contentVariant.create({
      data: {
        contentId,
        platformId,
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
    });
  }

  /**
   * One structured answer from the chosen (or default) provider, validated
   * against `spec`, with the same single retry as content generation.
   */
  async generateStructured<T>(spec: StructuredSpec<T>, instructions: string, input: string, requestedProvider?: AiProvider): Promise<T> {
    const provider = this.resolveProvider(requestedProvider);
    await this.assertConfigured(provider);
    return this.withGenerationRetry(() => this.requestStructured(provider, instructions, input, spec));
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
    image: PlatformImagePlan | null = null,
    revision?: DraftRevision,
  ): Promise<GeneratedVariant> {
    const contract = platformContract(platform, {
      sourceText: content.body,
      defaultLanguage: brand?.defaultLanguage,
      platformLanguages: brand?.platformLanguages,
    });
    const engine = extensionFlowForPlatform(platform)?.engine;
    // Plain-text destinations get clean paragraphs whatever the route (API or
    // extension), so stray Markdown never reaches readers.
    const write = async (feedback?: string, revisionText?: string) => {
      const generated = await this.withGenerationRetry(() => (
        this.callModel(provider, platform, systemPrompt, userTemplate, content, { contract, brand, feedback, image, engine, revision: revisionText })
      ));
      const media = mediaForPlan(generated, image);
      return contract.format === 'plain' ? { ...generated, media, body: markdownToPlain(generated.body) } : { ...generated, media };
    };
    let draft = await write(undefined, revision ? revisionBrief(revision) : undefined);
    let assessment = await this.assess(provider, draft, contract, content, brand);
    let best = { draft, assessment };
    // A draft the writer itself flags as off-topic for this audience
    // (recommended=false) is not fixed by rewriting; it goes to the operator.
    // Each rewrite answers the latest review; the best-scoring attempt is kept,
    // since a rewrite can also score lower than the draft before it.
    const standing = [
      revision?.instruction ? `The operator's instructions still apply: ${revision.instruction}` : '',
      revision?.chosenNotes?.length ? `The fixes the operator chose still apply: ${revision.chosenNotes.join('; ')}` : '',
    ].filter(Boolean).map((line) => `\n- ${line}`).join('');
    const rank = (candidate: Assessment) => draftRank(candidate.passed, candidate.review, candidate.issues, candidate.overLimit);
    for (let rewrite = 0; rewrite < QUALITY_MAX_REWRITES && !assessment.passed; rewrite += 1) {
      draft = await write(`${rewriteFeedback(assessment.issues, assessment.review)}${standing}`);
      assessment = await this.assess(provider, draft, contract, content, brand);
      if (rank(assessment) >= rank(best.assessment)) best = { draft, assessment };
    }
    const fitted = await this.fitDraft(write, platform, contract, best.draft, best.assessment, content.canonicalUrl);
    ({ draft, assessment } = fitted);
    const { shortened } = fitted;
    // A revision keeps the post's current image; only new drafts get one designed.
    if (image && !revision) draft = { ...draft, media: await this.directImage(provider, contract, draft, content, brand, image) };
    const hashtags = [...new Set(draft.hashtags.map((tag) => tag.trim().replace(/^#+/, '')).filter(Boolean))];
    const scoreText = assessment.review ? `AI chấm ${assessment.review.score}/10` : 'AI chưa chấm được';
    // A machine cut may have dropped the post's ending: a person reads it first.
    const recommended = assessment.passed && draft.recommended && shortened !== 'cut';
    const problems = [
      ...(!draft.recommended ? [`AI đánh giá không hợp nơi đăng: ${draft.reason}`] : []),
      ...(shortened === 'cut' ? ['Máy đã cắt bớt phần cuối bài, đọc lại trước khi duyệt'] : []),
      ...assessment.issues,
      ...(assessment.review && !reviewPassed(assessment.review) ? assessment.review.unsupportedClaims.map((claim) => `Thông tin chưa có căn cứ: ${claim}`) : []),
      ...(assessment.review && !reviewPassed(assessment.review) ? assessment.review.issues : []),
    ];
    const reason = recommended
      ? `${draft.reason} (${scoreText})`
      : `Cần xem lại (${scoreText}): ${[...new Set(problems)].join('; ') || `điểm dưới ${QUALITY_PASS_SCORE}/10`}`;
    const note = shortened ? ` · đã rút gọn tự động để vừa ${contract.maxChars} ký tự` : '';
    return {
      ...draft,
      // A planned image is created after the post is saved: until then the
      // post is not ready to approve or publish.
      media: image && !revision ? { ...draft.media, status: 'pending' } : draft.media,
      hashtags: contract.hashtagMode === 'inline' ? hashtags : hashtags.slice(0, contract.maxHashtags),
      recommended,
      // The shortening note is kept even when a long reason is cut.
      reason: `${reason.slice(0, MAX_REASON_LENGTH - note.length)}${note}`,
    };
  }

  /**
   * Never returns a draft over the destination's limit. When the best draft is
   * still too long after the rewrites, the writer is asked once to only
   * shorten it, with the exact numbers; if that is still over (or fails), the
   * post is cut mechanically at the last sentence that fits (fitToLimit).
   * The editor's score of the longer draft is kept; machine checks are redone.
   */
  private async fitDraft(
    write: (feedback?: string, revisionText?: string) => Promise<GeneratedVariant>,
    platform: string,
    contract: PlatformContract,
    best: GeneratedVariant,
    assessment: Assessment,
    canonicalUrl: string | null,
  ): Promise<{ draft: GeneratedVariant; assessment: Assessment; shortened: Shortening }> {
    let draft = best;
    let shortened: Shortening = null;
    if (assessment.overLimit) {
      try {
        const shorter = await write(undefined, shortenBrief(best, contract, assessment.length, canonicalUrl));
        // Only the text changes; the writer's judgement of fit and the image stay.
        const candidate = { ...best, title: shorter.title ?? best.title, body: shorter.body, hashtags: shorter.hashtags };
        const length = publishedLength(candidate, contract, canonicalUrl);
        if (length < assessment.length) { draft = candidate; shortened = 'writer'; }
      } catch (error) {
        this.logger.warn(`AI shortening unavailable for ${contract.slug}: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (publishedLength(draft, contract, canonicalUrl) > contract.maxChars!) {
        draft = { ...draft, ...fitToLimit(draft, contract, canonicalUrl) };
        shortened = 'cut';
      }
    }
    // Approval counts with the post's own language; a one-character difference
    // in the source label must not let a post through here and fail there.
    if (checkPostLength({ ...draft, platformSlug: platform, canonicalUrl }).over) {
      draft = { ...draft, ...fitToLimit(draft, contractFor({ platformSlug: platform, body: draft.body }), canonicalUrl) };
      shortened = 'cut';
    }
    return { draft, assessment: shortened ? this.recheck(draft, contract, assessment.review, canonicalUrl) : assessment, shortened };
  }

  /** Machine checks of a shortened draft, keeping the editor's review of the longer one. */
  private recheck(draft: GeneratedVariant, contract: PlatformContract, review: ContentReview | null, canonicalUrl: string | null): Assessment {
    const issues = deterministicIssues(draft, contract, canonicalUrl);
    const length = contract.maxChars ? publishedLength(draft, contract, canonicalUrl) : 0;
    return { passed: issues.length === 0 && reviewPassedOrMissing(review), issues, review, length, overLimit: Boolean(contract.maxChars) && length > contract.maxChars! };
  }

  /**
   * Designs the image from the finished post. If the art director is
   * unavailable, the writer's own description is kept: the post never fails
   * because of its image.
   */
  private async directImage(
    provider: AiProvider,
    contract: PlatformContract,
    draft: GeneratedVariant,
    content: SourceContent,
    brand: BrandProfile | null,
    image: PlatformImagePlan,
  ): Promise<GeneratedVariant['media']> {
    try {
      const brief = await this.imageBrief(provider, contract, draft, content, brand, image, draft.media.prompt);
      return { type: 'image', prompt: composeImagePrompt(brief, contract.name, image), altText: brief.altText.slice(0, 300) };
    } catch (error) {
      this.logger.warn(`AI image brief unavailable for ${contract.slug}: ${error instanceof Error ? error.message : String(error)}`);
      return draft.media;
    }
  }

  private imageBrief(
    provider: AiProvider,
    contract: PlatformContract,
    post: { title: string | null; body: string },
    content: SourceContent,
    brand: BrandProfile | null,
    image: PlatformImagePlan,
    writerIdea?: string | null,
  ): Promise<ImageBrief> {
    return this.withGenerationRetry(() => this.requestStructured(
      provider,
      imageBriefInstructions(contract.name, image, contract.language),
      [
        brandProfileBlock(brand),
        `Brief or source:\n${content.body.slice(0, 6_000)}`,
        `Finished ${contract.name} post:\n${JSON.stringify({ title: post.title, body: post.body.slice(0, 4_000) })}`,
        writerIdea ? `The writer's first idea for the image (improve on it, keep what fits):\n${writerIdea}` : '',
      ].filter(Boolean).join('\n\n'),
      IMAGE_BRIEF_SPEC,
    ));
  }

  /**
   * Image description for a post that already exists (one without an image),
   * designed from its text by the art director. Unlike new drafts there is no
   * writer idea to fall back on, so a failure is reported to the caller.
   */
  async designImage(
    ownerId: string,
    input: { contentId: string; platformSlug: string; post: { title: string | null; body: string }; image: PlatformImagePlan },
    requestedProvider?: AiProvider,
  ): Promise<{ prompt: string; altText: string }> {
    const provider = this.resolveProvider(requestedProvider);
    await this.assertConfigured(provider);
    const content = await this.prisma.content.findFirstOrThrow({ where: { id: input.contentId, ownerId } });
    const brand = await this.brandProfiles?.load() ?? null;
    const contract = platformContract(input.platformSlug, {
      sourceText: content.body,
      defaultLanguage: brand?.defaultLanguage,
      platformLanguages: brand?.platformLanguages,
    });
    const brief = await this.imageBrief(provider, contract, input.post, content, brand, input.image);
    return { prompt: composeImagePrompt(brief, contract.name, input.image), altText: brief.altText.slice(0, 300) };
  }

  /**
   * A new version of one platform's stored draft: the writer revises it from the
   * operator's instruction and the last review, then it is checked (and
   * rewritten if needed) like a new draft. The caller stores the result.
   */
  async reviseDraft(
    ownerId: string,
    input: { contentId: string; platformSlug: string; revision: DraftRevision; image?: PlatformImagePlan | null },
    requestedProvider?: AiProvider,
  ): Promise<GeneratedVariant> {
    const provider = this.resolveProvider(requestedProvider);
    await this.assertConfigured(provider);
    const content = await this.prisma.content.findFirstOrThrow({ where: { id: input.contentId, ownerId } });
    const platform = await this.prisma.platform.findFirst({
      where: { slug: input.platformSlug },
      include: { prompts: { where: { active: true }, orderBy: { version: 'desc' }, take: 1 } },
    });
    const prompt = platform?.prompts[0];
    if (!prompt) throw new ApplicationException(ErrorCode.RESOURCE_NOT_FOUND, `No active AI prompt for ${input.platformSlug}`, HttpStatus.NOT_FOUND);
    const brand = await this.brandProfiles?.load() ?? null;
    return this.generateChecked(provider, input.platformSlug, prompt.systemPrompt, prompt.userTemplate, content, brand, input.image ?? null, input.revision);
  }

  private async assess(
    provider: AiProvider,
    draft: GeneratedVariant,
    contract: PlatformContract,
    content: SourceContent,
    brand: BrandProfile | null,
  ): Promise<Assessment> {
    const issues = deterministicIssues(draft, contract, content.canonicalUrl);
    const length = contract.maxChars ? publishedLength(draft, contract, content.canonicalUrl) : 0;
    let review: ContentReview | null = null;
    try {
      review = clampReview(await this.withGenerationRetry(() => this.requestStructured(
        provider,
        reviewInstructions(contract, contract.maxChars ? length : undefined),
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
    return { passed, issues, review, length, overLimit: Boolean(contract.maxChars) && length > contract.maxChars! };
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
      options.revision ?? '',
      options.feedback ? `Your previous draft was rejected by the editor. Rewrite it from scratch and fix:\n${options.feedback}` : '',
    ].filter(Boolean).join('\n\n');
    const instructions = [
      systemPrompt,
      options.contract ? contractInstructions(options.contract, content.canonicalUrl) : '',
      options.contract ? qualityInstructions(options.contract, options.engine) : '',
      options.contract ? imageInstructions(options.contract.name, options.image) : '',
    ].filter(Boolean).join('\n\n');
    return this.requestStructured(provider, instructions, input, VARIANT_SPEC);
  }

  private async requestStructured<T>(provider: AiProvider, instructions: string, input: string, spec: StructuredSpec<T>): Promise<T> {
    if (provider === 'gemini') return this.callGemini(instructions, input, spec);
    if (provider === 'vpsttt') return this.callVpsttt(instructions, input, spec);
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

  /**
   * The IDE AI API accepts only model, messages (plain text) and stream=false;
   * any other parameter is rejected with HTTP 400. The JSON contract therefore
   * travels in the system message and the reply is validated here.
   */
  private async callVpsttt<T>(instructions: string, input: string, spec: StructuredSpec<T>): Promise<T> {
    const client = this.clientFor('vpsttt');
    const system = `${instructions}\n\nReturn only one JSON object, with no Markdown, code fence or text around it, matching this JSON Schema:\n${JSON.stringify(spec.jsonSchema)}`;
    const budget = VPSTTT_MAX_TOTAL_CHARS - system.length - VPSTTT_CHAR_MARGIN;
    if (budget < 1_000) {
      throw new ApplicationException(ErrorCode.VALIDATION_FAILED, 'The AI prompt is too long for VPSTTT AI', HttpStatus.BAD_REQUEST);
    }
    const user = input.length > budget ? input.slice(0, budget) : input;
    if (user.length < input.length) this.logger.warn(`VPSTTT AI input trimmed from ${input.length} to ${user.length} characters`);
    const response = await this.requestFromProvider('vpsttt', () => this.vpstttThrottle.run(() => (
      client.chat.completions.create({
        model: this.models.vpsttt,
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
        stream: false,
      })
    )));
    return this.parseStructured(extractJsonObject(response.choices[0]?.message.content ?? ''), spec);
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

    if (provider === 'vpsttt' && (status === 401 || status === 403)) {
      return new ApplicationException(
        ErrorCode.PLATFORM_AUTH_FAILED,
        `${label} refused the key. Check VPSTTT_AI_API_KEY, the key's allowed IPs and that the IDE AI API is enabled for its owner`,
        HttpStatus.BAD_GATEWAY,
      );
    }
    if (provider === 'vpsttt' && status === 400) {
      return new ApplicationException(
        ErrorCode.PLATFORM_API_ERROR,
        `${label} rejected the request (unsupported parameter, model or input size)`,
        HttpStatus.BAD_GATEWAY,
      );
    }
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
      const missing = provider === 'vpsttt' && !this.vpstttBaseUrl ? 'VPSTTT_AI_BASE_URL' : PROVIDER_API_KEY_ENV[provider];
      throw new ApplicationException(
        ErrorCode.INFRASTRUCTURE_UNAVAILABLE,
        `${missing} is not configured`,
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    return client;
  }
}

/**
 * Chat models without a JSON mode sometimes wrap the object in a code fence or
 * a sentence. Keep only the outermost object; parseStructured still validates it.
 */
export function extractJsonObject(text: string): string {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  if (fenced?.[1] !== undefined) return fenced[1].trim();
  if (trimmed.startsWith('{')) return trimmed;
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  return start >= 0 && end > start ? trimmed.slice(start, end + 1) : trimmed;
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
