import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { readFileSync } from 'node:fs';
import { Server } from 'node:http';
import { join } from 'node:path';
import request from 'supertest';
import { ChatConfigService } from '../src/chat-integration/chat-config.service';
import { ChatEventsService } from '../src/chat-integration/chat-events.service';
import { CHAT_EVENTS_PATH } from '../src/chat-integration/chat-integration.constants';
import { ChatEventsController } from '../src/chat-integration/chat-integration.controller';
import { chatEventsRawBody, ChatWebhookGuard } from '../src/chat-integration/chat-webhook.guard';
import { GLOBAL_PREFIX, GLOBAL_PREFIX_OPTIONS } from '../src/common/global-prefix';
import { GlobalExceptionFilter } from '../src/common/filters/global-exception.filter';
import { RedisService } from '../src/queue/redis.service';

const BODY = readFileSync(join(__dirname, 'fixtures/chat-webhook-body.json'));
const SIGNATURE = 'sha256=856c47920354e6779a69421e3b22d055c65bafe42891130295e69b3921f7a32a';

describe('Chat webhook route (e2e)', () => {
  let app: INestApplication;
  const handle = jest.fn().mockResolvedValue('applied');

  beforeAll(async () => {
    const seen = new Set<string>();
    const module = await Test.createTestingModule({
      controllers: [ChatEventsController],
      providers: [
        ChatWebhookGuard,
        { provide: ChatEventsService, useValue: { handle } },
        { provide: ChatConfigService, useValue: { read: jest.fn().mockResolvedValue({ config: { enabled: true, webhookSecret: 'whsec_test_auto_social_1', previousWebhookSecret: null } }) } },
        { provide: RedisService, useValue: { setOnce: jest.fn((key: string) => Promise.resolve(!seen.has(key) && Boolean(seen.add(key)))), deleteKey: jest.fn() } },
      ],
    }).compile();
    app = module.createNestApplication();
    app.setGlobalPrefix(GLOBAL_PREFIX, GLOBAL_PREFIX_OPTIONS);
    // Same wiring as src/main.ts: raw bytes for this route, JSON parser for the rest.
    app.use(CHAT_EVENTS_PATH, chatEventsRawBody);
    app.useGlobalFilters(new GlobalExceptionFilter());
    await app.init();
    jest.useFakeTimers({ now: 1_795_400_010_000, doNotFake: ['nextTick', 'setImmediate', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  });

  afterAll(async () => {
    jest.useRealTimers();
    await app.close();
  });

  const post = (body: Buffer) => request(app.getHttpServer() as Server)
    .post(CHAT_EVENTS_PATH)
    .set('content-type', 'application/json')
    .set('x-webtui-timestamp', '1795400000')
    .set('x-webtui-signature', SIGNATURE)
    .set('x-webtui-event-id', '8b0f5a52-1c1e-4d58-9d43-3f2a5d0f9a01')
    // As a string: supertest would turn a Buffer into JSON of its bytes.
    .send(body.toString('utf8'));

  it('verifies the exact bytes chat signed, answers a replay with 200 and refuses a changed byte or an oversized body', async () => {
    const tampered = Buffer.from(BODY);
    tampered[tampered.indexOf('approved')] = 'A'.charCodeAt(0);
    await post(tampered).expect(401);

    const first = await post(BODY).expect(200);
    expect(first.body).toMatchObject({ received: true });
    expect(handle).toHaveBeenCalledWith(expect.objectContaining({ event_type: 'approval.decided' }));
    const replay = await post(BODY).expect(200);
    expect(replay.body).toMatchObject({ received: true, duplicate: true });
    expect(handle).toHaveBeenCalledTimes(1);

    await post(Buffer.alloc(300 * 1024, 32)).expect(413);
  });
});
