import { Injectable } from '@nestjs/common';
import { ConnectorError } from '../connectors/core/connector-error';
import { ConnectorOutboundHttpClient } from '../connectors/core/connector-outbound-http.client';

const TIMEOUT_MS = 15_000;

export interface ChatTarget {
  baseUrl: string;
  botToken: string;
}

export interface ChatCallResult {
  status: number;
  ok: boolean;
  /** `data` of the chat envelope on success. */
  data: Record<string, unknown> | null;
  errorCode: string | null;
  errorMessage: string | null;
  errorDetails: Record<string, unknown> | null;
  retryAfterMs: number | null;
}

/** A network failure, timeout or blocked address: retry later, nothing reached chat for sure. */
export class ChatTransportError extends Error {
  constructor(message: string, readonly retryable: boolean) {
    super(message);
  }
}

const object = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;

/** Retry-After in seconds or as an HTTP date. */
export function parseRetryAfter(value: string | null, now = Date.now()): number | null {
  if (!value) return null;
  if (/^\d+$/.test(value.trim())) return Math.min(Number(value.trim()), 3600) * 1000;
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, Math.min(at - now, 3_600_000)) : null;
}

/**
 * Bot API of the VPSTTT chat, through the same HTTPS-only, DNS-pinned
 * transport the connectors use (the chat address is admin-supplied).
 */
@Injectable()
export class ChatApiClient {
  constructor(private readonly http: ConnectorOutboundHttpClient = new ConnectorOutboundHttpClient()) {}

  createApproval(target: ChatTarget, body: Record<string, unknown>) {
    return this.call(target, 'POST', '/api/v1/bot/approvals', body);
  }

  getApproval(target: ChatTarget, approvalId: string) {
    return this.call(target, 'GET', `/api/v1/bot/approvals/${encodeURIComponent(approvalId)}`);
  }

  cancelApproval(target: ChatTarget, approvalId: string, reason: string) {
    return this.call(target, 'POST', `/api/v1/bot/approvals/${encodeURIComponent(approvalId)}/cancel`, { reason });
  }

  reportResult(target: ChatTarget, approvalId: string, body: Record<string, unknown>) {
    return this.call(target, 'POST', `/api/v1/bot/approvals/${encodeURIComponent(approvalId)}/result`, body);
  }

  postMessage(target: ChatTarget, channelId: string, body: Record<string, unknown>) {
    return this.call(target, 'POST', `/api/v1/bot/channels/${encodeURIComponent(channelId)}/messages`, body);
  }

  private async call(target: ChatTarget, method: string, path: string, body?: Record<string, unknown>): Promise<ChatCallResult> {
    let response: Awaited<ReturnType<ConnectorOutboundHttpClient['request']>>;
    try {
      response = await this.http.request(`${target.baseUrl}${path}`, {
        method,
        headers: { authorization: `Bearer ${target.botToken}`, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      }, TIMEOUT_MS);
    } catch (error) {
      if (error instanceof ConnectorError) {
        throw new ChatTransportError(error.retryable ? 'Không phân giải được tên máy chủ chat.'
          : 'Địa chỉ chat bị chặn: phải là https và trỏ tới máy chủ công khai.', error.retryable);
      }
      throw new ChatTransportError(error instanceof Error && error.name === 'TimeoutError' ? 'Chat không trả lời kịp (quá 15 giây).' : 'Không kết nối được tới chat.', true);
    }
    let parsed: Record<string, unknown> | null = null;
    try { parsed = object(JSON.parse(response.text)); } catch { parsed = null; }
    const error = object(parsed?.error);
    return {
      status: response.status,
      ok: response.ok,
      data: object(parsed?.data),
      errorCode: typeof error?.code === 'string' ? error.code : null,
      errorMessage: typeof error?.message === 'string' ? error.message.slice(0, 300) : null,
      errorDetails: object(error?.details),
      retryAfterMs: response.status === 429 ? parseRetryAfter(response.headers.get('retry-after')) : null,
    };
  }
}
