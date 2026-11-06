import { z } from 'zod';
import { PLATFORM_CATALOG } from '../platforms/platform-catalog';
import { platformContract } from '../platforms/platform-contract';
import { CLICHES } from './content-quality';

/** How many ideas one request returns, and the limits of what is shown to the operator. */
export const SUGGESTION_COUNT = 4;
export const MAX_SUGGESTION_PLATFORMS = 50;
export const MAX_SUGGESTION_HINT = 300;
const NAME_MAX = 80;
const BRIEF_MAX = 2_000;
const NOTE_MAX = 300;

export interface CampaignSuggestion {
  name: string;
  brief: string;
  angle: string;
  whyEffective: string;
  /** How the one brief is adapted to each kind of chosen platform (forums, short feeds, blogs…). */
  platformFit: string;
  /** The reviewer's scores (absent when scoring was unavailable). */
  review?: SuggestionReview;
  /** The best-scored idea of the batch. */
  recommended?: boolean;
}

/** An independent reviewer's 1-10 scores of one idea for the chosen platforms. */
export interface SuggestionReview {
  score: number;
  platformFit: number;
  readerValue: number;
  brandFit: number;
  engagement: number;
  /** The main weakness or risk, one short sentence. */
  weakness: string;
}

/** One earlier campaign, with how its drafts were scored and how many went out. */
export interface PastCampaign {
  name: string;
  brief: string;
  drafts: number;
  averageScore: number | null;
  published: number;
}

/** Average editor score of earlier drafts per platform (platform name → score). */
export type PlatformScores = Record<string, { drafts: number; averageScore: number }>;

const SuggestionSchema = z.object({
  name: z.string(),
  brief: z.string(),
  angle: z.string(),
  whyEffective: z.string(),
  platformFit: z.string(),
});
export const SuggestionsSchema = z.object({ suggestions: z.array(SuggestionSchema) });
export type SuggestionsOutput = z.infer<typeof SuggestionsSchema>;

const text = { type: 'string' } as const;
export const suggestionsJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['suggestions'],
  properties: {
    suggestions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'brief', 'angle', 'whyEffective', 'platformFit'],
        properties: { name: text, brief: text, angle: text, whyEffective: text, platformFit: text },
      },
    },
  },
} as const;

const ScoresSchema = z.object({
  scores: z.array(z.object({
    index: z.number(), score: z.number(), platformFit: z.number(), readerValue: z.number(), brandFit: z.number(), engagement: z.number(), weakness: z.string(),
  })),
});
export type ScoresOutput = z.infer<typeof ScoresSchema>;
export { ScoresSchema };
const integer = { type: 'integer' } as const;
export const scoresJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['scores'],
  properties: {
    scores: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['index', 'score', 'platformFit', 'readerValue', 'brandFit', 'engagement', 'weakness'],
        properties: { index: integer, score: integer, platformFit: integer, readerValue: integer, brandFit: integer, engagement: integer, weakness: text },
      },
    },
  },
} as const;

/** Catalogue facts of the chosen platforms the strategist plans for; unknown slugs are dropped. */
export function suggestionPlatforms(slugs: readonly string[]) {
  return [...new Set(slugs)].flatMap((slug) => {
    const entry = PLATFORM_CATALOG.find((platform) => platform.slug === slug);
    if (!entry) return [];
    const contract = platformContract(slug);
    return [{ slug, name: entry.name, group: entry.groupKey, rule: entry.promptRule, maxChars: contract.maxChars ?? null }];
  });
}

/** The strategist's instructions: ideas that fit the company, every chosen platform, and work. */
export function suggestionInstructions(today: string): string {
  return [
    'You are the content strategist of the company described in the input. Propose campaign ideas for its social and community channels.',
    `Return exactly ${SUGGESTION_COUNT} ideas. Today is ${today}; use the season or a timely technical topic only when it genuinely fits.`,
    'What makes an idea effective here:',
    '- It starts from a real problem or question the target readers have (performance, cost, security, setup, troubleshooting, migration), and the posts teach something concrete: steps, commands, settings, numbers, a checklist or a before/after.',
    '- The company and its product appear as the natural solution or tool, at most once per post; never an advertisement. Forums, communities and developer sites accept knowledge, questions and experience, not promotion.',
    '- Every idea must work on ALL the chosen platforms at once: the same brief goes to each of them and the writer adapts it per platform. Choose topics every chosen audience cares about; never propose an idea that suits only some of them. When the chosen platforms mix forums or Q&A sites, short social feeds and blogs, the topic must work as a discussion or question on the forums, a short tip with one takeaway on the feeds and a how-to on the blogs, and must respect the strictest rule among them (for example a Q&A site needs a real, answerable technical question).',
    '- The ideas differ from each other (for example a tutorial, a troubleshooting story, a comparison or checklist, a question that starts a discussion) and do not repeat the earlier campaigns. Lean toward the kinds of brief that scored and published best; avoid the angles of low-scoring ones.',
    'Truthfulness: products, prices, offers, numbers and customers come only from the brand facts and the earlier briefs. Never invent discounts, statistics, benchmarks or testimonials. General, widely known technical knowledge is fine.',
    'Write everything in Vietnamese except product names and technical terms.',
    `Fields: name is a short campaign name (at most ${NAME_MAX} characters). brief is the one instruction the AI writer receives for every chosen platform, 4 to 8 sentences: the topic and target reader, the reader's problem, 3 to 5 concrete points (enough to expand into a forum post and to cut down to a short post), which product or service of the company to tie in and how, the call to action, and what to avoid; no instruction that fits only one platform. angle is the format in a few words. whyEffective is one or two sentences for the operator on why it will perform on these platforms. platformFit is one or two sentences on how this idea is used on each kind of chosen platform (name them, for example "Diễn đàn: …; Bluesky, Mastodon: …").`,
    `Never use: ${CLICHES.map((phrase) => `"${phrase}"`).join(', ')}.`,
  ].join('\n');
}

/** Everything the strategist knows: the company, the chosen platforms, past results and the operator's hint. */
export function suggestionInput(input: {
  brandBlock: string;
  platforms: ReturnType<typeof suggestionPlatforms>;
  past: readonly PastCampaign[];
  platformScores: PlatformScores;
  hint?: string;
}): string {
  const platforms = input.platforms.map((platform) => `- ${platform.name} (${platform.group.toLowerCase()}${platform.maxChars ? `, at most ${platform.maxChars} characters` : ''}): ${platform.rule}`);
  const past = input.past.map((campaign) => `- "${campaign.name}": ${campaign.brief.replace(/\s+/g, ' ').slice(0, 400)} (drafts: ${campaign.drafts}, average editor score: ${campaign.averageScore ?? 'n/a'}/10, published: ${campaign.published})`);
  const scores = Object.entries(input.platformScores).map(([name, score]) => `- ${name}: ${score.averageScore}/10 over ${score.drafts} drafts`);
  return [
    input.brandBlock || '<brand_facts>\nNo brand profile is configured. Infer the company, its products and audience only from the earlier campaign briefs below.\n</brand_facts>',
    `Chosen platforms (every idea must fit all ${input.platforms.length} of them):\n${platforms.join('\n')}`,
    past.length ? `Earlier campaigns (newest first):\n${past.join('\n')}` : 'There are no earlier campaigns yet.',
    scores.length ? `Editor scores of earlier drafts per platform (7 is publishable):\n${scores.join('\n')}` : '',
    input.hint?.trim() ? `The operator wants ideas about: ${input.hint.trim().slice(0, MAX_SUGGESTION_HINT)}` : '',
  ].filter(Boolean).join('\n\n');
}

/** Trims and bounds the ideas; empty or duplicate ideas are dropped. */
export function cleanSuggestions(output: SuggestionsOutput): CampaignSuggestion[] {
  const seen = new Set<string>();
  const clean = (value: string, max: number) => value.replace(/\s+\n/g, '\n').trim().slice(0, max);
  return output.suggestions.flatMap((idea) => {
    const name = clean(idea.name, NAME_MAX).replace(/\s+/g, ' ');
    const brief = clean(idea.brief, BRIEF_MAX);
    if (name.length < 3 || brief.length < 20 || seen.has(name.toLowerCase())) return [];
    seen.add(name.toLowerCase());
    return [{ name, brief, angle: clean(idea.angle, NOTE_MAX), whyEffective: clean(idea.whyEffective, NOTE_MAX), platformFit: clean(idea.platformFit, NOTE_MAX) }];
  }).slice(0, SUGGESTION_COUNT);
}

/**
 * The reviewer is a separate request from the strategist, so an idea is not
 * scored by the model that just wrote it. It ranks the ideas against each other
 * for these platforms and this company, using the earlier campaigns' results.
 */
export function scoringInstructions(): string {
  return [
    'You are a demanding head of content. Score each campaign idea for the company and the chosen platforms described in the input, as the expected result if the campaign runs on all of them.',
    'Criteria, each an integer from 1 to 10:',
    '- platformFit: the idea works on every chosen platform at once and respects the strictest of their rules; an idea that reads as promotion on forums or communities scores low.',
    '- readerValue: it solves a real, specific problem of the target readers with concrete steps, commands, numbers or a checklist.',
    "- brandFit: the company's product appears naturally as the solution, and every brand claim is supported by the brand facts or the earlier briefs.",
    '- engagement: readers of these platforms are likely to read it to the end, save, answer or share it; take into account what scored and published well before.',
    'score is the overall expected result from 1 to 10, not the average of the criteria. Use the full range and compare the ideas with each other: do not give two ideas the same score unless they are truly equal.',
    'weakness is one short sentence in Vietnamese: the main weakness or risk of the idea.',
    'Return one entry per idea, with index equal to the number shown before the idea.',
  ].join('\n');
}

export function scoringInput(context: string, suggestions: readonly CampaignSuggestion[]): string {
  const ideas = suggestions.map((idea, index) => `[${index}] ${idea.name}\nAngle: ${idea.angle}\nBrief: ${idea.brief}\nPer platform: ${idea.platformFit}`);
  return `${context}\n\nCampaign ideas to score:\n${ideas.join('\n\n')}`;
}

const clampScore = (value: number) => Math.min(10, Math.max(1, Math.round(Number.isFinite(value) ? value : 1)));

/** Attaches the reviewer's scores, sorts the ideas best first and marks the best one; ideas without a score keep their place at the end. */
export function applySuggestionScores(suggestions: readonly CampaignSuggestion[], output: ScoresOutput): CampaignSuggestion[] {
  const byIndex = new Map(output.scores.filter((entry) => Number.isInteger(entry.index)).map((entry) => [entry.index, entry]));
  const scored = suggestions.map((idea, index) => {
    const entry = byIndex.get(index);
    if (!entry) return { ...idea };
    return { ...idea, review: {
      score: clampScore(entry.score), platformFit: clampScore(entry.platformFit), readerValue: clampScore(entry.readerValue),
      brandFit: clampScore(entry.brandFit), engagement: clampScore(entry.engagement), weakness: entry.weakness.trim().slice(0, NOTE_MAX),
    } };
  });
  const ranked = scored.map((idea, index) => ({ idea, index }))
    .sort((a, b) => (b.idea.review?.score ?? -1) - (a.idea.review?.score ?? -1) || a.index - b.index)
    .map(({ idea }) => idea);
  if (ranked[0]?.review) ranked[0] = { ...ranked[0], recommended: true };
  return ranked;
}
