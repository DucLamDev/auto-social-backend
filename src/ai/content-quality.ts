import { z } from 'zod';
import { countChars, detectLanguage, PlatformContract } from '../platforms/platform-contract';
import { publishedLength } from '../platforms/post-text';
import { BRAND_RISKS, BRAND_RISK_LABELS_VI, brandRiskAcceptable, MAX_APPROVAL_REASONS, normalizeBrandRisk, type AiApproval, type BrandRisk } from './content-approval';

export const QUALITY_PASS_SCORE = 7;
/** Rewrites after a failing first draft; the best-scoring attempt is kept. */
export const QUALITY_MAX_REWRITES = 2;

/** Filler that makes posts read as generic AI copy. Checked case-insensitively. */
export const CLICHES = [
  'in today\'s digital age',
  'in today\'s fast-paced world',
  'game-changer',
  'game changer',
  'unlock the power',
  'elevate your',
  'look no further',
  'dive into',
  'trong thời đại số',
  'trong thời đại công nghệ',
  'trong kỷ nguyên số',
  'hãy cùng khám phá',
  'hãy cùng tìm hiểu',
  'giải pháp toàn diện',
  'không thể bỏ qua',
  'đừng bỏ lỡ',
];

const LANGUAGE_NAMES = { vi: 'Vietnamese', en: 'English' } as const;
const LANGUAGE_LABELS_VI = { vi: 'tiếng Việt', en: 'tiếng Anh' } as const;

export interface DraftForCheck {
  title: string | null;
  body: string;
  hashtags: string[];
}

/** Checks a machine can decide; messages are Vietnamese because operators read them. */
export function deterministicIssues(draft: DraftForCheck, contract: PlatformContract, canonicalUrl?: string | null): string[] {
  const issues: string[] = [];
  if (!draft.body.trim()) return ['Nội dung trống'];
  if (contract.maxChars) {
    const length = publishedLength(draft, contract, canonicalUrl);
    if (length > contract.maxChars) issues.push(`Dài ${length}/${contract.maxChars} ký tự, cần bớt ít nhất ${length - contract.maxChars} ký tự`);
  }
  if (contract.titleRequired && !draft.title?.trim()) issues.push('Thiếu tiêu đề');
  if (draft.title && countChars(draft.title.trim(), 'graphemes') > contract.titleMaxChars) {
    issues.push(`Tiêu đề dài quá ${contract.titleMaxChars} ký tự`);
  }
  const language = detectLanguage(`${draft.title ?? ''}\n${draft.body}`);
  if (language !== 'unknown' && language !== contract.language) issues.push(`Sai ngôn ngữ: cần viết ${LANGUAGE_LABELS_VI[contract.language]}`);
  if (contract.format === 'html' && /(^|\n)\s{0,3}#{1,6}\s|\*\*[^*\n]+\*\*/.test(draft.body)) {
    issues.push('Còn ký hiệu Markdown trong khi nơi đăng cần HTML');
  }
  const inlineTags = draft.body.match(/(^|\s)#[\p{L}\p{N}_]+/gu)?.length ?? 0;
  if (contract.hashtagMode === 'inline' && inlineTags > contract.maxHashtags) {
    issues.push(`Quá nhiều hashtag (${inlineTags}), tối đa ${contract.maxHashtags}`);
  }
  if (contract.hashtagMode === 'appended' && draft.hashtags.length > contract.maxHashtags) {
    issues.push(`Quá nhiều hashtag (${draft.hashtags.length}), tối đa ${contract.maxHashtags}`);
  }
  const lower = `${draft.title ?? ''}\n${draft.body}`.toLowerCase();
  const cliches = CLICHES.filter((phrase) => lower.includes(phrase));
  if (cliches.length) issues.push(`Có câu sáo: ${cliches.map((phrase) => `"${phrase}"`).join(', ')}`);
  return issues;
}

// Ranges are enforced by clampReview, not the schema: strict structured-output
// modes do not all accept numeric bounds. The seeding and brand-risk fields are
// required by the JSON schema but tolerated when a model leaves them out:
// clampReview treats a missing one as "not detected" / "none".
export const ReviewSchema = z.object({
  score: z.number(),
  hook: z.number(),
  specificity: z.number(),
  platformFit: z.number(),
  naturalness: z.number(),
  languageOk: z.boolean(),
  unsupportedClaims: z.array(z.string()),
  issues: z.array(z.string()),
  seeding: z.object({ detected: z.boolean(), notes: z.array(z.string()).nullable().optional() }).nullable().optional(),
  brandRisk: z.string().nullable().optional(),
  riskNotes: z.array(z.string()).nullable().optional(),
});

/** The review as a model returned it. */
export type ReviewOutput = z.infer<typeof ReviewSchema>;

/** The review after clampReview: every field present and within range. */
export interface ContentReview extends Omit<ReviewOutput, 'seeding' | 'brandRisk' | 'riskNotes'> {
  /** Clumsy seeding / astroturfing; notes are Vietnamese, at most three. */
  seeding: { detected: boolean; notes: string[] };
  /** Risk for the company if the draft went out as is. */
  brandRisk: BrandRisk;
  /** Vietnamese, at most three. */
  riskNotes: string[];
}

const clampScore = (value: number) => Math.min(10, Math.max(1, Math.round(Number.isFinite(value) ? value : 1)));
const cleanList = (items: readonly string[] | null | undefined, max: number) => (items ?? []).map((item) => item.trim()).filter(Boolean).slice(0, max);

/** The seeding / brand-risk fields a model left out or made unreadable; clampReview filled them with safe defaults. */
export function missingSafetyFields(review: ReviewOutput): string[] {
  return [
    ...(review.seeding ? [] : ['seeding']),
    ...(normalizeBrandRisk(review.brandRisk) ? [] : ['brandRisk']),
  ];
}

export function clampReview(review: ReviewOutput): ContentReview {
  return {
    ...review,
    score: clampScore(review.score),
    hook: clampScore(review.hook),
    specificity: clampScore(review.specificity),
    platformFit: clampScore(review.platformFit),
    naturalness: clampScore(review.naturalness),
    unsupportedClaims: cleanList(review.unsupportedClaims, 5),
    issues: cleanList(review.issues, 5),
    seeding: { detected: review.seeding?.detected === true, notes: cleanList(review.seeding?.notes, 3) },
    brandRisk: normalizeBrandRisk(review.brandRisk) ?? 'none',
    riskNotes: cleanList(review.riskNotes, 3),
  };
}

const score = { type: 'integer' } as const;
const notes = { type: 'array', items: { type: 'string' } } as const;

export const reviewJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['score', 'hook', 'specificity', 'platformFit', 'naturalness', 'languageOk', 'unsupportedClaims', 'issues', 'seeding', 'brandRisk', 'riskNotes'],
  properties: {
    score,
    hook: score,
    specificity: score,
    platformFit: score,
    naturalness: score,
    languageOk: { type: 'boolean' },
    unsupportedClaims: { type: 'array', items: { type: 'string' } },
    issues: { type: 'array', items: { type: 'string' } },
    seeding: {
      type: 'object',
      additionalProperties: false,
      required: ['detected', 'notes'],
      properties: { detected: { type: 'boolean' }, notes },
    },
    brandRisk: { type: 'string', enum: [...BRAND_RISKS] },
    riskNotes: notes,
  },
} as const;

/** "Sửa theo khuyến nghị" / "Viết lại": the earlier version's score and the fixes the operator asked for. */
export interface PreviousReview {
  score: number | null;
  fixes: readonly string[];
}

/** How many requested fixes the editor is shown, and how much of each. */
const PREVIOUS_FIXES_SHOWN = 10;
const PREVIOUS_FIX_LENGTH = 400;

/** "AI chấm 7/10" in a stored reason, or null when the draft was never scored. */
export function scoreFromReason(reason: string | null | undefined): number | null {
  const match = reason?.match(/AI chấm (\d{1,2})\/10/);
  return match ? clampScore(Number(match[1])) : null;
}

/**
 * What the editor checks besides quality: clumsy seeding (a community calls it
 * out as a disguised advert) and the risk the post creates for the company.
 * Either one fails the draft whatever its score.
 */
const SAFETY_REVIEW_RULES = [
  'seeding: clumsy seeding (astroturfing) is promotion a community would call out as a disguised advertisement. Set seeding.detected to true when the draft: pretends to be an unaffiliated customer or a neutral user while promoting the brand; contains fake or invented testimonials, reviews or "a friend tried it" stories; repeats the brand or product name, or forces it in where it does not help the reader; over-praises (superlatives, no downside or trade-off); stacks links or calls to action; uses an advertising tone in a technical community or forum; disparages competitors, by name or by implication; promotes the brand in a forum or community without saying the author is affiliated (the brand facts may give the disclosure line). One relevant, neutral mention of the brand, disclosed where needed, is not seeding. seeding.notes lists at most three short notes in Vietnamese that point to the sentence and say how to fix it; empty when nothing is detected.',
  'brandRisk: the risk for the company publishing the post (the brand in the brand facts: VPSTTT, a VPS and proxy provider) if it went out as is. Risks: false or exaggerated claims about its products; guarantees the brief and the brand facts do not back (cheapest, 100% uptime, unlimited, never blocked, undetectable, guaranteed results); explaining how to use proxies or VPS to break laws or website terms (evading bans or blocks, scraping against terms of service, spam, mass account creation, fraud); sensitive political, legal, religious or offensive content; anything that would embarrass the company if a reader took a screenshot. Rate it none (nothing), low (a small wording issue a reader would hardly notice), medium (must change before publishing) or high (must never be published). riskNotes lists at most three short notes in Vietnamese saying what to change; empty for none.',
  'A draft with seeding detected or a medium or high brandRisk fails whatever its score: keep score for the writing quality and report these problems in their own fields.',
  'Leaked internal text: a sentence that mentions a brief, a campaign, instructions, "this post/content", what is not confirmed, or a note to the operator ("before posting add…") would embarrass the company if published. Score such a draft 6 at most and name the sentence in issues with a natural replacement. A brand disclosure must be one natural first-person sentence (for example "Mình làm ở VPSTTT, bên cung cấp VPS và proxy."); a stiff label such as "brand-related content" or "this post is associated with the brand" is an issue, a natural one is not.',
];

/**
 * The editor's instructions. With the draft's published length, the editor
 * knows the room left, so it never asks for additions the post cannot hold.
 * With the previous review of a revised draft, it checks the requested fixes
 * first and scores the improvement, so fixing the chosen points raises the
 * score instead of drawing a new, contradicting list.
 */
export function reviewInstructions(contract: PlatformContract, publishedLength?: number, previous?: PreviousReview | null): string {
  const room = contract.maxChars && publishedLength !== undefined ? contract.maxChars - publishedLength : null;
  const fixes = (previous?.fixes ?? []).map((fix) => fix.trim().slice(0, PREVIOUS_FIX_LENGTH)).filter(Boolean).slice(0, PREVIOUS_FIXES_SHOWN);
  return [
    `You are a demanding but fair senior editor for ${contract.name}. Judge the draft as a real member of its audience would.`,
    'Score each criterion from 1 to 10:',
    '- hook: would a target reader stop at the first line?',
    '- specificity: concrete details, steps, numbers and examples instead of generic claims.',
    '- platformFit: format, length, tone and community norms of this destination; promotional posts in forums and communities score low.',
    '- naturalness: reads like a knowledgeable human, no filler or AI cliches.',
    'Score anchors for every number: 9-10 excellent, nothing worth changing; 8 ready to publish, only optional polish left; 7 ready to publish with one clear weakness; 5-6 part of it needs rewriting; 1-4 off-topic, misleading or in the wrong language. Optional polish never lowers a score.',
    contract.maxChars
      ? `Hard length limit: the published post has at most ${contract.maxChars} characters, counting hashtags, links and the source line the system adds${publishedLength !== undefined ? `; this draft has ${publishedLength}` : ''}. Judge it within that limit and never ask for additions that would not fit${room !== null && room < 0 ? `; it is ${-room} characters over, so one issue must ask to cut at least ${-room} characters` : room !== null ? `; only ${room} characters are left, so any fix that adds text must stay within them or say what to cut to make room` : ''}.`
      : '',
    'score is the overall quality from 1 to 10.',
    `languageOk is true only when the draft is written in ${LANGUAGE_NAMES[contract.language]}.`,
    'unsupportedClaims lists only statements about the brand, its products, prices, customers, performance, locations or offers that add facts the brief and the brand facts do not give. Whatever the brief or the brand facts state, even in a few words, is supported: if the brief says the brand offers VPS and proxies, "the brand has VPS and proxies" is supported. General, widely known technical knowledge is not an unsupported claim. Never list a statement you consider supported or partly supported.',
    'issues lists at most five short, actionable fixes written in Vietnamese for the operator, most important first: only changes that would raise the score, not matters of taste. Fixes must not contradict each other. Leave it empty for a score of 9 or 10. Do not rewrite the post.',
    ...SAFETY_REVIEW_RULES,
    previous && (fixes.length || previous.score !== null)
      ? [
          `This draft revises an earlier version${previous.score !== null ? ` that you scored ${previous.score}/10` : ''}.${fixes.length ? ` The operator asked the writer to fix:\n${fixes.map((fix) => `- ${fix}`).join('\n')}` : ''}`,
          `Check those fixes first. When they are made and nothing else got worse, the score must be ${previous.score !== null ? `higher than ${previous.score}` : 'raised accordingly'}. Never ask to undo a requested fix or for its opposite, and raise a new issue only for a real problem a reader would notice.`,
        ].join('\n')
      : '',
  ].filter(Boolean).join('\n');
}

/**
 * The editor's rubric, given to the writer up front: first drafts aim at the
 * same criteria they are scored on, so fewer need a rewrite.
 */
export function qualityInstructions(contract: PlatformContract, engine?: string): string {
  return [
    `Quality bar: an editor scores this ${contract.name} draft from 1 to 10 for hook, specificity, platform fit and naturalness. ${QUALITY_PASS_SCORE} is publishable; aim for 9.`,
    `- Hook: the first line makes a ${contract.name} reader stop: a concrete problem, result, number or sharp question. No greeting and no generic opener.`,
    '- Specificity: concrete details instead of adjectives: steps, commands or settings, numbers, before and after, one short real example. Every statement about the brand, its products, prices or results comes from the brief or the brand facts.',
    `- Platform fit: write the way ${contract.name} members write for each other. In forums, communities and developer sites, teach or ask something useful first and mention the brand at most once, where it is relevant; never write an advertisement.`,
    engine === 'stackexchange'
      ? '- Stack Exchange: one precise, answerable technical question: what you are trying to do, the exact commands or configuration tried, the expected and the actual result, versions. No promotion, no product links, no greeting or thanks.'
      : '',
    `- Naturalness: an experienced practitioner talking to peers, varied sentence length, no filler. Never use: ${CLICHES.map((phrase) => `"${phrase}"`).join(', ')}.`,
    ...WRITER_HYGIENE_RULES,
    `- Disclosure: when the post mentions the brand in a forum, community or developer site, add exactly one short, natural first-person sentence next to that mention saying who you are, for example ${DISCLOSURE_EXAMPLES[contract.language]} (use the brand facts' disclosure line instead when one is given). Never write a label or legal-sounding line such as "brand-related content", "this post is associated with", "this post is for …", "disclosure of brand relationship".`,
  ].filter(Boolean).join('\n');
}

/** A natural first-person disclosure, per post language (the brand facts' own line wins when set). */
const DISCLOSURE_EXAMPLES: Record<PlatformContract['language'], string> = {
  vi: '"Mình làm ở VPSTTT, bên cung cấp VPS và proxy, nên hay gặp đúng lỗi này."',
  en: '"Disclosure: I work at VPSTTT, a VPS and proxy provider, so we run into this a lot."',
};

/**
 * The brief and the brand facts carry instructions for the writer ("disclose the brand",
 * "do not claim IPv6 support", "set recommended=false for Server Fault"). Drafts that copied
 * them into the post read as leaked internal notes and were refused by the final approver.
 */
const WRITER_HYGIENE_RULES = [
  '- The brief and the brand facts are instructions and facts for you, not text for the reader. Follow them; never quote, copy or paraphrase them into the post. Never mention a brief, a campaign, a brand profile, instructions, a writer, an editor, "this post" or "this content".',
  '- Leave out anything the brief says is not confirmed or must not be claimed: do not mention it at all, not even to say it is unconfirmed.',
  '- Never put notes to the operator in the post (what to add, what is missing, "before posting…", "replace X with…"). When the brief does not fit this destination, set recommended to false, explain why in reason, and still write the cleanest post you can.',
];

/**
 * Higher is better: any draft that fits the character limit beats every draft
 * over it (the destination would refuse those), then a passing draft beats a
 * failing one, then the editor's score, then fewer machine issues.
 */
export function draftRank(passed: boolean, review: ContentReview | null, issues: readonly string[], overLimit = false): number {
  return (overLimit ? 0 : 10_000) + (passed ? 1_000 : 0) + (review?.score ?? 0) * 10 - issues.length;
}

export function reviewPassed(review: ContentReview): boolean {
  return review.score >= QUALITY_PASS_SCORE
    && review.languageOk
    && review.unsupportedClaims.length === 0
    && !review.seeding.detected
    && brandRiskAcceptable(review.brandRisk);
}

/** The seeding notes of a review that found seeding, with a generic one when the editor gave none. */
function seedingNotes(review: ContentReview): string[] {
  if (!review.seeding.detected) return [];
  return review.seeding.notes.length ? review.seeding.notes : ['bài đọc như quảng cáo trá hình'];
}

/** The risk notes of a review whose brand risk blocks publishing. */
function riskNotes(review: ContentReview): string[] {
  if (brandRiskAcceptable(review.brandRisk)) return [];
  return review.riskNotes.length ? review.riskNotes : [`mức ${BRAND_RISK_LABELS_VI[review.brandRisk]}`];
}

/** Seeding and company-risk problems in the stored reason ("Seeding: …", "Rủi ro cho công ty: …"). */
export function safetyProblems(review: ContentReview | null): string[] {
  if (!review) return [];
  return [
    ...seedingNotes(review).map((note) => `Seeding: ${note}`),
    ...riskNotes(review).map((note) => `Rủi ro cho công ty: ${note}`),
  ];
}

/**
 * The final verdict when the reviewer is also the final approver (both Claude
 * Opus by default): its last review of exactly the stored text, read with the
 * approver's bar. Machine issues still open (length, hashtags, clichés) refuse
 * it too. Reasons are Vietnamese, most important first; an approved post
 * keeps at most two points to watch.
 */
export function reviewVerdict(review: ContentReview, issues: readonly string[] = []): Pick<AiApproval, 'status' | 'score' | 'risk' | 'seeding' | 'reasons'> {
  const approved = issues.length === 0 && reviewPassed(review);
  const reasons = approved
    ? review.issues.slice(0, 2)
    : [
        ...safetyProblems(review),
        ...review.unsupportedClaims.map((claim) => `Thông tin chưa có căn cứ: ${claim}`),
        ...(review.languageOk ? [] : ['Bài viết sai ngôn ngữ của nơi đăng']),
        ...issues,
        ...review.issues,
        ...(review.score < QUALITY_PASS_SCORE ? [`Điểm ${review.score}/10, dưới mức đạt ${QUALITY_PASS_SCORE}/10`] : []),
      ];
  return {
    status: approved ? 'approved' : 'rejected',
    score: review.score,
    risk: review.brandRisk,
    seeding: review.seeding.detected,
    reasons: [...new Set(reasons)].slice(0, MAX_APPROVAL_REASONS),
  };
}

/** Feedback for the single rewrite, in the language the writer prompt uses. */
export function rewriteFeedback(issues: string[], review: ContentReview | null): string {
  const lines = [
    ...issues,
    // Seeding and company risk come first: they block publishing whatever the score.
    ...(review ? seedingNotes(review).map((note) => `Clumsy seeding (reads as a disguised advert), fix it: ${note}`) : []),
    ...(review ? riskNotes(review).map((note) => `Risk for the company (${review.brandRisk}), remove it: ${note}`) : []),
    ...(review?.unsupportedClaims.map((claim) => `Remove or ground this claim: ${claim}`) ?? []),
    ...(review?.issues ?? []),
  ];
  // The sub-scores tell the writer which criterion pulled the draft down.
  const scores = review && !reviewPassed(review)
    ? [`Editor scores (1-10): overall ${review.score}, hook ${review.hook}, specificity ${review.specificity}, platform fit ${review.platformFit}, naturalness ${review.naturalness}. Raise the lowest first.`]
    : [];
  return [...[...new Set(lines)].slice(0, 10), ...scores].map((line) => `- ${line}`).join('\n');
}

/**
 * The editor's final assessment of a draft, for the final approver: context,
 * not a verdict. `issues` are the machine checks still failing.
 */
export function reviewSummary(review: ContentReview | null, issues: readonly string[] = []): string {
  const machine = issues.length ? `Machine checks still failing: ${issues.join('; ')}.` : 'Machine checks: passed.';
  if (!review) return `The editor could not score this draft (reviewer unavailable). ${machine}`;
  return [
    `Editor score ${review.score}/10 (hook ${review.hook}, specificity ${review.specificity}, platform fit ${review.platformFit}, naturalness ${review.naturalness}); ${reviewPassed(review) ? 'passed' : 'not passed'}.`,
    review.languageOk ? '' : 'Wrong language.',
    review.unsupportedClaims.length ? `Unsupported claims: ${review.unsupportedClaims.join('; ')}.` : '',
    `Seeding: ${review.seeding.detected ? `detected${review.seeding.notes.length ? ` (${review.seeding.notes.join('; ')})` : ''}` : 'not detected'}.`,
    `Brand risk: ${review.brandRisk}${review.riskNotes.length ? ` (${review.riskNotes.join('; ')})` : ''}.`,
    review.issues.length ? `Open notes: ${review.issues.join('; ')}.` : '',
    machine,
  ].filter(Boolean).join('\n');
}
