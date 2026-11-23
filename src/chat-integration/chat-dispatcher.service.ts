import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Prisma, VariantStatus } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../database/prisma.service';
import { RedisService } from '../queue/redis.service';
import { ChatApiClient, ChatCallResult, ChatTarget, ChatTransportError } from './chat-api.client';
import { noticeMessage, pageLink, plainText, vnDateTime } from './chat-cards';
import { ApprovalSnapshot, loadApprovalSnapshot, snapshotHash } from './chat-snapshot';
import { ChatConfigService } from './chat-config.service';
import {
  APPROVAL_ACTION,
  APPROVAL_EXPIRES_MINUTES,
  APPROVAL_RESOURCE_TYPE,
  CANCEL_REASON,
  MAX_ATTEMPTS,
  OUTBOX_FAILED,
  OUTBOX_PENDING,
  OUTBOX_SENT,
  OUTBOX_SKIPPED,
  RETRY_DELAYS_MS,
  vnDate,
} from './chat-integration.constants';
import { ChatOutboxService } from './chat-outbox.service';

const REVIEWABLE_STATES = ['WAITING_REVIEW', 'PROCESSING'];
const BATCH = 25;
/** One round stops starting new calls after this; the Redis lock (5 min) always outlives a round. */
const ROUND_BUDGET_MS = 2 * 60_000;
/** A claimed event is not picked up by another sender for this long (crash safety). */
const LEASE_MS = 3 * 60_000;
const LOCK_KEY = 'chat:outbox:dispatch';
const LOCK_TTL_MS = 5 * 60_000;

type ActiveConfig = ChatTarget & { channelId: string };
type OutboxRow = { id: string; kind: string; payload: Prisma.JsonValue; attempts: number };

export type Outcome =
  | { kind: 'sent' }
  | { kind: 'skipped'; note: string; contacted: boolean }
  | { kind: 'retry'; error: string; retryAfterMs?: number | null; rateLimited?: boolean }
  | { kind: 'failed'; error: string };

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const str = (value: unknown): string | null => (typeof value === 'string' && value ? value : null);

/** HTTP status → what to do with the event, for every call. */
export function outcomeOf(result: ChatCallResult): Outcome {
  if (result.ok) return { kind: 'sent' };
  const detail = `HTTP ${result.status}${result.errorCode ? ` ${result.errorCode}` : ''}${result.errorMessage ? `: ${result.errorMessage}` : ''}`;
  if (result.status === 429) return { kind: 'retry', error: `Chat báo gửi quá nhanh (${detail}).`, retryAfterMs: result.retryAfterMs, rateLimited: true };
  if (result.status >= 500 || result.status === 408) return { kind: 'retry', error: `Chat đang lỗi (${detail}).` };
  // A wrong key or scope can be fixed in the settings while the retries run.
  if (result.status === 401 || result.status === 403) return { kind: 'retry', error: `Chat từ chối khoá bot (${detail}). Kiểm tra khoá và scope.` };
  return { kind: 'failed', error: `Chat từ chối yêu cầu (${detail}).` };
}

/**
 * Sends the outbox to chat. One process at a time (Redis lock), oldest first,
 * retries 30 s / 2 min / 10 min / 1 h and gives up after 6 attempts; a 429
 * waits for Retry-After and pauses the rest of the batch.
 */
@Injectable()
export class ChatDispatcherService {
  private readonly logger = new Logger(ChatDispatcherService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly chatConfig: ChatConfigService,
    private readonly outbox: ChatOutboxService,
    private readonly api: ChatApiClient,
  ) {}

  @Cron(CronExpression.EVERY_10_SECONDS, { name: 'chat-outbox-dispatch', waitForCompletion: true })
  async dispatchJob(): Promise<void> {
    let token: string | null = null;
    try {
      token = await this.redis.acquireLock(LOCK_KEY, LOCK_TTL_MS);
      if (!token) return;
      const held = token;
      await this.dispatch(new Date(), () => this.redis.extendLock(LOCK_KEY, held, LOCK_TTL_MS));
    } catch (error) {
      this.logger.error(`Chat outbox dispatch failed: ${error instanceof Error ? error.message : 'unknown error'}`);
    } finally {
      if (token) await this.redis.releaseLock(LOCK_KEY, token).catch(() => undefined);
    }
  }

  async dispatch(now = new Date(), keepLock: () => Promise<boolean> = () => Promise.resolve(true)): Promise<number> {
    const config = await this.chatConfig.active();
    if (!config) {
      // Switched off: nothing is sent; what was waiting is kept as skipped.
      await this.prisma.chatOutboxEvent.updateMany({ where: { status: OUTBOX_PENDING, kind: { not: 'TEST' } }, data: { status: OUTBOX_SKIPPED, lastError: 'Kết nối chat đang tắt.' } });
      await this.prisma.chatApprovalLink.updateMany({ where: { status: 'QUEUED' }, data: { status: 'SKIPPED' } });
      return 0;
    }
    const events = await this.prisma.chatOutboxEvent.findMany({
      where: { status: OUTBOX_PENDING, nextAttemptAt: { lte: now } },
      orderBy: { createdAt: 'asc' },
      take: BATCH,
      select: { id: true, kind: true, payload: true, attempts: true },
    });
    let sent = 0;
    const started = Date.now();
    for (const event of events) {
      if (Date.now() - started > ROUND_BUDGET_MS || !(await keepLock())) break;
      // Claim with a lease: even a second sender (lost lock) cannot post the same event twice.
      const claimed = await this.prisma.chatOutboxEvent.updateMany({
        where: { id: event.id, status: OUTBOX_PENDING, nextAttemptAt: { lte: now } },
        data: { nextAttemptAt: new Date(Date.now() + LEASE_MS) },
      });
      if (!claimed.count) continue;
      const outcome = await this.attempt(event, config);
      await this.settle(event, outcome, new Date());
      if (outcome.kind === 'sent') sent += 1;
      if (outcome.kind === 'retry' && outcome.rateLimited) break;
    }
    return sent;
  }

  /** Sends one message to the channel now (the "Gửi tin thử" button), recorded like any other event. */
  async sendTest(actorName: string): Promise<{ ok: boolean; error: string | null }> {
    const config = await this.chatConfig.read();
    const { baseUrl, botToken, channelId } = config.config;
    if (!baseUrl || !botToken || !channelId) return { ok: false, error: 'Cần lưu địa chỉ chat, khoá bot và mã kênh trước khi gửi tin thử.' };
    const message = noticeMessage({
      title: 'Tin thử từ auto-social',
      status: 'info',
      statusLabel: 'Tin thử',
      summary: `Kết nối chat hoạt động. Người gửi: ${actorName}.`,
      facts: [{ label: 'Thời gian', value: vnDateTime(new Date()) }],
      link: pageLink(this.chatConfig.frontendUrl(), '/settings'),
    });
    // Sent right here; the far nextAttemptAt keeps the background sender off this row.
    const row = await this.prisma.chatOutboxEvent.create({
      data: { kind: 'TEST', dedupeKey: `test:${randomUUID()}`, payload: message as unknown as Prisma.InputJsonObject, nextAttemptAt: new Date(Date.now() + 24 * 3_600_000) },
    });
    const outcome = await this.attempt(row, { baseUrl, botToken, channelId });
    // A test is never retried in the background.
    const final: Outcome = outcome.kind === 'retry' ? { kind: 'failed', error: outcome.error } : outcome;
    await this.settle(row, final, new Date());
    return final.kind === 'sent' ? { ok: true, error: null } : { ok: false, error: final.kind === 'failed' ? final.error : final.note };
  }

  private async attempt(event: OutboxRow, config: ActiveConfig): Promise<Outcome> {
    try {
      switch (event.kind) {
        case 'APPROVAL_CREATE': return await this.createApproval(object(event.payload), config);
        case 'APPROVAL_CANCEL': return await this.cancelApproval(object(event.payload), config);
        case 'APPROVAL_RESULT': return await this.reportResult(object(event.payload), config);
        case 'NOTICE':
        case 'TEST': {
          const payload = object(event.payload);
          return outcomeOf(await this.api.postMessage(config, config.channelId, { body: payload.body, metadata: payload.metadata }));
        }
        default: return { kind: 'failed', error: `Loại việc không biết: ${event.kind}` };
      }
    } catch (error) {
      if (error instanceof ChatTransportError) return error.retryable ? { kind: 'retry', error: error.message } : { kind: 'failed', error: error.message };
      this.logger.warn(`Chat outbox ${event.kind} ${event.id} failed: ${error instanceof Error ? error.message : 'unknown error'}`);
      return { kind: 'retry', error: 'Lỗi nội bộ khi chuẩn bị tin gửi chat.' };
    }
  }

  private async settle(event: OutboxRow, outcome: Outcome, now: Date): Promise<void> {
    const where = { id: event.id, status: OUTBOX_PENDING };
    if (outcome.kind === 'sent') {
      await this.prisma.chatOutboxEvent.updateMany({ where, data: { status: OUTBOX_SENT, sentAt: now, lastAttemptAt: now, attempts: event.attempts + 1, lastError: null } });
    } else if (outcome.kind === 'skipped') {
      await this.prisma.chatOutboxEvent.updateMany({ where, data: { status: OUTBOX_SKIPPED, lastError: outcome.note, ...(outcome.contacted ? { sentAt: now, lastAttemptAt: now, attempts: event.attempts + 1 } : {}) } });
    } else if (outcome.kind === 'failed') {
      await this.prisma.chatOutboxEvent.updateMany({ where, data: { status: OUTBOX_FAILED, lastAttemptAt: now, attempts: event.attempts + 1, lastError: outcome.error.slice(0, 1000) } });
    } else {
      // Rate limiting is not a failure of this event and does not use up an attempt.
      const attempts = outcome.rateLimited ? event.attempts : event.attempts + 1;
      const giveUp = attempts >= MAX_ATTEMPTS;
      const delay = Math.max(RETRY_DELAYS_MS[Math.min(Math.max(attempts - 1, 0), RETRY_DELAYS_MS.length - 1)]!, outcome.retryAfterMs ?? 0);
      await this.prisma.chatOutboxEvent.updateMany({
        where,
        data: {
          status: giveUp ? OUTBOX_FAILED : OUTBOX_PENDING,
          attempts,
          lastAttemptAt: now,
          lastError: (giveUp ? `Đã thử ${attempts} lần, dừng. ${outcome.error}` : outcome.error).slice(0, 1000),
          nextAttemptAt: new Date(now.getTime() + (outcome.rateLimited ? outcome.retryAfterMs ?? 60_000 : delay)),
        },
      });
    }
  }

  private async createApproval(payload: Record<string, unknown>, config: ActiveConfig): Promise<Outcome> {
    const linkId = str(payload.linkId);
    let link = linkId ? await this.prisma.chatApprovalLink.findUnique({ where: { id: linkId } }) : null;
    if (!link || link.status !== 'QUEUED') return { kind: 'skipped', note: 'Bài không còn chờ duyệt.', contacted: false };
    const draft = await this.waitingDraft(link.campaignId, link.variantId);
    if (!draft) {
      await this.prisma.chatApprovalLink.updateMany({ where: { id: link.id, status: 'QUEUED' }, data: { status: 'CANCELLED' } });
      return { kind: 'skipped', note: 'Bài đã được xử lý trước khi gửi.', contacted: false };
    }
    if (!link.requestBody || !link.contentHash) {
      // Fixed once, before the first call: every retry sends exactly what was hashed.
      const snapshot = await loadApprovalSnapshot(this.prisma, link.campaignId, link.variantId);
      if (!snapshot) return { kind: 'skipped', note: 'Bài không còn ở auto-social.', contacted: false };
      const body = this.approvalBody(draft, snapshot, link.cycle, link.externalKey);
      await this.prisma.chatApprovalLink.updateMany({
        where: { id: link.id, status: 'QUEUED', requestBody: { equals: Prisma.DbNull } },
        data: { requestBody: body, contentHash: snapshotHash(snapshot) },
      });
      link = await this.prisma.chatApprovalLink.findUnique({ where: { id: link.id } });
      if (!link?.requestBody || !link.contentHash || link.status !== 'QUEUED') return { kind: 'skipped', note: 'Bài không còn chờ duyệt.', contacted: false };
    }
    const body = object(link.requestBody);
    const ownerEmail = str((object(body.approver_rule).values as unknown[] | undefined)?.[0]) ?? '';
    const result = await this.api.createApproval(config, body);
    if (result.status === 422 && result.errorCode === 'APPROVER_NOT_FOUND') {
      await this.prisma.chatApprovalLink.updateMany({ where: { id: link.id, status: 'QUEUED' }, data: { status: 'UNMATCHED' } });
      await this.outbox.record('NOTICE', `unmatched:${ownerEmail}:${vnDate(new Date())}`, this.unmatchedNotice(ownerEmail) as unknown as Prisma.InputJsonObject);
      return { kind: 'failed', error: `Email chủ chiến dịch chưa có trong workspace chat (${ownerEmail}).` };
    }
    if (!result.ok) return outcomeOf(result);
    const approval = object(result.data?.approval);
    const approvalId = str(approval.id);
    if (!approvalId) return { kind: 'failed', error: 'Chat trả về thiếu mã yêu cầu duyệt.' };
    if (result.status === 200 && str(object(approval.display).text) !== str(object(body.display).text)) {
      // Chat returned an older request under this key showing another text: close it, ask again.
      await this.prisma.chatApprovalLink.update({ where: { id: link.id }, data: { approvalId, status: 'FAILED' } });
      await this.outbox.record('APPROVAL_CANCEL', `cancel:${approvalId}`, { approvalId });
      await this.outbox.reviewReady(link.campaignId, [link.variantId]);
      return { kind: 'skipped', note: 'Chat trả yêu cầu cũ với nội dung khác; đã huỷ và gửi lượt mới.', contacted: true };
    }
    const opened = await this.prisma.chatApprovalLink.updateMany({ where: { id: link.id, status: 'QUEUED' }, data: { approvalId, status: 'PENDING' } });
    if (!opened.count) {
      const current = await this.prisma.chatApprovalLink.findUnique({ where: { id: link.id }, select: { status: true, approvalId: true } });
      // Decided on the web while the request was on its way: close it in chat too.
      // (A webhook that arrived first has already claimed the link with this id.)
      if (current && !current.approvalId) {
        await this.prisma.chatApprovalLink.update({ where: { id: link.id }, data: { approvalId } });
        await this.outbox.record('APPROVAL_CANCEL', `cancel:${approvalId}`, { approvalId });
      }
    } else if (!(await this.waitingDraft(link.campaignId, link.variantId))) {
      await this.outbox.reviewClosed(link.campaignId, [link.variantId]);
    }
    return { kind: 'sent' };
  }

  private async cancelApproval(payload: Record<string, unknown>, config: ActiveConfig): Promise<Outcome> {
    const approvalId = str(payload.approvalId);
    if (!approvalId) return { kind: 'failed', error: 'Thiếu mã yêu cầu duyệt.' };
    const result = await this.api.cancelApproval(config, approvalId, CANCEL_REASON);
    if (result.status === 409 || result.status === 404) {
      // APPROVAL_NOT_PENDING (already finished) or not found: nothing left to cancel.
      this.logger.log(`Chat approval ${approvalId} was already closed (HTTP ${result.status}${result.errorCode ? ` ${result.errorCode}` : ''})`);
      return { kind: 'skipped', note: 'Yêu cầu bên chat đã đóng.', contacted: true };
    }
    return outcomeOf(result);
  }

  private async reportResult(payload: Record<string, unknown>, config: ActiveConfig): Promise<Outcome> {
    const approvalId = str(payload.approvalId);
    if (!approvalId) return { kind: 'failed', error: 'Thiếu mã yêu cầu duyệt.' };
    const status = payload.status === 'executed' ? 'executed' : 'failed';
    // Contract A5b: the chat card shows "Đã đăng" or "Đăng lỗi: <error>".
    const body = status === 'executed'
      ? { status, label: 'Đã đăng', result: object(payload.result) }
      : { status, label: 'Đăng lỗi', error: (str(payload.error) ?? 'Không đăng được bài.').slice(0, 500), result: object(payload.result) };
    const result = await this.api.reportResult(config, approvalId, body);
    if (result.status === 409 || result.status === 404) return { kind: 'skipped', note: 'Chat không nhận kết quả (đã báo hoặc yêu cầu không còn duyệt).', contacted: true };
    return outcomeOf(result);
  }

  /** The campaign and draft behind a link while the draft still waits for review. */
  private async waitingDraft(campaignId: string, variantId: string) {
    const campaign = await this.prisma.campaign.findFirst({
      where: { id: campaignId, automationState: { in: REVIEWABLE_STATES } },
      select: { id: true, name: true, automationVariantIds: true, owner: { select: { email: true } } },
    });
    if (!campaign || !campaign.automationVariantIds.includes(variantId)) return null;
    const variant = await this.prisma.contentVariant.findFirst({
      where: { id: variantId, status: { in: [VariantStatus.GENERATED, VariantStatus.APPROVED] }, targets: { none: {} } },
      select: { id: true, aiApproval: true, platform: { select: { name: true } } },
    });
    if (!variant) return null;
    return { campaign, variant, ownerEmail: campaign.owner.email.trim().toLowerCase() };
  }

  private approvalBody(draft: NonNullable<Awaited<ReturnType<ChatDispatcherService['waitingDraft']>>>, snapshot: ApprovalSnapshot, cycle: number, externalKey: string) {
    const { campaign, variant } = draft;
    const scheduledAt = snapshot.scheduledAt ? new Date(snapshot.scheduledAt) : null;
    const scheduled = scheduledAt && scheduledAt.getTime() > Date.now() ? vnDateTime(scheduledAt) : 'Ngay khi duyệt';
    const verdict = str(object(variant.aiApproval).status);
    const text = plainText([snapshot.title, snapshot.body, snapshot.hashtags.map((tag) => (tag.startsWith('#') ? tag : `#${tag}`)).join(' ')].filter(Boolean).join('\n\n'), 4000);
    const link = pageLink(this.chatConfig.frontendUrl(), `/ai-content?campaign=${campaign.id}`);
    const fields = [
      { label: 'Kênh', value: variant.platform.name },
      { label: 'Tài khoản', value: snapshot.accountNames.join(', ') },
      { label: 'Giờ đăng', value: scheduled },
      { label: 'AI duyệt', value: verdict === 'approved' ? 'Đạt' : verdict === 'rejected' ? 'Chưa đạt' : '' },
      { label: 'Chiến dịch', value: campaign.name },
    ].filter((field) => field.value).map((field) => ({ label: field.label, value: field.value.length > 200 ? `${field.value.slice(0, 199)}…` : field.value }));
    return {
      title: `Duyệt bài ${variant.platform.name} · ${campaign.name}`.slice(0, 200),
      action: APPROVAL_ACTION,
      resource_type: APPROVAL_RESOURCE_TYPE,
      resource_id: variant.id,
      payload: { campaign_id: campaign.id, variant_id: variant.id, cycle },
      channel_id: null,
      required_approvals: 1,
      approver_rule: { type: 'emails', values: [draft.ownerEmail] },
      expires_in_minutes: APPROVAL_EXPIRES_MINUTES,
      external_key: externalKey,
      display: {
        text: text || '(Bài không có chữ)',
        ...(snapshot.imageUrl ? { image_url: snapshot.imageUrl } : {}),
        fields,
        ...(link ? { link } : {}),
      },
    };
  }

  private unmatchedNotice(email: string) {
    return noticeMessage({
      title: 'Chưa khớp tài khoản chat',
      status: 'warning',
      statusLabel: 'Cần xử lý',
      summary: 'Không gửi được yêu cầu duyệt vì email chủ chiến dịch chưa là thành viên đang hoạt động của workspace chat.',
      facts: [{ label: 'Email', value: email }],
      link: pageLink(this.chatConfig.frontendUrl(), '/ai-content', 'Duyệt trên auto-social'),
    });
  }
}
