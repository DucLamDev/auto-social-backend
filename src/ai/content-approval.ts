import { createHash } from 'node:crypto';
import { z } from 'zod';
import { peerAudience, socialFeed, type PlatformContract } from '../platforms/platform-contract';
import { AI_PROVIDER_LABELS, isAiProvider, type AiProvider } from './ai-provider';

/**
 * Three independent AI roles: the writer (chosen per campaign) writes and
 * rewrites, the reviewer scores and critiques (brand safety, clumsy seeding),
 * and the approver gives the final yes before a post may be approved or
 * published. Reviewer and approver are configured on the server as
 * `provider:model`; by default both are `vpsttt:claude:opus`, and then the
 * reviewer's last review of a draft is also its final verdict (one model, one
 * judgement, whose notes reach the writer's rewrites).
 */
export interface AiRole {
  provider: AiProvider;
  /** Model for this role; empty means the provider's configured default model. */
  model: string;
}

export type AiRoleName = 'writer' | 'reviewer' | 'approver';

/** `provider:model` (the model may itself contain ":", e.g. `vpsttt:claude:opus`). Throws on an unknown provider. */
export function parseAiRole(value: string, setting: string): AiRole {
  const text = value.trim();
  const colon = text.indexOf(':');
  const provider = (colon === -1 ? text : text.slice(0, colon)).trim().toLowerCase();
  if (!isAiProvider(provider)) throw new Error(`${setting} must look like provider:model with provider one of openai, deepseek, gemini, vpsttt`);
  return { provider, model: colon === -1 ? '' : text.slice(colon + 1).trim() };
}

/** Human label of a role for the UI: "Claude Opus", "GPT (VPSTTT AI)", "OpenAI · gpt-5-mini". */
export function aiRoleLabel(role: AiRole, defaultModel?: string): string {
  const model = role.model || defaultModel || '';
  const claude = /^claude:(\w+)/i.exec(model);
  if (role.provider === 'vpsttt' && claude) return `Claude ${claude[1]!.charAt(0).toUpperCase()}${claude[1]!.slice(1).toLowerCase()}`;
  if (role.provider === 'vpsttt' && /^gpt:/i.test(model)) return 'GPT (VPSTTT AI)';
  return model ? `${AI_PROVIDER_LABELS[role.provider]} · ${model}` : AI_PROVIDER_LABELS[role.provider];
}

/** Same provider and model: the role is not independent of the other. */
export function sameAiRole(a: AiRole, b: AiRole, defaultModel: (provider: AiProvider) => string): boolean {
  return a.provider === b.provider && (a.model || defaultModel(a.provider)) === (b.model || defaultModel(b.provider));
}

export type AiApprovalStatus = 'running' | 'approved' | 'rejected' | 'failed';
export type BrandRisk = 'none' | 'low' | 'medium' | 'high';

/**
 * The final approver's verdict on one variant, stored in
 * `content_variants.aiApproval`. It is valid only for the exact text it read:
 * `textHash` must match `approvalHash()` of the variant's current text.
 */
export interface AiApproval {
  status: AiApprovalStatus;
  /** `provider:model` of the approver, e.g. `vpsttt:claude:opus`. */
  approver: string;
  /** Human label of the approver, e.g. "Claude Opus". */
  approverLabel: string;
  textHash: string;
  /** 1–10, the approver's own quality score. */
  score?: number;
  risk?: BrandRisk;
  seeding?: boolean;
  /** Vietnamese, short; why it was rejected (or what to watch for when approved). */
  reasons?: string[];
  startedAt: string;
  finishedAt?: string | null;
  error?: string | null;
}

/** Fingerprint of the text a reader sees: an edit, a rewrite or new hashtags invalidate an approval. */
export function approvalHash(input: { title?: string | null; body: string; hashtags?: readonly string[] | null }): string {
  const normalized = JSON.stringify([
    (input.title ?? '').trim(),
    input.body.replace(/\r\n?/g, '\n').trim(),
    [...(input.hashtags ?? [])].map((tag) => tag.trim().replace(/^#+/, '').toLowerCase()).filter(Boolean),
  ]);
  return createHash('sha256').update(normalized).digest('hex');
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** The stored approval, or null when the variant has none (older variants, never sent to the approver). */
export function readAiApproval(value: unknown): AiApproval | null {
  const stored = record(value);
  if (!['running', 'approved', 'rejected', 'failed'].includes(String(stored.status)) || typeof stored.textHash !== 'string') return null;
  return stored as unknown as AiApproval;
}

/** True only when the approver said yes to exactly this text. */
export function aiApprovedFor(value: unknown, text: { title?: string | null; body: string; hashtags?: readonly string[] | null }): boolean {
  const approval = readAiApproval(value);
  return approval?.status === 'approved' && approval.textHash === approvalHash(text);
}

/**
 * Server defaults (`AI_REVIEWER`, `AI_APPROVER`): Claude Opus of the company
 * VPSTTT AI key scores and gives the final yes. With a separate reviewer
 * (e.g. Sonnet) its notes and the approver's refusals disagreed, and the
 * writer never saw why the approver refused.
 */
export const DEFAULT_AI_REVIEWER = 'vpsttt:claude:opus';
export const DEFAULT_AI_APPROVER = 'vpsttt:claude:opus';

/** `provider:model` as stored in settings and in `AiApproval.approver`; no model means the provider's default. */
export function aiRoleSetting(role: AiRole): string {
  return role.model ? `${role.provider}:${role.model}` : role.provider;
}

export const BRAND_RISKS: readonly BrandRisk[] = ['none', 'low', 'medium', 'high'];

/** Vietnamese names of the risk levels, for reasons operators read. */
export const BRAND_RISK_LABELS_VI: Record<BrandRisk, string> = { none: 'không có', low: 'thấp', medium: 'trung bình', high: 'cao' };

/** Only none and low may be published. */
export function brandRiskAcceptable(risk: BrandRisk | null | undefined): boolean {
  return risk === 'none' || risk === 'low';
}

/** A model's risk level ("Medium", "moderate", "high risk") as one of the four levels, or null when unrecognisable. */
export function normalizeBrandRisk(value: unknown): BrandRisk | null {
  if (typeof value !== 'string') return null;
  const text = value.trim().toLowerCase();
  if (!text) return null;
  if (/high|severe|critical/.test(text)) return 'high';
  if (/medium|moderate/.test(text)) return 'medium';
  if (/low|minor/.test(text)) return 'low';
  if (/none|no risk|^no$/.test(text)) return 'none';
  return null;
}

// Ranges and the risk level are enforced by approvalVerdict, not the schema:
// strict structured-output modes do not all accept numeric bounds.
export const ApprovalSchema = z.object({
  approved: z.boolean(),
  score: z.number(),
  risk: z.string(),
  seeding: z.boolean(),
  reasons: z.array(z.string()),
});

export type ApprovalOutput = z.infer<typeof ApprovalSchema>;

export const approvalJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['approved', 'score', 'risk', 'seeding', 'reasons'],
  properties: {
    approved: { type: 'boolean' },
    score: { type: 'integer' },
    risk: { type: 'string', enum: [...BRAND_RISKS] },
    seeding: { type: 'boolean' },
    reasons: { type: 'array', items: { type: 'string' } },
  },
} as const;

export const MAX_APPROVAL_REASONS = 5;
const MAX_APPROVAL_REASON_LENGTH = 300;

/**
 * The final approver's instructions: a senior brand-safety editor who reads
 * the post exactly as it will be published and says yes or no. A wrong yes
 * costs the company more than a wrong no.
 */
export function approvalInstructions(contract: PlatformContract): string {
  const language = contract.language === 'vi' ? 'Vietnamese' : 'English';
  return [
    `You are the final approver for posts published on behalf of VPSTTT, a VPS and proxy provider (the brand in the brand facts): a senior editor responsible for brand safety and editorial quality. No post is published without your yes, and a wrong yes costs the company more than a wrong no.`,
    `You receive the post exactly as readers will see it on ${contract.name}, its image description if it has one, the brief, the brand facts, the destination rules and the last review by the editor. The review is context, not a verdict: judge the text yourself.`,
    'Approve only when every point holds:',
    `- Quality: ready to publish as is on ${contract.name}: clear, specific, written in ${language}, within the destination rules; a reader would not find it generic, confusing or unfinished.`,
    '- Natural, no seeding: it does not pretend to be an unaffiliated customer or a neutral user while promoting the brand; no fake or invented testimonials; no forced or repeated brand mentions; no over-praise; no stacked links or calls to action; no advertising tone in a technical community or forum; no disparaging competitors; when it promotes the brand in a forum or community it says the author is affiliated.',
    peerAudience(contract)
      ? '- Disclosure: when the post names or recommends the brand or its product, the author says they work there inside that same sentence; that is what you want, not a problem. Refuse a disclosure standing as its own sentence, glued to an unrelated tip or caveat, repeated, or present when the post never mentions the brand, and ask to fold it into the product sentence or remove it.'
      : `- Disclosure: ${contract.name} posts go out from the brand's own account, so readers already know who is speaking. Refuse a post with an "I work at …" or "Mình làm ở …" sentence or any other disclosure, and ask to remove it.`,
    '- Clean: no leaked internal text. Refuse a post that mentions a brief, a campaign, instructions, "this post/content", what is not confirmed, or carries a note to the operator ("before posting add…"), and a disclosure written as a stiff label ("brand-related content", "this post is associated with the brand").',
    '- Factual: every statement about the brand, its products, prices, performance, customers or offers comes from the brief or the brand facts. No guarantee they do not back, such as cheapest, 100% uptime, unlimited, never blocked or undetectable.',
    '- Safe for the company: nothing explains how to use proxies or VPS to break laws or website terms (evading bans or blocks, scraping against terms of service, spam, mass account creation, fraud); no sensitive political, legal, religious or offensive content; nothing that would embarrass the company if a reader took a screenshot. An image description must fit the post and show no real people, logos or text.',
    `- Fits the community: tone, format and purpose suit ${contract.name} and its members.${socialFeed(contract) ? ' A short social post reads as one hook line, one short paragraph or 2 to 4 bullets, and exactly one closing line; scattered one-line paragraphs or several closing lines lower the score and are a reason.' : ''}`,
    'Return:',
    '- approved: true only when every point above holds.',
    '- score: how ready to publish the post is, from 1 to 10 (8 or more: publish as is).',
    '- risk: the risk for the company of publishing it as is: none; low (a small wording issue a reader would hardly notice); medium (must change before publishing); high (must never be published).',
    '- seeding: true when the post reads as clumsy seeding or astroturfing.',
    `- reasons: at most ${MAX_APPROVAL_REASONS} short reasons in Vietnamese for the operator, most important first. When you refuse, point to or quote the sentence and say what to change. When you approve, at most two points to watch, or none.`,
  ].join('\n');
}

export interface ApprovalInputParts {
  /** The destination contract as the writer received it. */
  rules: string;
  briefKind: 'short marketing brief' | 'source content';
  brief: string;
  /** `brandProfileBlock()`; empty when there is no brand profile. */
  brandBlock: string;
  /** The rendered post: title (empty when the destination shows none), body, and tags sent in a separate field. */
  post: { title: string; body: string; tags: readonly string[] };
  image?: { prompt?: string | null; altText?: string | null } | null;
  /** The editor's last assessment, or the stored review reason. */
  reviewNotes?: string | null;
}

export function approvalInput(contract: PlatformContract, parts: ApprovalInputParts): string {
  const prompt = parts.image?.prompt?.trim();
  const altText = parts.image?.altText?.trim();
  return [
    `Destination: ${contract.name}\n<destination_rules>\n${parts.rules}\n</destination_rules>`,
    `Brief or source (${parts.briefKind}):\n${parts.brief.slice(0, 20_000)}`,
    parts.brandBlock,
    [
      `The post exactly as readers will see it on ${contract.name}:`,
      '<post>',
      parts.post.title ? `<title>${parts.post.title}</title>` : '',
      `<body>\n${parts.post.body}\n</body>`,
      parts.post.tags.length ? `<tags>${parts.post.tags.join(', ')}</tags>` : '',
      '</post>',
    ].filter(Boolean).join('\n'),
    prompt || altText
      ? `Image attached to the post:\n- Generator prompt: ${prompt ? prompt.slice(0, 3_000) : '(none)'}\n- Alt text: ${altText || '(none)'}`
      : 'Image: none, the post is text only.',
    `The editor's last review:\n${parts.reviewNotes?.trim().slice(0, 4_000) || '(none)'}`,
  ].filter(Boolean).join('\n\n');
}

/**
 * The approver's verdict as stored: only a yes without seeding and with no or
 * low risk approves, whatever the model's own `approved` says.
 */
export function approvalVerdict(output: ApprovalOutput): Pick<AiApproval, 'status' | 'score' | 'risk' | 'seeding' | 'reasons'> {
  // An unreadable risk level from the final gate is not taken as safe.
  const risk = normalizeBrandRisk(output.risk) ?? 'medium';
  const score = Math.min(10, Math.max(1, Math.round(Number.isFinite(output.score) ? output.score : 1)));
  const approved = output.approved && !output.seeding && brandRiskAcceptable(risk);
  const given = output.reasons.map((reason) => reason.trim().slice(0, MAX_APPROVAL_REASON_LENGTH)).filter(Boolean);
  // When the server overrides the model's yes, say why.
  const overridden = output.approved && !approved
    ? [
        ...(output.seeding ? ['Bài có dấu hiệu seeding (quảng cáo trá hình)'] : []),
        ...(!brandRiskAcceptable(risk) ? [`Rủi ro cho công ty: mức ${BRAND_RISK_LABELS_VI[risk]}`] : []),
      ]
    : [];
  const reasons = [...new Set([...overridden, ...given])].slice(0, MAX_APPROVAL_REASONS);
  return {
    status: approved ? 'approved' : 'rejected',
    score,
    risk,
    seeding: output.seeding,
    reasons: !approved && !reasons.length ? ['AI duyệt cuối không nêu lý do từ chối'] : reasons,
  };
}
