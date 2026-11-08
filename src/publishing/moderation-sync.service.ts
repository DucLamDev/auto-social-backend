import { Injectable, Logger } from '@nestjs/common';
import { PublishJobStatus } from '@prisma/client';
import { CampaignStatusService } from '../campaigns/campaign-status.service';
import { extensionFlowForPlatform } from '../connectors/extension/extension-flows';
import { SsrfSafeHttpService } from '../crawler/ssrf-safe-http.service';
import { PrismaService } from '../database/prisma.service';
import { sessionOf } from '../extension-agent/extension-account-session.service';
import { PublishJobsService } from './publish-jobs.service';
import { SUBMITTED_EXTENSION_CODES } from './publishing.constants';

/** Posts older than this are no longer looked for (a moderator who never answers). */
const SYNC_WINDOW_MS = 30 * 24 * 3_600_000;
/** Posts checked per run; the oldest checks go first. */
const BATCH = 40;
const JSON_TYPES = ['application/json', 'application/vnd.api+json'];

export interface FoundPost { externalPostId: string; url: string }
export interface ModerationSyncResult { checked: number; published: number; notFound: number; unsupported: number; failed: number }
type GetText = (url: string, types?: string[]) => Promise<{ body: string; finalUrl: string }>;

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

/** Titles as the platform may show them: case, punctuation and spacing ignored. */
export function sameTitle(a: string, b: string): boolean {
  const norm = (value: string) => value.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const x = norm(a), y = norm(b);
  if (!x || !y) return false;
  if (x === y) return true;
  // Forums may cut a long title: a long shared beginning counts.
  const [shorter, longer] = x.length < y.length ? [x, y] : [y, x];
  return shorter.length >= 30 && longer.startsWith(shorter);
}

const after = (value: unknown, since: Date) => typeof value !== 'string' || !(Date.parse(value) < since.getTime());

/** Discourse lists the topics a user created; a topic waiting for approval is not listed yet. */
export async function findDiscourseTopic(get: GetText, base: string, username: string, title: string, since: Date): Promise<FoundPost | null> {
  const { body } = await get(`${base}/topics/created-by/${encodeURIComponent(username)}.json`, JSON_TYPES);
  for (const topic of list(record(record(JSON.parse(body)).topic_list).topics).map(record)) {
    if (typeof topic.title === 'string' && sameTitle(topic.title, title) && after(topic.created_at, since) && Number.isInteger(topic.id)) {
      const slug = typeof topic.slug === 'string' && /^[\w-]+$/.test(topic.slug) ? topic.slug : 'topic';
      return { externalPostId: String(topic.id), url: `${base}/t/${slug}/${String(topic.id)}` };
    }
  }
  return null;
}

/** Vanilla's API v2 lists a user's discussions; held ones are not listed until approved. */
export async function findVanillaDiscussion(get: GetText, base: string, username: string, title: string, since: Date): Promise<FoundPost | null> {
  const users = list(JSON.parse((await get(`${base}/api/v2/users/by-names?name=${encodeURIComponent(username)}`, JSON_TYPES)).body)).map(record);
  const user = users.find((item) => typeof item.name === 'string' && item.name.toLowerCase() === username.toLowerCase());
  if (!user || !Number.isInteger(user.userID)) return null;
  const { body } = await get(`${base}/api/v2/discussions?insertUserID=${String(user.userID)}&limit=30&sort=-dateInserted`, JSON_TYPES);
  for (const discussion of list(JSON.parse(body)).map(record)) {
    if (typeof discussion.name === 'string' && sameTitle(discussion.name, title) && after(discussion.dateInserted, since) && Number.isInteger(discussion.discussionID)) {
      const url = typeof discussion.url === 'string' && discussion.url.startsWith(`${base}/`) ? discussion.url : `${base}/discussion/${String(discussion.discussionID)}`;
      return { externalPostId: String(discussion.discussionID), url };
    }
  }
  return null;
}

/** Flarum's JSON:API filters discussions by author; unapproved ones are hidden from guests. */
export async function findFlarumDiscussion(get: GetText, base: string, username: string, title: string, since: Date): Promise<FoundPost | null> {
  const { body } = await get(`${base}/api/discussions?filter[author]=${encodeURIComponent(username)}&sort=-createdAt&page[limit]=30`, JSON_TYPES);
  for (const item of list(record(JSON.parse(body)).data).map(record)) {
    const attributes = record(item.attributes);
    if (typeof attributes.title === 'string' && sameTitle(attributes.title, title) && after(attributes.createdAt, since) && typeof item.id === 'string' && /^\d+$/.test(item.id)) {
      const slug = typeof attributes.slug === 'string' && /^[\w-]+$/.test(attributes.slug) ? attributes.slug : item.id;
      return { externalPostId: item.id, url: `${base}/d/${slug.startsWith(`${item.id}-`) || slug === item.id ? slug : `${item.id}-${slug}`}` };
    }
  }
  return null;
}

/** A link the platform already gave: a guest sees the post once it is approved. */
export async function checkKnownUrl(get: GetText, url: string, title: string): Promise<FoundPost | null> {
  const { body, finalUrl } = await get(url, ['text/html']);
  const words = (value: string) => value.normalize('NFKC').toLowerCase().replace(/<[^>]+>/g, ' ').replace(/[^\p{L}\p{N}]+/gu, ' ');
  return words(body).includes(words(title).trim()) ? { externalPostId: finalUrl, url: finalUrl } : null;
}

const LOOKUPS: Partial<Record<string, typeof findDiscourseTopic>> = { discourse: findDiscourseTopic, vanilla: findVanillaDiscussion, flarum: findFlarumDiscussion };

/**
 * Posts the platform received but did not show yet (held for its moderators, or sent
 * without a confirmation) are looked up on the platform's public pages, as a guest,
 * every few minutes. Found: the job becomes published with its real link. Not found:
 * the time and outcome of the check are kept on the job so the operator sees it ran.
 */
@Injectable()
export class ModerationSyncService {
  private readonly logger = new Logger(ModerationSyncService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly http: SsrfSafeHttpService,
    private readonly jobs: PublishJobsService,
    private readonly campaignStatus: CampaignStatusService,
  ) {}

  async syncPending(ownerId?: string): Promise<ModerationSyncResult> {
    const result: ModerationSyncResult = { checked: 0, published: 0, notFound: 0, unsupported: 0, failed: 0 };
    const pending = await this.prisma.publishJob.findMany({
      where: {
        status: PublishJobStatus.NEEDS_ACTION,
        updatedAt: { gte: new Date(Date.now() - SYNC_WINDOW_MS) },
        ...(ownerId ? { target: { campaign: { ownerId } } } : {}),
        OR: [
          { lastErrorCode: { in: SUBMITTED_EXTENSION_CODES } },
          { attempts: { some: { responseMetadata: { path: ['moderationQueue'], equals: true } } } },
        ],
      },
      orderBy: { updatedAt: 'asc' },
      take: BATCH,
      select: {
        id: true, createdAt: true, platformAccountId: true,
        target: { select: { campaignId: true, contentVariant: { select: { title: true } } } },
        platformAccount: { select: { settings: true, platform: { select: { slug: true } } } },
        attempts: { orderBy: { attemptNumber: 'desc' }, take: 1, select: { id: true, startedAt: true, responseMetadata: true } },
      },
    });
    const get: GetText = (url, types) => this.http.getText(url, types);
    for (const job of pending) {
      result.checked += 1;
      const attempt = job.attempts[0];
      const metadata = record(attempt?.responseMetadata);
      const title = job.target.contentVariant.title ?? '';
      const since = new Date((attempt?.startedAt ?? job.createdAt).getTime() - 3_600_000);
      let outcome: 'found' | 'not-found' | 'unsupported' | 'failed' = 'unsupported';
      try {
        let found: FoundPost | null = null;
        const settings = record(job.platformAccount.settings);
        const engine = typeof settings.extensionEngine === 'string' ? settings.extensionEngine : '';
        const lookup = LOOKUPS[engine];
        const username = sessionOf(settings)?.expectedUsername?.trim();
        const base = forumBase(job.platformAccount.platform.slug, settings);
        if (typeof metadata.url === 'string' && /^https:\/\//.test(metadata.url)) {
          outcome = 'not-found';
          found = await checkKnownUrl(get, metadata.url, title).catch(() => null);
        }
        if (!found && lookup && username && base && title.trim()) {
          outcome = 'not-found';
          found = await lookup(get, base, username, title, since);
        }
        if (found) {
          await this.jobs.confirmPublished(job.id, { ...found, platformAccountId: job.platformAccountId, source: 'sync' });
          await this.campaignStatus.refresh(job.target.campaignId);
          outcome = 'found';
        }
      } catch (error) {
        outcome = 'failed';
        this.logger.warn(`Moderation sync of job ${job.id} failed: ${error instanceof Error ? error.message : 'unknown error'}`);
      }
      if (outcome === 'found') { result.published += 1; continue; }
      if (outcome === 'not-found') result.notFound += 1;
      else if (outcome === 'unsupported') result.unsupported += 1;
      else result.failed += 1;
      // Keep when it was checked and what came out, for the operator (never blocks the run).
      if (attempt) {
        await this.prisma.publishAttempt.update({
          where: { id: attempt.id },
          data: { responseMetadata: { ...metadata, moderationCheck: { at: new Date().toISOString(), outcome } } },
        }).catch(() => undefined);
      }
    }
    return result;
  }
}

/** The forum the account posts to: the flow's forum (sub-folder installs included) or the target's origin. */
function forumBase(slug: string, settings: Record<string, unknown>): string | null {
  const configured = typeof settings.extensionForumUrl === 'string' ? settings.extensionForumUrl : extensionFlowForPlatform(slug)?.forumUrl;
  const target = typeof settings.extensionTargetUrl === 'string' ? settings.extensionTargetUrl : undefined;
  try {
    const url = new URL(configured ?? target ?? '');
    if (url.protocol !== 'https:') return null;
    // Only the forum root: a target page such as /new-topic or /post/discussion/<x> is not the base.
    return configured ? `${url.origin}${url.pathname.replace(/\/$/, '')}` : url.origin;
  } catch {
    return null;
  }
}
