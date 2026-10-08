import { HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ContentStatus, VariantStatus } from '@prisma/client';
import OpenAI from 'openai';
import { z } from 'zod';
import { ApplicationException, ErrorCode } from '../common/exceptions/application.exception';
import { PrismaService } from '../database/prisma.service';

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

@Injectable()
export class AiContentService {
  private readonly client?: OpenAI;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {
    const apiKey = config.get<string>('OPENAI_API_KEY');
    if (apiKey) this.client = new OpenAI({ apiKey, timeout: config.get<number>('OPENAI_TIMEOUT_MS', 60_000) });
  }

  async assertReady(platformSlugs: string[]): Promise<void> {
    this.assertClientConfigured();
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

  async generate(ownerId: string, contentId: string, platformSlugs: string[]) {
    this.assertClientConfigured();
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
        const generated = await this.callModel(platform.slug, prompt.systemPrompt, prompt.userTemplate, content);
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
    const response = await this.client!.responses.create({
      model: this.config.get<string>('OPENAI_MODEL', 'gpt-5-mini'),
      instructions: systemPrompt,
      input,
      store: false,
      text: { format: { type: 'json_schema', name: 'content_variant', strict: true, schema: outputSchema } },
    });
    return this.parseOutput(response.output_text);
  }

  private assertClientConfigured(): void {
    if (!this.client) {
      throw new ApplicationException(
        ErrorCode.INFRASTRUCTURE_UNAVAILABLE,
        'OPENAI_API_KEY is not configured',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
  }
}
