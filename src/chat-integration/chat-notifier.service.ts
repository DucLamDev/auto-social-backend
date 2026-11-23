import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { AccountStatus, CampaignStatus, Prisma, PublishJobStatus } from '@prisma/client';
import { EXPIRY_WARNING_MS } from '../account-health/account-health.service';
import { PrismaService } from '../database/prisma.service';
import { RedisService } from '../queue/redis.service';
import { noticeMessage, pageLink, vnDateTime } from './chat-cards';
import { ChatConfigService } from './chat-config.service';
import { vnDate } from './chat-integration.constants';
import { ChatOutboxService } from './chat-outbox.service';

const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;
/** Connectors whose token the system renews itself (as in account-health). */
const AUTO_REFRESH_CONNECTORS = ['instagram', 'threads', 'blogger', 'tumblr'];
/** Posts parked for the Chrome extension are work in progress (as in account-health). */
const WAITING_FOR_EXTENSION = {
  status: PublishJobStatus.NEEDS_ACTION,
  lastErrorCode: null,
  platformAccount: { settings: { path: ['delivery'], equals: 'extension' } },
} satisfies Prisma.PublishJobWhereInput;
const TERMINAL_JOB_STATUSES: PublishJobStatus[] = [
  PublishJobStatus.PUBLISHED,
  PublishJobStatus.FAILED,
  PublishJobStatus.NEEDS_ACTION,
  PublishJobStatus.POSSIBLE_DUPLICATE,
  PublishJobStatus.CANCELLED,
];

const asJson = (value: unknown) => value as Prisma.InputJsonObject;

/**
 * Finds what chat should hear about by scanning state, like account-health:
 * level-1 notices (failed / needs-action posts, accounts to reconnect or about
 * to expire, finished campaigns) and the publish result of posts approved in
 * chat. Each fact has one outbox key, so a scan can run any number of times.
 */
@Injectable()
export class ChatNotifierService {
  private readonly logger = new Logger(ChatNotifierService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly chatConfig: ChatConfigService,
    private readonly outbox: ChatOutboxService,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE, { name: 'chat-notices-scan', waitForCompletion: true })
  async scanJob(): Promise<void> {
    let token: string | null = null;
    try {
      token = await this.redis.acquireLock('chat:notices:scan', 5 * 60_000);
      if (!token) return;
      await this.scan();
    } catch (error) {
      this.logger.error(`Chat notice scan failed: ${error instanceof Error ? error.message : 'unknown error'}`);
    } finally {
      if (token) await this.redis.releaseLock('chat:notices:scan', token).catch(() => undefined);
    }
  }

  /** Returns how many events were queued. Switched off: nothing is scanned. */
  async scan(now = new Date()): Promise<number> {
    if (!(await this.chatConfig.active())) return 0;
    const frontend = this.chatConfig.frontendUrl();
    const counts = await Promise.all([
      this.jobs(now, frontend),
      this.accounts(now, frontend),
      this.campaigns(now, frontend),
      this.results(),
    ]);
    return counts.reduce((total, count) => total + count, 0);
  }

  private async jobs(now: Date, frontend: string | null): Promise<number> {
    const jobs = await this.prisma.publishJob.findMany({
      where: { status: { in: [PublishJobStatus.FAILED, PublishJobStatus.NEEDS_ACTION] }, updatedAt: { gte: new Date(now.getTime() - HOUR_MS) }, NOT: WAITING_FOR_EXTENSION },
      select: {
        id: true, status: true, lastErrorCode: true, lastErrorMessage: true,
        platformAccount: { select: { name: true, platform: { select: { name: true } } } },
        target: { select: { campaign: { select: { name: true } } } },
      },
      orderBy: { updatedAt: 'asc' },
      take: 50,
    });
    let queued = 0;
    for (const job of jobs) {
      const failed = job.status === PublishJobStatus.FAILED;
      const message = noticeMessage({
        title: failed ? 'Đăng bài lỗi' : 'Bài cần thao tác',
        status: failed ? 'error' : 'warning',
        statusLabel: failed ? 'Lỗi' : 'Cần thao tác',
        summary: (job.lastErrorMessage ?? (failed ? 'Bài không đăng được.' : 'Bài cần người vận hành xử lý trước khi đăng tiếp.')).slice(0, 300),
        facts: [
          { label: 'Kênh', value: job.platformAccount.platform.name },
          { label: 'Tài khoản', value: job.platformAccount.name },
          { label: 'Chiến dịch', value: job.target.campaign.name },
          { label: 'Mã lỗi', value: job.lastErrorCode },
        ],
        link: pageLink(frontend, `/pending-posts/${job.id}`),
      });
      if (await this.outbox.record('NOTICE', `job:${job.id}:${job.status}`, asJson(message))) queued += 1;
    }
    return queued;
  }

  private async accounts(now: Date, frontend: string | null): Promise<number> {
    const soon = new Date(now.getTime() + EXPIRY_WARNING_MS);
    const [reconnect, expiring] = await Promise.all([
      this.prisma.platformAccount.findMany({
        where: { enabled: true, status: AccountStatus.RECONNECT_REQUIRED, updatedAt: { gte: new Date(now.getTime() - DAY_MS) } },
        select: { id: true, name: true, updatedAt: true, platform: { select: { name: true } } },
        take: 50,
      }),
      this.prisma.platformAccount.findMany({
        where: {
          enabled: true,
          status: AccountStatus.CONNECTED,
          platform: { connectorKey: { notIn: AUTO_REFRESH_CONNECTORS } },
          OR: [{ oauthToken: { expiresAt: { gt: now, lte: soon } } }, { credential: { expiresAt: { gt: now, lte: soon } } }],
        },
        select: { id: true, name: true, platform: { select: { name: true } }, oauthToken: { select: { expiresAt: true } }, credential: { select: { expiresAt: true } } },
        take: 50,
      }),
    ]);
    let queued = 0;
    for (const account of reconnect) {
      const message = noticeMessage({
        title: 'Tài khoản cần kết nối lại',
        status: 'error',
        statusLabel: 'Mất kết nối',
        summary: `Tài khoản ${account.name} không đăng được cho tới khi kết nối lại.`,
        facts: [{ label: 'Kênh', value: account.platform.name }, { label: 'Tài khoản', value: account.name }],
        link: pageLink(frontend, '/accounts'),
      });
      // Keyed by the day the account entered this state: one notice per incident.
      if (await this.outbox.record('NOTICE', `account:${account.id}:RECONNECT_REQUIRED:${vnDate(account.updatedAt)}`, asJson(message))) queued += 1;
    }
    for (const account of expiring) {
      const expiresAt = account.oauthToken?.expiresAt ?? account.credential?.expiresAt;
      if (!expiresAt) continue;
      const message = noticeMessage({
        title: 'Token sắp hết hạn',
        status: 'warning',
        statusLabel: 'Sắp hết hạn',
        summary: `Hệ thống không tự gia hạn được token của ${account.name}; kết nối lại trước khi hết hạn.`,
        facts: [{ label: 'Kênh', value: account.platform.name }, { label: 'Tài khoản', value: account.name }, { label: 'Hết hạn', value: vnDateTime(expiresAt) }],
        link: pageLink(frontend, '/accounts'),
      });
      if (await this.outbox.record('NOTICE', `account:${account.id}:EXPIRING:${vnDate(expiresAt)}`, asJson(message))) queued += 1;
    }
    return queued;
  }

  private async campaigns(now: Date, frontend: string | null): Promise<number> {
    const campaigns = await this.prisma.campaign.findMany({
      where: { status: { in: [CampaignStatus.COMPLETED, CampaignStatus.PARTIAL] }, updatedAt: { gte: new Date(now.getTime() - DAY_MS) } },
      select: { id: true, name: true, status: true },
      take: 50,
    });
    let queued = 0;
    for (const campaign of campaigns) {
      const [total, published] = await Promise.all([
        this.prisma.publishJob.count({ where: { target: { campaignId: campaign.id } } }),
        this.prisma.publishJob.count({ where: { target: { campaignId: campaign.id }, status: PublishJobStatus.PUBLISHED } }),
      ]);
      const done = campaign.status === CampaignStatus.COMPLETED;
      const message = noticeMessage({
        title: done ? 'Chiến dịch đã xong' : 'Chiến dịch xong một phần',
        status: done ? 'success' : 'warning',
        statusLabel: done ? 'Hoàn tất' : 'Một phần',
        summary: `Đăng được ${published}/${total} bài.`,
        facts: [{ label: 'Chiến dịch', value: campaign.name }, { label: 'Đã đăng', value: `${published}/${total}` }],
        link: pageLink(frontend, '/campaigns'),
      });
      if (await this.outbox.record('NOTICE', `campaign:${campaign.id}:done`, asJson(message))) queued += 1;
    }
    return queued;
  }

  /** Posts approved in chat whose publish jobs have all finished: report the outcome once. */
  private async results(): Promise<number> {
    const links = await this.prisma.chatApprovalLink.findMany({
      where: { status: 'APPROVED', approvalId: { not: null }, resultRecordedAt: null },
      select: { id: true, campaignId: true, variantId: true, approvalId: true },
      orderBy: { updatedAt: 'asc' },
      take: 50,
    });
    let queued = 0;
    for (const link of links) {
      const jobs = await this.prisma.publishJob.findMany({
        where: { target: { campaignId: link.campaignId, contentVariantId: link.variantId } },
        select: { status: true, lastErrorMessage: true, publishedPost: { select: { url: true } }, platformAccount: { select: { name: true } } },
      });
      if (!jobs.length || !jobs.every((job) => TERMINAL_JOB_STATUSES.includes(job.status))) continue;
      const published = jobs.filter((job) => job.status === PublishJobStatus.PUBLISHED);
      const urls = published.map((job) => job.publishedPost?.url).filter((url): url is string => Boolean(url)).slice(0, 10);
      const firstError = jobs.find((job) => job.status !== PublishJobStatus.PUBLISHED);
      const payload = published.length
        ? { approvalId: link.approvalId, status: 'executed', result: { published: published.length, total: jobs.length, urls } }
        : { approvalId: link.approvalId, status: 'failed', result: { published: 0, total: jobs.length }, error: `Chưa đăng được (${firstError?.platformAccount.name ?? 'tài khoản'}): ${firstError?.lastErrorMessage ?? firstError?.status ?? 'lỗi không rõ'}`.slice(0, 500) };
      await this.prisma.$transaction(async (tx) => {
        const claimed = await tx.chatApprovalLink.updateMany({ where: { id: link.id, resultRecordedAt: null }, data: { resultRecordedAt: new Date() } });
        if (claimed.count && await this.outbox.record('APPROVAL_RESULT', `result:${link.approvalId}`, asJson(payload), tx)) queued += 1;
      });
    }
    return queued;
  }
}
