import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { ContentStatus, Prisma, VariantStatus } from '@prisma/client';
import { approvalHash, type AiApproval } from '../ai/content-approval';
import { PrismaService } from '../database/prisma.service';
import { platformContract } from '../platforms/platform-contract';
import { checkPostLength, postLengthMessage } from '../platforms/post-length';
import type { PostTextInput } from '../platforms/post-text';
import { aiApprovalProblem, withAiApprovalCurrent } from './ai-approval-gate';
import { VariantApprovalService } from './variant-approval.service';
import { previewRoute, variantPreview, type PreviewRoute } from './variant-preview';
import { CreateContentVariantDto } from './dto/create-content-variant.dto';

/**
 * Refuses a post its platform would not take. A variant is written per
 * platform, so it is checked the way the platform's default posting route
 * counts it; approval checks again for each account's own route.
 */
function assertFitsPlatform(platformSlug: string, post: PostTextInput, canonicalUrl: string | null): void {
  const length = checkPostLength({ ...post, platformSlug, canonicalUrl });
  if (length.over) throw new BadRequestException(postLengthMessage(platformContract(platformSlug).name, length));
}

const variantInclude = {
  platform: { select: { slug: true, name: true } },
  content: { select: { id: true, title: true } },
} satisfies Prisma.ContentVariantInclude;

@Injectable()
export class ContentVariantsService {
  constructor(private readonly prisma: PrismaService, private readonly approvals: VariantApprovalService) {}

  async createManual(ownerId: string, dto: CreateContentVariantDto) {
    const body = dto.body.trim();
    if (!body) throw new BadRequestException('Variant body must not be blank');

    const platformSlug = dto.platformSlug.trim().toLowerCase();
    if (!platformSlug) throw new BadRequestException('Platform slug must not be blank');
    const hashtags = this.normalizeHashtags(dto.hashtags ?? []);
    const title = dto.title?.trim() || null;
    // A hand-written post goes to the final approver like an AI draft.
    const approval = this.approvals.enabled() ? await this.approvals.runningApproval({ title, body, hashtags }) : undefined;

    const created = await this.prisma.$transaction(async (transaction) => {
      const content = await transaction.content.findFirstOrThrow({
        where: { id: dto.contentId, ownerId },
        select: { id: true, canonicalUrl: true },
      });
      const platform = await transaction.platform.findFirstOrThrow({
        where: { slug: platformSlug, enabled: true },
        select: { id: true },
      });
      assertFitsPlatform(platformSlug, { title, body, hashtags }, content.canonicalUrl);

      // Updating the parent row serializes concurrent manual creates for the
      // same content before calculating the next per-platform version.
      await transaction.content.update({
        where: { id: content.id },
        data: { status: ContentStatus.GENERATED },
      });
      const latest = await transaction.contentVariant.aggregate({
        where: { contentId: content.id, platformId: platform.id },
        _max: { version: true },
      });

      return transaction.contentVariant.create({
        data: {
          contentId: content.id,
          platformId: platform.id,
          title,
          body,
          hashtags,
          recommended: true,
          reason: 'Created manually by an editor',
          status: VariantStatus.GENERATED,
          version: (latest._max.version ?? 0) + 1,
          ...(approval ? { aiApproval: approval as unknown as Prisma.InputJsonObject } : {}),
        },
        include: variantInclude,
      });
    });
    if (approval) this.approvals.launch(ownerId, created.id, approval);
    return withAiApprovalCurrent(created);
  }

  async list(ownerId: string, contentId?: string) {
    const variants = await this.prisma.contentVariant.findMany({
      where: { contentId, content: { ownerId } },
      include: variantInclude,
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    return variants.map(withAiApprovalCurrent);
  }

  async updateUnreferenced(
    ownerId: string,
    id: string,
    data: Prisma.ContentVariantUpdateManyMutationInput,
  ) {
    const approval = await this.checkEdit(ownerId, id, data);
    const updated = await this.prisma.contentVariant.updateMany({
      where: {
        id,
        content: { ownerId },
        targets: { none: {} },
      },
      // New text is sent to the final approver again; its old verdict no longer applies.
      data: approval ? { ...data, aiApproval: approval as unknown as Prisma.InputJsonObject } : data,
    });
    if (!updated.count) {
      await this.prisma.contentVariant.findFirstOrThrow({
        where: { id, content: { ownerId } },
        select: { id: true },
      });
      throw new ConflictException('A content variant is immutable after it has been added to a campaign');
    }
    const variant = await this.prisma.contentVariant.findUniqueOrThrow({ where: { id }, include: variantInclude });
    if (approval) this.approvals.launch(ownerId, id, approval);
    return withAiApprovalCurrent(variant);
  }

  /**
   * An edit of the text or hashtags, or an approval, must leave a post its
   * platform accepts. Other edits (summary, a rejection) are not blocked by
   * an older post that is too long. With the final approver on, an approval
   * needs its "yes" for the text being approved, and new text gets a new
   * approver run (returned, to be stored with the edit).
   */
  private async checkEdit(ownerId: string, id: string, data: Prisma.ContentVariantUpdateManyMutationInput): Promise<AiApproval | undefined> {
    const body = typeof data.body === 'string' ? data.body : undefined;
    const hashtags = Array.isArray(data.hashtags) ? data.hashtags : undefined;
    const title = typeof data.title === 'string' || data.title === null ? data.title : undefined;
    const approving = data.status === VariantStatus.APPROVED;
    if (body === undefined && hashtags === undefined && title === undefined && !approving) return undefined;
    const variant = await this.prisma.contentVariant.findFirst({
      where: { id, content: { ownerId } },
      select: { title: true, body: true, hashtags: true, status: true, aiApproval: true, platform: { select: { slug: true } }, content: { select: { canonicalUrl: true } } },
    });
    // A missing or foreign variant is reported by the update itself.
    if (!variant) return undefined;
    const post = { title: title === undefined ? variant.title : title, body: body ?? variant.body, hashtags: hashtags ?? variant.hashtags };
    if (body !== undefined || hashtags !== undefined || approving) assertFitsPlatform(variant.platform.slug, post, variant.content.canonicalUrl);
    const enabled = this.approvals.enabled();
    if (approving) {
      const problem = aiApprovalProblem({ ...post, aiApproval: variant.aiApproval }, enabled);
      if (problem) throw new BadRequestException(problem);
    }
    // A rejected draft is not sent; restoring it and asking for approval is explicit.
    const rejected = (data.status ?? variant.status) === VariantStatus.REJECTED;
    return enabled && !rejected && approvalHash(post) !== approvalHash(variant) ? await this.approvals.runningApproval(post) : undefined;
  }

  /**
   * The post as its destination will show it, for the review preview. Unsaved
   * edits can be passed in; an account of the same platform picks its posting
   * route (for example the Chrome extension flow) when it has one.
   */
  async preview(ownerId: string, id: string, input: { title?: string; body?: string; hashtags?: string[]; platformAccountId?: string }) {
    const variant = await this.prisma.contentVariant.findFirstOrThrow({
      where: { id, content: { ownerId } },
      select: { title: true, body: true, hashtags: true, platformId: true, platform: { select: { slug: true } }, content: { select: { canonicalUrl: true } } },
    });
    let route: PreviewRoute | undefined;
    if (input.platformAccountId) {
      const account = await this.prisma.platformAccount.findFirst({
        where: { id: input.platformAccountId, ownerId, platformId: variant.platformId },
        select: { settings: true },
      });
      // An invalid extension route falls back to the platform default.
      if (account) route = previewRoute(account.settings);
    }
    return variantPreview({
      title: input.title ?? variant.title,
      body: input.body ?? variant.body,
      hashtags: input.hashtags ? this.normalizeHashtags(input.hashtags) : variant.hashtags,
    }, variant.platform.slug, undefined, variant.content.canonicalUrl, route);
  }

  private normalizeHashtags(values: string[]): string[] {
    const result: string[] = [];
    const seen = new Set<string>();
    for (const value of values) {
      const hashtag = value.trim().replace(/^#+/, '').trim();
      const key = hashtag.toLowerCase();
      if (!hashtag || seen.has(key)) continue;
      seen.add(key);
      result.push(hashtag);
    }
    return result;
  }
}
