import { ExecutionContext, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { RedisService } from '../queue/redis.service';
import { ChatConfigService } from './chat-config.service';
import { ChatEventRequest, ChatWebhookGuard, signChatEvent } from './chat-webhook.guard';

/** Contract section C: the same sample the chat side signs in its own tests. */
const SECRET = 'whsec_test_auto_social_1';
const TIMESTAMP = '1795400000';
const BODY = readFileSync(join(__dirname, '../../test/fixtures/chat-webhook-body.json'));
const SIGNATURE = 'sha256=856c47920354e6779a69421e3b22d055c65bafe42891130295e69b3921f7a32a';

type Secrets = { webhookSecret: string | null; previousWebhookSecret?: string | null; previousWebhookSecretSetAt?: string | null; enabled?: boolean };

function setup(secrets: Secrets = { webhookSecret: SECRET }) {
  const seen = new Set<string>();
  const redis = { setOnce: jest.fn((key: string) => Promise.resolve(!seen.has(key) && Boolean(seen.add(key)))) };
  const chatConfig = { read: jest.fn().mockResolvedValue({ config: { enabled: true, previousWebhookSecret: null, previousWebhookSecretSetAt: null, ...secrets } }) };
  const guard = new ChatWebhookGuard(chatConfig as unknown as ChatConfigService, redis as unknown as RedisService);
  const run = (body: Buffer, headers: Record<string, string>) => {
    const request = { rawBody: body, headers: Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value])) } as unknown as ChatEventRequest;
    const context = { switchToHttp: () => ({ getRequest: () => request }) } as unknown as ExecutionContext;
    return guard.canActivate(context).then((ok) => ({ ok, request }));
  };
  return { run, redis };
}

const headers = (signature = SIGNATURE) => ({
  'X-WebTui-Timestamp': TIMESTAMP,
  'X-WebTui-Signature': signature,
  'X-WebTui-Event-ID': '8b0f5a52-1c1e-4d58-9d43-3f2a5d0f9a01',
});

describe('ChatWebhookGuard', () => {
  beforeEach(() => jest.useFakeTimers({ now: Number(TIMESTAMP) * 1000 + 30_000 }));
  afterEach(() => jest.useRealTimers());

  it('accepts the contract sample and flags its replay as a duplicate', async () => {
    expect(BODY.length).toBe(773);
    expect(signChatEvent(SECRET, TIMESTAMP, BODY)).toBe(SIGNATURE);
    const { run } = setup();
    const first = await run(BODY, headers());
    expect(first.ok).toBe(true);
    expect(first.request.chatDuplicate).toBe(false);
    expect(first.request.chatEvent).toMatchObject({ event_type: 'approval.decided' });
    const replay = await run(BODY, headers());
    expect(replay.request.chatDuplicate).toBe(true);
  });

  it('refuses one changed byte, a stale timestamp and a wrong key, and accepts the old key during rotation', async () => {
    const { run, redis } = setup();
    const tampered = Buffer.from(BODY);
    tampered[tampered.indexOf('approved')] = 'A'.charCodeAt(0);
    await expect(run(tampered, headers())).rejects.toBeInstanceOf(UnauthorizedException);
    jest.setSystemTime(Number(TIMESTAMP) * 1000 + 301_000);
    await expect(run(BODY, headers())).rejects.toThrow('timestamp');
    jest.setSystemTime(Number(TIMESTAMP) * 1000);
    await expect(setup({ webhookSecret: 'whsec_other_secret_value' }).run(BODY, headers())).rejects.toThrow('signature');
    // Nothing invalid reached the replay store.
    expect(redis.setOnce).not.toHaveBeenCalled();
    const rotatedAt = new Date(Number(TIMESTAMP) * 1000 - 3_600_000).toISOString();
    const rotated = setup({ webhookSecret: 'whsec_new_secret_value_1', previousWebhookSecret: SECRET, previousWebhookSecretSetAt: rotatedAt });
    await expect(rotated.run(BODY, { ...headers('sha256=' + '0'.repeat(64)), 'X-WebTui-Signature-Previous': SIGNATURE })).resolves.toMatchObject({ ok: true });
  });

  it('stops accepting the old key 24 hours after the rotation, and answers 503 while switched off without remembering the event', async () => {
    const rotatedAt = new Date(Number(TIMESTAMP) * 1000 - 25 * 3_600_000).toISOString();
    const expired = setup({ webhookSecret: 'whsec_new_secret_value_1', previousWebhookSecret: SECRET, previousWebhookSecretSetAt: rotatedAt });
    await expect(expired.run(BODY, headers())).rejects.toThrow('signature');

    const off = setup({ webhookSecret: SECRET, enabled: false });
    await expect(off.run(BODY, headers())).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(off.redis.setOnce).not.toHaveBeenCalled();
  });
});
