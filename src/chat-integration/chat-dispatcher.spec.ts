import { PrismaService } from '../database/prisma.service';
import { RedisService } from '../queue/redis.service';
import { ChatApiClient, ChatCallResult } from './chat-api.client';
import { ChatConfigService } from './chat-config.service';
import { ChatDispatcherService } from './chat-dispatcher.service';
import { ChatOutboxService } from './chat-outbox.service';

const CONFIG = { enabled: true, baseUrl: 'https://chat.example.com', botToken: 'wtb_test_token', channelId: '11111111-1111-4111-8111-111111111111' };

function setup() {
  const draft = { title: null as string | null, body: 'Bản gốc', hashtags: ['sale'], platformId: 'platform-1' };
  const link: Record<string, unknown> = { id: 'link-1', campaignId: 'campaign-1', variantId: 'variant-1', cycle: 1, externalKey: 'variant:variant-1:c1', status: 'QUEUED', approvalId: null, requestBody: null, contentHash: null };
  const events = [{ id: 'event-1', kind: 'APPROVAL_CREATE', payload: { linkId: 'link-1' }, attempts: 0, status: 'PENDING' }];
  const prisma = {
    chatOutboxEvent: {
      findMany: jest.fn(() => Promise.resolve(events.filter((event) => event.status === 'PENDING'))),
      updateMany: jest.fn(({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const event = events.find((row) => row.id === where.id && row.status === 'PENDING');
        if (event) Object.assign(event, data);
        return Promise.resolve({ count: event ? 1 : 0 });
      }),
    },
    chatApprovalLink: {
      findUnique: jest.fn(() => Promise.resolve({ ...link })),
      updateMany: jest.fn(({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        const match = link.status === where.status || (where.status === undefined);
        if (!match || ('requestBody' in where && link.requestBody !== null)) return Promise.resolve({ count: 0 });
        Object.assign(link, data);
        return Promise.resolve({ count: 1 });
      }),
      update: jest.fn(({ data }: { data: Record<string, unknown> }) => Promise.resolve(Object.assign(link, data))),
    },
    campaign: {
      findFirst: jest.fn().mockResolvedValue({ id: 'campaign-1', name: 'Khuyến mãi', automationVariantIds: ['variant-1'], owner: { email: 'Chu@vpsttt.com' } }),
      findUnique: jest.fn().mockResolvedValue({ scheduledAt: null, automationRequest: { platformAccountIds: ['account-1'] } }),
    },
    contentVariant: {
      findFirst: jest.fn().mockResolvedValue({ id: 'variant-1', aiApproval: null, platform: { name: 'Facebook' } }),
      findUnique: jest.fn(() => Promise.resolve({ ...draft })),
    },
    platformAccount: { findMany: jest.fn().mockResolvedValue([{ id: 'account-1', name: 'Fanpage' }]) },
    mediaAsset: { findMany: jest.fn().mockResolvedValue([]) },
  };
  const chatConfig = { active: jest.fn().mockResolvedValue(CONFIG), frontendUrl: () => 'https://social.example.com' };
  const outbox = { record: jest.fn().mockResolvedValue(true), reviewReady: jest.fn(), reviewClosed: jest.fn() };
  const api = { createApproval: jest.fn<Promise<ChatCallResult>, [unknown, Record<string, unknown>]>() };
  const dispatcher = new ChatDispatcherService(prisma as unknown as PrismaService, {} as RedisService, chatConfig as unknown as ChatConfigService,
    outbox as unknown as ChatOutboxService, api as unknown as ChatApiClient);
  return { dispatcher, api, link, draft, events, outbox };
}

const reply = (status: number, approval: Record<string, unknown> = {}): ChatCallResult => ({
  status, ok: status < 300, data: { approval }, errorCode: null, errorMessage: null, errorDetails: null, retryAfterMs: null,
});

describe('Chat approval requests', () => {
  it('fixes the request and its hash before the first call, and resends exactly that body after the post is edited', async () => {
    const { dispatcher, api, link, draft, events } = setup();
    api.createApproval.mockResolvedValueOnce(reply(503));
    await dispatcher.dispatch();
    const first = api.createApproval.mock.calls[0]![1];
    expect(first).toMatchObject({ external_key: 'variant:variant-1:c1', approver_rule: { type: 'emails', values: ['chu@vpsttt.com'] }, display: { text: 'Bản gốc\n\n#sale' } });
    expect(link.contentHash).toEqual(expect.any(String));
    const hash = link.contentHash;

    draft.body = 'Đã sửa sau khi gửi';
    events[0]!.status = 'PENDING';
    Object.assign(events[0]!, { nextAttemptAt: new Date(0) });
    api.createApproval.mockResolvedValueOnce(reply(201, { id: 'approval-1', display: { text: 'Bản gốc\n\n#sale' } }));
    await dispatcher.dispatch();
    expect(api.createApproval.mock.calls[1]![1]).toEqual(first);
    expect(link).toMatchObject({ status: 'PENDING', approvalId: 'approval-1', contentHash: hash });
  });

  it('cancels an older chat request returned for the same key with another text, and opens a new round', async () => {
    const { dispatcher, api, link, outbox } = setup();
    api.createApproval.mockResolvedValueOnce(reply(200, { id: 'approval-old', display: { text: 'Chữ cũ hơn' } }));
    await dispatcher.dispatch();
    expect(link).toMatchObject({ status: 'FAILED', approvalId: 'approval-old' });
    expect(outbox.record).toHaveBeenCalledWith('APPROVAL_CANCEL', 'cancel:approval-old', { approvalId: 'approval-old' });
    expect(outbox.reviewReady).toHaveBeenCalledWith('campaign-1', ['variant-1']);
  });
});
