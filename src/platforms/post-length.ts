import { EXTENSION_ENGINES, isExtensionDelivery, type ExtensionEngine } from '../connectors/extension/extension-delivery';
import { countChars, platformContract, type CharCounting, type PlatformContract } from './platform-contract';
import { markdownToPlain, publishedLength, type PostTextInput } from './post-text';

/** A post as one destination will count it: its text, the account's engine and the source link added to it. */
export interface PostLengthInput extends PostTextInput {
  platformSlug: string;
  /** Extension engine the account posts with; the platform's default flow when absent. */
  engine?: ExtensionEngine;
  canonicalUrl?: string | null;
}

export interface PostLength {
  /** Characters the destination counts, including the source line and hashtags the system adds. */
  length: number;
  /** The destination's limit, or null when it has none. */
  maxChars: number | null;
  over: boolean;
  counting: CharCounting;
}

export function contractFor(input: Pick<PostLengthInput, 'platformSlug' | 'engine' | 'body'>): PlatformContract {
  return platformContract(input.platformSlug, { ...(input.engine ? { engine: input.engine } : {}), sourceText: input.body });
}

/**
 * The one length check every path uses (generation, approval, editing, the
 * extension task, API connectors), so a post that fits here fits on the site.
 */
export function checkPostLength(input: PostLengthInput): PostLength {
  const contract = contractFor(input);
  const length = publishedLength(input, contract, input.canonicalUrl ?? null);
  const maxChars = contract.maxChars ?? null;
  return { length, maxChars, over: maxChars !== null && length > maxChars, counting: contract.counting };
}

/**
 * Length of text a connector sends exactly as given (nothing appended),
 * counted the way `platformSlug` counts it.
 */
export function checkTextLength(platformSlug: string, text: string): PostLength {
  const contract = platformContract(platformSlug, { sourceText: text });
  const length = countChars(text, contract.counting);
  const maxChars = contract.maxChars ?? null;
  return { length, maxChars, over: maxChars !== null && length > maxChars, counting: contract.counting };
}

/** Vietnamese message for an over-limit post, shown to the operator and returned as a 400. */
export function postLengthMessage(platformName: string, result: PostLength): string {
  return `Bài ${platformName} dài ${result.length}/${result.maxChars} ký tự, vượt giới hạn của nền tảng. Rút gọn trước khi duyệt hoặc đăng.`;
}

/** The extension engine an account posts with, or undefined when it publishes through the platform's API. */
export function deliveryEngine(settings: unknown): ExtensionEngine | undefined {
  if (!isExtensionDelivery(settings)) return undefined;
  const engine = (settings as Record<string, unknown>).extensionEngine;
  return typeof engine === 'string' && (EXTENSION_ENGINES as readonly string[]).includes(engine) ? engine as ExtensionEngine : undefined;
}

// ---- Fitting a post into its limit ---------------------------------------------

const HASHTAG = /^#[\p{L}\p{N}_]+$/u;
/** Ends a sentence or an emoji-closed line, after which a hashtag block stands apart. */
const TAG_BLOCK_LEAD = /[.!?…:)\]"'»”\p{Extended_Pictographic}]$/u;
/** End of a sentence (closing quotes/brackets included) followed by a space, or a line break. */
const SENTENCE_END = /[.!?…]+["'»”’)\]]*(?=\s)|(?=\n)/gu;
const WORD_GAP = /\s+/g;
const CUT_TRAILING = /[\s,;:–—-]+$/u;
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

interface TrailingTags {
  /** The body without its closing hashtag block. */
  text: string;
  /** What separated the text from the block (a space or a blank line). */
  separator: string;
  tags: string[];
}

/**
 * The hashtags closing a post ("… cho bạn. #vps #linux"), when they stand
 * apart from the last sentence. A tag inside a sentence ("chạy #docker") is
 * part of it and never removed.
 */
function trailingTags(body: string): TrailingTags {
  const trimmed = body.trimEnd();
  const tokens = trimmed.split(/(\s+)/);
  let index = tokens.length - 1;
  const tags: string[] = [];
  while (index >= 0 && HASHTAG.test(tokens[index]!)) {
    tags.unshift(tokens[index]!);
    index -= 2;
  }
  if (!tags.length || index < 0) return { text: trimmed, separator: '', tags: [] };
  const text = tokens.slice(0, index + 1).join('');
  const separator = tokens[index + 1] ?? ' ';
  if (!separator.includes('\n') && !TAG_BLOCK_LEAD.test(text)) return { text: trimmed, separator: '', tags: [] };
  return { text, separator, tags };
}

/** Where a shortened text may end, as offsets into it, shortest first; `ellipsis` marks a cut mid-sentence. */
interface Cuts { ends: number[]; ellipsis: boolean }

function sentenceCuts(text: string): Cuts {
  const start = text.search(/\S/);
  const full = text.trimEnd().length;
  const ends = [...text.matchAll(SENTENCE_END)].map((match) => match.index + match[0].length)
    .filter((end, index, all) => end > start && end < full && end !== all[index - 1]);
  return { ends, ellipsis: false };
}

/** Before every space after the first word: never inside a word or a link. */
function wordCuts(text: string): Cuts {
  const start = text.search(/[\p{L}\p{N}]/u);
  return { ends: [...text.matchAll(WORD_GAP)].map((match) => match.index).filter((end) => start >= 0 && end > start), ellipsis: true };
}

/** Last resort for text without usable spaces: whole graphemes only, so no emoji or accent is split. */
function graphemeCuts(text: string): Cuts {
  return { ends: [...graphemes.segment(text)].map(({ index, segment }) => index + segment.length), ellipsis: true };
}

function cutAt(text: string, end: number, ellipsis: boolean): string {
  const kept = text.slice(0, end).trimEnd();
  if (!ellipsis) return kept;
  const clean = kept.replace(CUT_TRAILING, '');
  // "…" glued to a link would become part of it.
  return `${clean}${/(^|\s)\S*\/\S*$/.test(clean) ? ' ' : ''}…`;
}

/** Largest index in `0..count-1` whose candidate fits; shorter candidates fit more easily. */
function largestFitting(count: number, fits: (index: number) => boolean): number {
  let low = 0;
  let high = count - 1;
  let found = -1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (fits(middle)) { found = middle; low = middle + 1; } else high = middle - 1;
  }
  // Markdown removal can make lengths slightly non-monotonic: confirm, else walk down.
  for (let index = found; index >= 0; index -= 1) if (fits(index)) return index;
  return -1;
}

/**
 * A version of the post whose published length fits `contract.maxChars`,
 * changing as little as possible, in this order:
 * 1. drop closing hashtags, last first, keeping at least one;
 * 2. no source line when the body already links to `canonicalUrl` (rendering never repeats it);
 * 3. end the body after the last whole sentence that fits, keeping one hashtag;
 * 4. otherwise after the last whole word that fits, with "…";
 * 5. the same without hashtags if even that does not fit.
 * Returns the input unchanged when it already fits or the destination has no limit.
 */
export function fitToLimit(input: PostTextInput, contract: PlatformContract, canonicalUrl?: string | null): PostTextInput {
  const maxChars = contract.maxChars;
  if (!maxChars) return input;
  const fits = (candidate: PostTextInput) => publishedLength(candidate, contract, canonicalUrl) <= maxChars;
  if (fits(input)) return input;
  // Work on the text the destination gets, so a cut never leaves half a Markdown mark.
  const body = contract.format === 'plain' ? markdownToPlain(input.body) : input.body.trim();
  const appendedMode = contract.hashtagMode === 'appended';
  const block = contract.hashtagMode === 'inline' ? trailingTags(body) : { text: body, separator: '', tags: [] };
  const tagCount = appendedMode ? input.hashtags.length : block.tags.length;
  const post = (text: string, keep: number): PostTextInput => {
    if (appendedMode) return { title: input.title, body: text, hashtags: input.hashtags.slice(0, keep) };
    // A dropped closing tag must not come back as a "missing" tag added by rendering.
    const dropped = new Set(block.tags.slice(keep).map((tag) => tag.slice(1).toLowerCase()));
    const kept = block.tags.slice(0, keep);
    return {
      title: input.title,
      body: kept.length ? `${text}${block.separator}${kept.join(' ')}` : text,
      hashtags: input.hashtags.filter((tag) => !dropped.has(tag.trim().replace(/^#+/, '').toLowerCase())),
    };
  };
  // 1. Fewer hashtags, the text untouched.
  for (let keep = tagCount - 1; keep >= 1; keep -= 1) {
    const candidate = post(block.text, keep);
    if (fits(candidate)) return candidate;
  }
  // 3–5. Shorter text: whole sentences, then whole words, then graphemes; with one hashtag, then none.
  for (const keep of tagCount ? [1, 0] : [0]) {
    for (const cuts of [sentenceCuts(block.text), wordCuts(block.text), graphemeCuts(block.text)]) {
      const candidate = (index: number) => post(cutAt(block.text, cuts.ends[index]!, cuts.ellipsis), keep);
      const index = largestFitting(cuts.ends.length, (at) => fits(candidate(at)));
      if (index >= 0) return candidate(index);
    }
  }
  // A limit shorter than the source line itself: nothing fits, keep the least text.
  return post('', 0);
}
