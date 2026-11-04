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

/**
 * The editor's instructions. With the draft's published length, the editor
 * knows the hard limit too, so it never asks for additions the post has no
 * room for.
 */
export function reviewInstructions(contract: PlatformContract, publishedLength?: number): string {
  const over = contract.maxChars && publishedLength !== undefined ? publishedLength - contract.maxChars : 0;
  return [
    `You are a strict senior editor for ${contract.name}. Judge the draft as a real member of its audience would.`,
    'Score each criterion from 1 to 10:',
    '- hook: would a target reader stop at the first line?',
    '- specificity: concrete details, steps, numbers and examples instead of generic claims.',
    '- platformFit: format, length, tone and community norms of this destination; promotional posts in forums and communities score low.',
    '- naturalness: reads like a knowledgeable human, no filler or AI cliches.',
    contract.maxChars
      ? `Hard length limit: the published post has at most ${contract.maxChars} characters, counting hashtags, links and the source line the system adds${publishedLength !== undefined ? `; this draft has ${publishedLength}` : ''}. Judge it within that limit and never ask for additions that would not fit${over > 0 ? `; it is ${over} characters over, so one issue must ask to cut at least ${over} characters` : ''}.`
      : '',
    'score is the overall quality from 1 to 10; 7 means ready to publish without edits.',
    `languageOk is true only when the draft is written in ${LANGUAGE_NAMES[contract.language]}.`,
    'unsupportedClaims lists statements about the brand, its products, prices, customers, performance or offers that are not supported by the brief or the brand facts. General, widely known technical knowledge is not an unsupported claim.',
    'issues lists at most five short, actionable fixes written in Vietnamese for the operator. Do not rewrite the post.',
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
