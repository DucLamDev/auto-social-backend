import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../database/prisma.service';
import { BRAND_DATACENTERS } from '../platforms/brand-footer';

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
  // Only web links: the AI may put them in posts, where any other scheme is a hazard.
  links: z.array(z.object({ label: text(80), url: z.string().trim().url().max(500).regex(/^https?:\/\//i) }).strict()).max(10).optional(),
  disclosure: text(200).optional(),
  avoid: z.array(text(200)).max(20).optional(),
  defaultLanguage: language.optional(),
  platformLanguages: z.record(z.string().regex(/^[a-z0-9-]{1,64}$/), language).optional(),
}).strict();

export type BrandProfile = z.infer<typeof BrandProfileSchema>;

/** What the settings form edits; the reading languages are not part of it and stay as saved. */
export const BrandProfileContentSchema = BrandProfileSchema.omit({ defaultLanguage: true, platformLanguages: true });
export type BrandProfileContent = z.infer<typeof BrandProfileContentSchema>;

/**
 * Where the form starts when nothing is saved: only what the company already
 * publishes in its footer, and the claims the AI reviewer already treats as a
 * brand risk. No prices, offers or numbers it has not published, and no contact
 * details (the footer adds those to the brand's own channels).
 */
export const SUGGESTED_BRAND_PROFILE: BrandProfileContent = {
  brandName: 'VPSTTT',
  oneLiner: 'Nhà cung cấp VPS và proxy tại Việt Nam.',
  facts: [
    `Máy chủ đặt tại các datacenter ${BRAND_DATACENTERS.join(', ')} ở Việt Nam`,
    'Hỗ trợ khách hàng bằng tiếng Việt qua hotline, email và Zalo',
  ],
  disclosure: 'Mình làm ở VPSTTT, bên cung cấp VPS và proxy.',
  avoid: [
    'Rẻ nhất, giá thấp nhất thị trường',
    'Uptime 100% hay cam kết không bao giờ gián đoạn',
    'Không giới hạn băng thông hay tài nguyên khi gói không ghi rõ',
    'Proxy không bao giờ bị chặn hay không thể bị phát hiện',
    'Cam kết kết quả: lượt xem, doanh thu, thứ hạng',
    'Cách dùng VPS, proxy để lách luật, vượt chặn, spam hay tạo tài khoản hàng loạt',
  ],
};

export interface BrandProfileView {
  /** The saved profile the AI writes with; null when none is saved or the AI ignores it. */
  profile: BrandProfile | null;
  /** A profile is saved but the AI ignores it (invalid, over 8 KB or stored as a secret). */
  invalid: boolean;
  updatedAt: string | null;
  suggested: BrandProfileContent;
}

const FIELD_LABELS: Record<string, string> = {
  brandName: 'Tên thương hiệu', oneLiner: 'Giới thiệu một câu', audience: 'Người đọc', voice: 'Giọng văn',
  facts: 'Thông tin AI được dùng', links: 'Liên kết', disclosure: 'Câu tự giới thiệu', avoid: 'Điều không được nói',
};

/** "Liên kết dòng 2 (địa chỉ): không phải địa chỉ web http(s)" for the operator. */
function describeIssue(issue: z.core.$ZodIssue): string {
  if (issue.code === 'unrecognized_keys') return `Trường không hỗ trợ: ${issue.keys.join(', ')}`;
  const [field, row, part] = issue.path;
  const where = `${FIELD_LABELS[String(field)] ?? 'Hồ sơ'}${typeof row === 'number' ? ` dòng ${row + 1}` : ''}${part === 'url' ? ' (địa chỉ)' : part === 'label' ? ' (tên)' : ''}`;
  const what = issue.code === 'too_small' ? 'đang trống'
    : issue.code === 'too_big' ? (issue.origin === 'array' ? `nhiều quá ${String(issue.maximum)} dòng` : `dài quá ${String(issue.maximum)} ký tự`)
      : issue.code === 'invalid_format' ? 'không phải địa chỉ web http(s)'
        : 'không hợp lệ';
  return `${where}: ${what}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Drops fields left out of the profile so the saved JSON only has what was written. */
function compact(profile: BrandProfile): BrandProfile {
  return Object.fromEntries(Object.entries(profile).filter(([, value]) => value !== undefined && !(Array.isArray(value) && !value.length)));
}

@Injectable()
export class BrandProfileService {
  private readonly logger = new Logger(BrandProfileService.name);

  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  /** The saved profile for the settings form, with the suggestion it starts from when there is none. */
  async view(): Promise<BrandProfileView> {
    const setting = await this.prisma.systemSetting.findUnique({ where: { key: BRAND_PROFILE_SETTING_KEY } });
    return this.toView(setting);
  }

  /**
   * Saves what the form edits. The reading languages already saved (set as JSON
   * in the general settings) are kept, and the whole profile must pass the same
   * checks `load` applies, so the AI never ignores a profile saved here.
   */
  async save(input: unknown, actorId?: string): Promise<BrandProfileView> {
    const parsed = BrandProfileContentSchema.safeParse(input);
    if (!parsed.success) {
      const issues = parsed.error.issues.slice(0, 5).map(describeIssue);
      throw new BadRequestException({ message: `Hồ sơ thương hiệu chưa hợp lệ: ${issues.join('; ')}.`, details: { issues } });
    }
    const existing = await this.prisma.systemSetting.findUnique({ where: { key: BRAND_PROFILE_SETTING_KEY } });
    // A secret setting holds an encrypted blob, never a profile: nothing to keep from it.
    const saved = existing && !existing.secret && isRecord(existing.value) ? existing.value : null;
    const profile = compact({
      ...parsed.data,
      defaultLanguage: BrandProfileSchema.shape.defaultLanguage.safeParse(saved?.defaultLanguage).data,
      platformLanguages: BrandProfileSchema.shape.platformLanguages.safeParse(saved?.platformLanguages).data,
    });
    if (Buffer.byteLength(JSON.stringify(profile), 'utf8') > MAX_PROFILE_BYTES) {
      throw new BadRequestException(`Hồ sơ thương hiệu dài quá ${MAX_PROFILE_BYTES / 1024} KB. Bớt vài dòng thông tin rồi lưu lại.`);
    }
    const value = profile as Prisma.InputJsonObject;
    const setting = await this.prisma.systemSetting.upsert({
      where: { key: BRAND_PROFILE_SETTING_KEY },
      create: { key: BRAND_PROFILE_SETTING_KEY, value, secret: false, description: 'Hồ sơ thương hiệu AI dùng khi viết bài' },
      update: { value, secret: false },
    });
    await this.audit.recordBestEffort({
      actorId, action: 'BRAND_PROFILE_UPDATED', entityType: 'system_setting', entityId: BRAND_PROFILE_SETTING_KEY, before: saved ?? undefined, after: profile,
    });
    return this.toView(setting);
  }

  private toView(setting: { value: Prisma.JsonValue; secret: boolean; updatedAt: Date } | null): BrandProfileView {
    const profile = setting && !setting.secret ? parseBrandProfile(setting.value) : null;
    return { profile, invalid: Boolean(setting) && !profile, updatedAt: setting?.updatedAt.toISOString() ?? null, suggested: SUGGESTED_BRAND_PROFILE };
  }

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
