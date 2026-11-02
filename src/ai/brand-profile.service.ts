import { Injectable, Logger } from '@nestjs/common';
import { z } from 'zod';
import { PrismaService } from '../database/prisma.service';

export const BRAND_PROFILE_SETTING_KEY = 'ai.brand-profile';
const MAX_PROFILE_BYTES = 8 * 1024;

const text = (max: number) => z.string().trim().min(1).max(max);
const language = z.enum(['vi', 'en']);

/**
 * Facts the owner stands behind. The model may cite only these (plus the
 * brief) for brand claims: products, numbers, prices, proof and links.
 */
export const BrandProfileSchema = z.object({
  brandName: text(120).optional(),
  oneLiner: text(300).optional(),
  audience: text(500).optional(),
  voice: text(500).optional(),
  facts: z.array(text(300)).max(30).optional(),
  links: z.array(z.object({ label: text(80), url: z.string().trim().url().max(500) }).strict()).max(10).optional(),
  disclosure: text(200).optional(),
  avoid: z.array(text(200)).max(20).optional(),
  defaultLanguage: language.optional(),
  platformLanguages: z.record(z.string().regex(/^[a-z0-9-]{1,64}$/), language).optional(),
}).strict();

export type BrandProfile = z.infer<typeof BrandProfileSchema>;

@Injectable()
export class BrandProfileService {
  private readonly logger = new Logger(BrandProfileService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** A missing or invalid profile never blocks generation; it is logged and ignored. */
  async load(): Promise<BrandProfile | null> {
    let value: unknown;
    try {
      const setting = await this.prisma.systemSetting.findUnique({ where: { key: BRAND_PROFILE_SETTING_KEY } });
      if (!setting) return null;
      if (setting.secret) {
        this.logger.warn(`${BRAND_PROFILE_SETTING_KEY} must not be stored as a secret setting; ignored`);
        return null;
      }
      value = setting.value;
    } catch (error) {
      this.logger.warn(`Could not read ${BRAND_PROFILE_SETTING_KEY}: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
    return parseBrandProfile(value, (message) => this.logger.warn(message));
  }
}

export function parseBrandProfile(value: unknown, warn: (message: string) => void = () => undefined): BrandProfile | null {
  if (Buffer.byteLength(JSON.stringify(value ?? null), 'utf8') > MAX_PROFILE_BYTES) {
    warn(`${BRAND_PROFILE_SETTING_KEY} exceeds ${MAX_PROFILE_BYTES} bytes; ignored`);
    return null;
  }
  const parsed = BrandProfileSchema.safeParse(value);
  if (!parsed.success) {
    warn(`${BRAND_PROFILE_SETTING_KEY} is invalid and was ignored: ${parsed.error.issues.map((issue) => `${issue.path.join('.') || 'root'} ${issue.message}`).join('; ')}`);
    return null;
  }
  return parsed.data;
}

/** Data block for the user message; delimited so it is read as facts, not instructions. */
export function brandProfileBlock(profile: BrandProfile | null): string {
  if (!profile) return '';
  const lines = [
    profile.brandName && `Brand: ${profile.brandName}`,
    profile.oneLiner && `What it is: ${profile.oneLiner}`,
    profile.audience && `Audience: ${profile.audience}`,
    profile.voice && `Voice: ${profile.voice}`,
    profile.facts?.length && `Facts you may use:\n${profile.facts.map((fact) => `- ${fact}`).join('\n')}`,
    profile.links?.length && `Links you may use:\n${profile.links.map((link) => `- ${link.label}: ${link.url}`).join('\n')}`,
    profile.disclosure && `Disclosure line for forums and communities: ${profile.disclosure}`,
    profile.avoid?.length && `Never say or claim:\n${profile.avoid.map((item) => `- ${item}`).join('\n')}`,
  ].filter(Boolean);
  return lines.length ? `<brand_facts>\n${lines.join('\n')}\n</brand_facts>` : '';
}
