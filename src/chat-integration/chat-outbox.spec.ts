import { VariantStatus } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { RedisService } from '../queue/redis.service';
import { ChatApiClient, ChatCallResult } from './chat-api.client';
import { ChatConfigService } from './chat-config.service';
import { ChatDispatcherService } from './chat-dispatcher.service';
import { ChatOutboxService } from './chat-outbox.service';

/** Minimal in-memory outbox + links, enough for the unique keys to bite. */
function store(enabled = true) {
  const events: Array<Record<string, unknown>> = [];
  const links: Array<Record<string, unknown>> = [];
  const prisma = {
    systemSetting: { count: jest.fn().mockResolvedValue(1) },
    campaign: { findFirst: jest.fn().mockResolvedValue({ automationVariantIds: ['variant-1'] }) },
    contentVariant: { findMany: jest.fn().mockResolvedValue([{ id: 'variant-1', mediaRecommendation: null, aiRevision: null, status: VariantStatus.GENERATED }]) },
    chatOutboxEvent: {
      createMany: jest.fn(({ data: [row] }: { data: Array<Record<string, unknown>> }) => {
        if (events.some((event) => event.dedupeKey === row!.dedupeKey)) return { count: 0 };
        events.push({ id: `event-${events.length + 1}`, attempts: 0, ...row });
        return { count: 1 };
      }),
      findMany: jest.fn(() => events.filter((event) => event.status === 'PENDING')),
      updateMany: jest.fn(({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        const hit = events.filter((event) => (!where.id || event.id === where.id) && event.status === where.status);
        hit.forEach((event) => Object.assign(event, data));
        return { count: hit.length };
      }),
    },
    chatApprovalLink: {
      findFirst: jest.fn(({ where }: { where: { variantId: string } }) => links.filter((link) => link.variantId === where.variantId).at(-1) ?? null),
      create: jest.fn(({ data }: { data: Record<string, unknown> }) => {
        if (links.some((link) => link.externalKey === data.externalKey)) throw new Error('duplicate');
        const link = { id: `link-${links.length + 1}`, ...data };
        links.push(link);
        return link;
      }),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    $transaction: jest.fn(),
  };
  prisma.$transaction.mockImplementation((fn: (tx: typeof prisma) => unknown) => fn(prisma));
  const config = { enabled, baseUrl: 'https://chat.example.com', botToken: 'wtb_test_token', channelId: '11111111-1111-4111-8111-111111111111' };
  const chatConfig = {
    read: jest.fn().mockResolvedValue({ config }),
    active: jest.fn().mockResolvedValue(enabled ? config : null),
    frontendUrl: () => 'https://social.example.com',
  };
  const outbox = new ChatOutboxService(prisma as unknown as PrismaService, chatConfig as unknown as ChatConfigService);
  const api = { postMessage: jest.fn<Promise<ChatCallResult>, unknown[]>() };
  const redis = { acquireLock: jest.fn().mockResolvedValue('lock'), releaseLock: jest.fn().mockResolvedValue(true) };
  const dispatcher = new ChatDispatcherService(prisma as unknown as PrismaService, redis as unknown as RedisService, chatConfig as unknown as ChatConfigService, outbox, api as unknown as ChatApiClient);
  return { events, links, outbox, dispatcher, api };
}

const reply = (status: number, retryAfterMs: number | null = null): ChatCallResult => ({
  status, ok: status < 300, data: {}, errorCode: status === 429 ? 'RATE_LIMITED' : null, errorMessage: null, errorDetails: null, retryAfterMs,
});

describe('Chat outbox', () => {
  it('records one approval request per review round, and nothing twice', async () => {
    const { outbox, events, links } = store();
    await outbox.reviewReady('campaign-1', ['variant-1']);
    await outbox.reviewReady('campaign-1', ['variant-1']);
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ cycle: 1, externalKey: 'variant:variant-1:c1', status: 'QUEUED' });
    expect(events).toEqual([expect.objectContaining({ kind: 'APPROVAL_CREATE', dedupeKey: 'variant:variant-1:c1', status: 'PENDING' })]);
    await expect(outbox.record('NOTICE', 'job:1:FAILED', {})).resolves.toBe(true);
    await expect(outbox.record('NOTICE', 'job:1:FAILED', {})).resolves.toBe(false);
  });

  it('switched off: keeps the record as skipped and sends nothing', async () => {
    const { outbox, dispatcher, events, links, api } = store(false);
    await outbox.reviewReady('campaign-1', ['variant-1']);
    await outbox.record('NOTICE', 'job:1:FAILED', { body: 'x' });
    expect(links[0]).toMatchObject({ status: 'SKIPPED' });
    expect(events.every((event) => event.status === 'SKIPPED')).toBe(true);
    await dispatcher.dispatch();
    expect(api.postMessage).not.toHaveBeenCalled();
  });

  it('retries a chat error with back-off, follows Retry-After on 429 and stops after 6 attempts', async () => {
    const { outbox, dispatcher, events, api } = store();
    await outbox.record('NOTICE', 'job:1:FAILED', { body: 'a' });
    await outbox.record('NOTICE', 'job:2:FAILED', { body: 'b' });
    const now = new Date();
    api.postMessage.mockResolvedValueOnce(reply(503));
    api.postMessage.mockResolvedValueOnce(reply(200));
    await dispatcher.dispatch(now);
    expect(events[0]).toMatchObject({ status: 'PENDING', attempts: 1 });
    expect((events[0]!.nextAttemptAt as Date).getTime() - Date.now()).toBeGreaterThan(25_000);
    expect(events[1]).toMatchObject({ status: 'SENT' });

    api.postMessage.mockResolvedValue(reply(429, 90_000));
    await dispatcher.dispatch();
    expect(events[0]).toMatchObject({ status: 'PENDING', attempts: 1 });
    expect((events[0]!.nextAttemptAt as Date).getTime() - Date.now()).toBeGreaterThan(85_000);

    api.postMessage.mockResolvedValue(reply(500));
    for (let round = 0; round < 5; round += 1) await dispatcher.dispatch();
    expect(events[0]).toMatchObject({ status: 'FAILED', attempts: 6 });
    expect(api.postMessage).toHaveBeenCalledTimes(8);
  });
});
