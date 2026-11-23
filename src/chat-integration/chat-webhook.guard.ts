import { CanActivate, ExecutionContext, Injectable, PayloadTooLargeException, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { RedisService } from '../queue/redis.service';
import { acceptedWebhookSecrets, ChatConfigService } from './chat-config.service';
import { CHAT_EVENT_REPLAY_TTL_SECONDS, CHAT_EVENTS_MAX_BYTES, CHAT_EVENTS_MAX_SKEW_SECONDS } from './chat-integration.constants';

export interface ChatEventRequest extends Request {
  rawBody?: Buffer;
  chatEvent?: Record<string, unknown>;
  chatDuplicate?: boolean;
}

/** `sha256=` + hex HMAC-SHA256(secret, "<timestamp>.<raw body>"), contract A4. */
export function signChatEvent(secret: string, timestamp: string, body: Buffer): string {
  return `sha256=${createHmac('sha256', secret).update(`${timestamp}.`).update(body).digest('hex')}`;
}

function sameSignature(expected: string, received: string): boolean {
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(received, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Reads the body of the chat webhook route as bytes (the signature covers the
 * exact bytes) with a 256 KB cap. Mounted on that path only; the request is
 * then finished, so the global JSON parser leaves it alone.
 */
export function chatEventsRawBody(req: ChatEventRequest, res: Response, next: NextFunction): void {
  if (req.method !== 'POST') return next();
  const declared = Number(req.headers['content-length'] ?? 0);
  if (declared > CHAT_EVENTS_MAX_BYTES) {
    res.status(413).json({ success: false, error: { code: 'PAYLOAD_TOO_LARGE', message: 'Body exceeds 256 KB' } });
    req.resume();
    return;
  }
  const chunks: Buffer[] = [];
  let size = 0;
  let done = false;
  req.on('data', (chunk: Buffer) => {
    if (done) return;
    size += chunk.length;
    if (size > CHAT_EVENTS_MAX_BYTES) {
      done = true;
      res.status(413).json({ success: false, error: { code: 'PAYLOAD_TOO_LARGE', message: 'Body exceeds 256 KB' } });
      return;
    }
    chunks.push(chunk);
  });
  req.on('end', () => {
    if (done) return;
    done = true;
    req.rawBody = Buffer.concat(chunks, size);
    req.body = {};
    next();
  });
  req.on('error', (error) => {
    if (done) return;
    done = true;
    next(error);
  });
}

/**
 * Contract B1, in order: body cap, timestamp within ±300 s, constant-time HMAC
 * against the current or previous webhook secret (either signature header),
 * (the old one only for 24 h after the rotation), a 503 while the connection
 * is switched off, then the signed `event_id` seen once per 24 h (Redis SET NX). A replay is
 * let through flagged as duplicate so the controller answers 200 and chat
 * stops retrying.
 */
@Injectable()
export class ChatWebhookGuard implements CanActivate {
  constructor(private readonly chatConfig: ChatConfigService, private readonly redis: RedisService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<ChatEventRequest>();
    const body = request.rawBody;
    if (!Buffer.isBuffer(body)) throw new UnauthorizedException('Missing webhook body');
    if (body.length > CHAT_EVENTS_MAX_BYTES) throw new PayloadTooLargeException('Body exceeds 256 KB');

    const timestamp = this.header(request, 'x-webtui-timestamp');
    if (!timestamp || !/^\d{1,12}$/.test(timestamp) || Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp)) > CHAT_EVENTS_MAX_SKEW_SECONDS) {
      throw new UnauthorizedException('Webhook timestamp is missing or outside the allowed window');
    }

    const { config } = await this.chatConfig.read();
    const secrets = acceptedWebhookSecrets(config);
    const received = [this.header(request, 'x-webtui-signature'), this.header(request, 'x-webtui-signature-previous')]
      .filter((value): value is string => Boolean(value && /^sha256=[0-9a-f]{64}$/.test(value)));
    let valid = false;
    for (const secret of secrets) {
      const expected = signChatEvent(secret, timestamp, body);
      // Evaluate every pair: no early exit that would time which one matched.
      for (const signature of received) valid = sameSignature(expected, signature) || valid;
    }
    if (!valid) throw new UnauthorizedException('Webhook signature is invalid');

    let event: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(body.toString('utf8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
      event = parsed as Record<string, unknown>;
    } catch {
      throw new UnauthorizedException('Webhook body is not a JSON object');
    }
    // The header is not signed: deduplicate on the signed event_id.
    const eventId = typeof event.event_id === 'string' ? event.event_id : '';
    const headerId = this.header(request, 'x-webtui-event-id');
    if (!/^[A-Za-z0-9._:-]{1,200}$/.test(eventId) || (headerId && headerId !== eventId)) throw new UnauthorizedException('Webhook event id is invalid');
    // Switched off: answer 503 before the id is remembered, so chat delivers it again later.
    if (!config.enabled) throw new ServiceUnavailableException('Chat integration is switched off');
    request.chatEvent = event;
    request.chatDuplicate = !(await this.redis.setOnce(`chat:webhook:event:${eventId}`, '1', CHAT_EVENT_REPLAY_TTL_SECONDS));
    return true;
  }

  private header(request: Request, name: string): string | undefined {
    const value = request.headers[name];
    return (Array.isArray(value) ? value[0] : value)?.trim() || undefined;
  }
}
