import { z } from 'zod';
import { countChars, detectLanguage, PlatformContract } from '../platforms/platform-contract';
import { publishedLength } from '../platforms/post-text';

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
// modes do not all accept numeric bounds.
export const ReviewSchema = z.object({
  score: z.number(),
  hook: z.number(),
  specificity: z.number(),
  platformFit: z.number(),
  naturalness: z.number(),
  languageOk: z.boolean(),
  unsupportedClaims: z.array(z.string()),
  issues: z.array(z.string()),
});

export type ContentReview = z.infer<typeof ReviewSchema>;

const clampScore = (value: number) => Math.min(10, Math.max(1, Math.round(Number.isFinite(value) ? value : 1)));

export function clampReview(review: ContentReview): ContentReview {
  return {
    ...review,
    score: clampScore(review.score),
    hook: clampScore(review.hook),
    specificity: clampScore(review.specificity),
    platformFit: clampScore(review.platformFit),
    naturalness: clampScore(review.naturalness),
    unsupportedClaims: review.unsupportedClaims.map((claim) => claim.trim()).filter(Boolean).slice(0, 5),
    issues: review.issues.map((issue) => issue.trim()).filter(Boolean).slice(0, 5),
  };
}

const score = { type: 'integer' } as const;

export const reviewJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['score', 'hook', 'specificity', 'platformFit', 'naturalness', 'languageOk', 'unsupportedClaims', 'issues'],
  properties: {
    score,
    hook: score,
    specificity: score,
    platformFit: score,
    naturalness: score,
    languageOk: { type: 'boolean' },
    unsupportedClaims: { type: 'array', items: { type: 'string' } },
    issues: { type: 'array', items: { type: 'string' } },
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
  ].filter(Boolean).join('\n');
}

/**
 * Higher is better: any draft that fits the character limit beats every draft
 * over it (the destination would refuse those), then a passing draft beats a
 * failing one, then the editor's score, then fewer machine issues.
 */
export function draftRank(passed: boolean, review: ContentReview | null, issues: readonly string[], overLimit = false): number {
  return (overLimit ? 0 : 10_000) + (passed ? 1_000 : 0) + (review?.score ?? 0) * 10 - issues.length;
}

export function reviewPassed(review: ContentReview): boolean {
  return review.score >= QUALITY_PASS_SCORE && review.languageOk && review.unsupportedClaims.length === 0;
}

/** Feedback for the single rewrite, in the language the writer prompt uses. */
export function rewriteFeedback(issues: string[], review: ContentReview | null): string {
  const lines = [
    ...issues,
    ...(review?.unsupportedClaims.map((claim) => `Remove or ground this claim: ${claim}`) ?? []),
    ...(review?.issues ?? []),
  ];
  // The sub-scores tell the writer which criterion pulled the draft down.
  const scores = review && !reviewPassed(review)
    ? [`Editor scores (1-10): overall ${review.score}, hook ${review.hook}, specificity ${review.specificity}, platform fit ${review.platformFit}, naturalness ${review.naturalness}. Raise the lowest first.`]
    : [];
  return [...[...new Set(lines)].slice(0, 10), ...scores].map((line) => `- ${line}`).join('\n');
}
