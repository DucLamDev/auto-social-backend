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
