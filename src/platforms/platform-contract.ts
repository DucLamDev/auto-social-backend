import { EXTENSION_RECIPES, ExtensionEngine } from '../connectors/extension/extension-delivery';
import { extensionFlowForPlatform } from '../connectors/extension/extension-flows';
import { AudienceLanguageSetting, PLATFORM_CATALOG, PlatformGroupKey } from './platform-catalog';

export type AudienceLanguage = 'vi' | 'en';
/** What the destination renders: Markdown, plain paragraphs, or HTML (WordPress/Blogger content field). */
export type TextFormat = 'markdown' | 'plain' | 'html';
/**
 * inline: hashtags belong inside the body text (short-form social);
 * appended: the connector appends the hashtag list itself (Instagram);
 * tags: the list is sent as separate tags/labels and never printed in the body.
 */
export type HashtagMode = 'inline' | 'appended' | 'tags';
/**
 * graphemes: user-perceived characters; x: X weighted length (every link,
 * also a bare domain X links, = 23; non-Latin code points = 2); mastodon:
 * graphemes, with every http(s) link counted as 23 whatever its length.
 */
export type CharCounting = 'graphemes' | 'x' | 'mastodon';

export interface PlatformContract {
  slug: string;
  name: string;
  language: AudienceLanguage;
  format: TextFormat;
  maxChars?: number;
  counting: CharCounting;
  hashtagMode: HashtagMode;
  maxHashtags: number;
  titleRequired: boolean;
  /** Length the AI aims for and the quality check enforces. */
  titleMaxChars: number;
  /** Length the destination accepts; titles are cut only when this is known. */
  titleHardLimit?: number;
}

const MARKDOWN_ENGINES = new Set<ExtensionEngine>(['discourse', 'devto', 'lemmy', 'discuit', 'stackexchange', 'differ']);

const PLATFORM_FORMAT: Record<string, TextFormat> = {
  wordpress: 'html',
  blogger: 'html',
  devto: 'markdown',
  discourse: 'markdown',
  discord: 'markdown',
};

// Limits enforced by the destination or by the extension before it submits.
const ENGINE_MAX_CHARS: Partial<Record<ExtensionEngine, number>> = { bluesky: 300, mastodon: 500, linkedin: 3000, pixelfed: 500, dailydev: 20_000 };
const PLATFORM_MAX_CHARS: Record<string, number> = {
  instagram: 2200,
  linkedin: 3000,
  mastodon: 500,
  'vivaldi-social': 500,
};

const INLINE_HASHTAG_LIMITS: Record<string, number> = {
  x: 2,
  threads: 1,
  bluesky: 2,
  mastodon: 3,
  'mastodon-social': 3,
  'vivaldi-social': 3,
  linkedin: 3,
  minds: 3,
  mewe: 2,
  'pixelfed-social': 5,
};
const TAG_LIMITS: Record<string, number> = { devto: 4, instagram: 5 };
const TITLE_LIMITS: Partial<Record<ExtensionEngine, number>> = { reddit: 300, stackexchange: 150, xenforo: 150, discourse: 150, phpbb: 150, dailydev: 250, lemmy: 200, disqus: 175 };
const TITLE_REQUIRED_PLATFORMS = new Set(['wordpress', 'blogger', 'devto', 'discourse']);
/** Mastodon servers (API or Chrome extension): links count as 23 characters. */
const MASTODON_PLATFORMS = new Set(['mastodon', 'mastodon-social', 'vivaldi-social']);

const GROUP_DEFAULT_FORMAT: Record<PlatformGroupKey, TextFormat> = {
  SOCIAL: 'plain',
  BLOGGING: 'markdown',
  COMMUNITY: 'plain',
  FORUM: 'markdown',
  DEVELOPER: 'markdown',
  MEDIA: 'plain',
  COMMERCE: 'plain',
  EVENT: 'plain',
};

export interface ContractOptions {
  /** Extension engine actually used by the account, when known. */
  engine?: ExtensionEngine;
  /** Text whose language decides `auto` destinations (the brief or source). */
  sourceText?: string;
  /** Owner-configured language overrides from the brand profile. */
  defaultLanguage?: AudienceLanguage;
  platformLanguages?: Record<string, AudienceLanguage>;
}

export function platformContract(slug: string, options: ContractOptions = {}): PlatformContract {
  const entry = PLATFORM_CATALOG.find((platform) => platform.slug === slug);
  const group: PlatformGroupKey = entry?.groupKey ?? 'SOCIAL';
  const engine = options.engine ?? extensionFlowForPlatform(slug)?.engine;
  const format = engine
    ? (MARKDOWN_ENGINES.has(engine) ? 'markdown' : 'plain')
    : PLATFORM_FORMAT[slug] ?? GROUP_DEFAULT_FORMAT[group];
  const limits = [entry?.capability.maxText, PLATFORM_MAX_CHARS[slug], engine ? ENGINE_MAX_CHARS[engine] : undefined]
    .filter((value): value is number => typeof value === 'number' && value > 0);
  const hashtagMode: HashtagMode = slug === 'instagram' ? 'appended' : slug in INLINE_HASHTAG_LIMITS ? 'inline' : 'tags';
  const recipe = engine ? EXTENSION_RECIPES[engine] : undefined;
  const titleRequired = recipe
    ? recipe.titleSelectors.length > 0
    : TITLE_REQUIRED_PLATFORMS.has(slug) || group === 'BLOGGING' || group === 'FORUM' || group === 'DEVELOPER';
  return {
    slug,
    name: entry?.name ?? slug,
    language: resolveLanguage(options.platformLanguages?.[slug] ?? entry?.audienceLanguage ?? 'auto', options),
    format,
    ...(limits.length ? { maxChars: Math.min(...limits) } : {}),
    counting: slug === 'x' ? 'x' : MASTODON_PLATFORMS.has(slug) || engine === 'mastodon' ? 'mastodon' : 'graphemes',
    hashtagMode,
    maxHashtags: hashtagMode === 'inline' ? INLINE_HASHTAG_LIMITS[slug]! : TAG_LIMITS[slug] ?? 5,
    titleRequired,
    titleMaxChars: (engine ? TITLE_LIMITS[engine] : undefined) ?? 150,
    ...(engine && TITLE_LIMITS[engine] ? { titleHardLimit: TITLE_LIMITS[engine] } : {}),
  };
}

function resolveLanguage(setting: AudienceLanguageSetting, options: ContractOptions): AudienceLanguage {
  if (setting !== 'auto') return setting;
  if (options.defaultLanguage) return options.defaultLanguage;
  const detected = detectLanguage(options.sourceText ?? '');
  return detected === 'unknown' ? 'vi' : detected;
}

// Letters that only occur in Vietnamese orthography (tone marks, ă/â/ê/ô/ơ/ư/đ).
const VIETNAMESE_LETTERS = /[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]/giu;
const LETTERS = /\p{L}/gu;

/** Rough language check, only strong enough to catch a post written in the wrong language. */
export function detectLanguage(text: string): AudienceLanguage | 'unknown' {
  const sample = text.replace(URL_PATTERN, ' ').normalize('NFC');
  const letters = sample.match(LETTERS)?.length ?? 0;
  if (letters < 20) return 'unknown';
  const vietnamese = sample.match(VIETNAMESE_LETTERS)?.length ?? 0;
  const ratio = vietnamese / letters;
  if (ratio >= 0.04) return 'vi';
  if (ratio <= 0.005) return 'en';
  return 'unknown';
}

const URL_PATTERN = /https?:\/\/[^\s<>()]+/g;
/** Sentence punctuation right after a link is text, not part of the link. */
const LINK_TRAILING_PUNCTUATION = /[.,;:!?'"…»”’]+$/u;
/** Stands for one shortened link while the rest of the text is counted. */
const LINK_PLACEHOLDER = '\u0000';
const SHORT_LINK_LENGTH = 23;

/**
 * A domain written without http(s), as twitter-text finds it: not glued to a
 * word, an e-mail address, a mention or a path, optionally with port and path.
 */
const BARE_DOMAIN = /(?<![A-Za-z0-9@＠$#＃_./-])((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+)([a-z]{2,24})(?![a-z0-9@+-])(?::\d{1,5})?([/?][^\s<>()]*)?/gi;
// Generic TLDs X links without a protocol. Kept to common ones on purpose: an
// unknown suffix (Node.js, config.yml) stays plain text, as on X.
const X_GENERIC_TLDS = new Set([
  'com', 'net', 'org', 'info', 'biz', 'edu', 'gov', 'mil', 'int', 'app', 'dev', 'xyz', 'tech', 'cloud', 'online', 'site',
  'website', 'store', 'shop', 'blog', 'news', 'page', 'live', 'pro', 'top', 'vip', 'link', 'club', 'space', 'digital',
  'email', 'host', 'hosting', 'network', 'software', 'solutions', 'systems', 'tools', 'works', 'world', 'academy',
  'agency', 'asia', 'mobi', 'name', 'travel', 'jobs', 'tel', 'aero', 'coop', 'art', 'design', 'media', 'studio',
  'today', 'center', 'company', 'group', 'team', 'social', 'chat', 'run', 'one', 'plus', 'zone', 'life', 'fun',
  'guru', 'ninja', 'codes', 'engineering', 'services', 'support', 'technology', 'education', 'consulting', 'marketing',
]);

/**
 * Whether X turns a bare domain into a link: any domain under a known generic
 * TLD; under a country code (vpsttt.vn, socket.io) only with a subdomain or a
 * path, exactly like twitter-text, so "README.md" stays text.
 */
function xLinksBareDomain(labels: string, tld: string, path: string | undefined): boolean {
  const suffix = tld.toLowerCase();
  if (X_GENERIC_TLDS.has(suffix)) return true;
  if (suffix.length !== 2) return false;
  return Boolean(path) || labels.split('.').filter(Boolean).length >= 2 || `${labels}${suffix}`.toLowerCase() === 't.co';
}

/** The text with every link the destination shortens replaced by one placeholder each. */
function replaceLinks(text: string, bareDomains: boolean): { text: string; links: number } {
  let links = 0;
  const shorten = (match: string) => {
    links += 1;
    return LINK_PLACEHOLDER + (LINK_TRAILING_PUNCTUATION.exec(match)?.[0] ?? '');
  };
  let replaced = text.replace(URL_PATTERN, shorten);
  if (bareDomains) {
    replaced = replaced.replace(BARE_DOMAIN, (match: string, labels: string, tld: string, path: string | undefined) => (
      xLinksBareDomain(labels, tld, path) ? shorten(match) : match
    ));
  }
  return { text: replaced, links };
}

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const graphemeCount = (text: string) => [...graphemes.segment(text)].length;

export function countChars(text: string, counting: CharCounting): number {
  if (counting === 'graphemes') return graphemeCount(text);
  if (counting === 'mastodon') {
    // Mastodon counts graphemes and every http(s) link as 23, however long;
    // a domain without the protocol counts as typed.
    const { text: rest, links } = replaceLinks(text, false);
    // Each placeholder is a grapheme of its own (a control character).
    return graphemeCount(rest) - links + links * SHORT_LINK_LENGTH;
  }
  // https://docs.x.com/resources/fundamentals/counting-characters
  const { text: rest, links } = replaceLinks(text, true);
  let total = links * SHORT_LINK_LENGTH;
  for (const char of rest.normalize('NFC')) {
    if (char === LINK_PLACEHOLDER) continue;
    const code = char.codePointAt(0)!;
    const light = code <= 4351 || (code >= 8192 && code <= 8205) || (code >= 8208 && code <= 8223) || (code >= 8242 && code <= 8247);
    total += light ? 1 : 2;
  }
  return total;
}
