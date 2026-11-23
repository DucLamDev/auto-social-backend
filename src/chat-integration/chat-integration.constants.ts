/** Encrypted SystemSetting row holding the chat connection. */
export const CHAT_SETTING_KEY = 'integration.chat';

/** Webhook route (under the global prefix) that receives approval decisions from chat. */
export const CHAT_EVENTS_ROUTE = 'integrations/chat/events';
export const CHAT_EVENTS_PATH = `/api/v1/${CHAT_EVENTS_ROUTE}`;
export const CHAT_EVENTS_MAX_BYTES = 256 * 1024;
export const CHAT_EVENTS_MAX_SKEW_SECONDS = 300;
export const CHAT_EVENT_REPLAY_TTL_SECONDS = 24 * 60 * 60;

export const CHAT_OUTBOX_KINDS = ['APPROVAL_CREATE', 'APPROVAL_CANCEL', 'APPROVAL_RESULT', 'NOTICE', 'TEST'] as const;
export type ChatOutboxKind = (typeof CHAT_OUTBOX_KINDS)[number];

export const OUTBOX_PENDING = 'PENDING';
export const OUTBOX_SENT = 'SENT';
export const OUTBOX_FAILED = 'FAILED';
export const OUTBOX_SKIPPED = 'SKIPPED';

/** Links whose chat request may still be decided. */
export const OPEN_LINK_STATUSES = ['QUEUED', 'PENDING'];

/** Contract B2: wait 30 s, 2 min, 10 min, 1 h, 1 h; the 6th failed attempt is final. */
export const RETRY_DELAYS_MS = [30_000, 120_000, 600_000, 3_600_000, 3_600_000];
export const MAX_ATTEMPTS = 6;

export const CANCEL_REASON = 'Đã xử lý ở auto-social';
export const APPROVAL_EXPIRES_MINUTES = 10_080;
export const APPROVAL_ACTION = 'auto_social.publish_variant';
export const APPROVAL_RESOURCE_TYPE = 'auto_social.variant';

/** yyyy-mm-dd in Vietnam time, for "once per day" notice keys. */
export function vnDate(date: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}
