import sanitizeHtml from 'sanitize-html';

export type CardStatus = 'success' | 'error' | 'warning' | 'info' | 'pending';

export interface NoticeInput {
  title: string;
  status: CardStatus;
  statusLabel: string;
  summary: string;
  facts: Array<{ label: string; value: string | null | undefined }>;
  /** https link to the auto-social page; omitted when the frontend is not https. */
  link?: { label: string; url: string } | null;
}

const clip = (value: string, max: number) => (value.length > max ? `${value.slice(0, max - 1)}…` : value);

/** Plain text for chat: no HTML, line breaks kept. */
export function plainText(value: string, max: number): string {
  const text = sanitizeHtml(value.replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n\n'), { allowedTags: [], allowedAttributes: {} })
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return clip(text, max);
}

/**
 * A level-1 notice for the "Auto Social" channel: a v2 card (colour by status)
 * plus the required plain `body`, which also carries the https link because
 * card buttons only open webtui:// targets.
 */
export function noticeMessage(input: NoticeInput): { body: string; metadata: { card: Record<string, unknown> } } {
  const facts = input.facts
    .filter((fact): fact is { label: string; value: string } => Boolean(fact.value))
    .slice(0, 8)
    .map((fact) => ({ label: clip(fact.label, 40), value: clip(fact.value, 200) }));
  const lines = [
    `Auto Social · ${input.title}`,
    input.summary,
    ...facts.map((fact) => `${fact.label}: ${fact.value}`),
    ...(input.link ? [`${input.link.label}: ${input.link.url}`] : []),
  ];
  return {
    body: clip(lines.join('\n'), 4000),
    metadata: {
      card: {
        version: 2,
        title: clip(input.title, 200),
        subtitle: 'Auto Social',
        status: input.status,
        status_label: input.statusLabel,
        summary: clip(input.summary, 500),
        facts,
      },
    },
  };
}

/** "23/11/2026 10:00" in Vietnam time. */
export function vnDateTime(date: Date): string {
  return new Intl.DateTimeFormat('vi-VN', {
    timeZone: 'Asia/Ho_Chi_Minh', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(date);
}

export function pageLink(frontendUrl: string | null, path: string, label = 'Mở trong auto-social'): { label: string; url: string } | null {
  return frontendUrl ? { label, url: `${frontendUrl}${path}` } : null;
}
