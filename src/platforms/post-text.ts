import { ExtensionEngine } from '../connectors/extension/extension-delivery';
import { brandFooter, footerApplies, hasBrandFooter } from './brand-footer';
import { type AudienceLanguage, countChars, detectLanguage, PlatformContract, platformContract, type TextFormat } from './platform-contract';

export interface PostTextInput {
  title: string | null;
  body: string;
  hashtags: string[];
}

/**
 * Turns Markdown into clean paragraphs for editors that insert plain text
 * (XenForo, Tinhte, Medium, Quora, Mastodon…), so readers never see `**` or `##`.
 */
export function markdownToPlain(markdown: string): string {
  const lines: string[] = [];
  let fenced = false;
  for (const raw of markdown.replace(/\r\n?/g, '\n').split('\n')) {
    if (/^\s*(```|~~~)/.test(raw)) { fenced = !fenced; continue; }
    if (fenced) { lines.push(raw); continue; }
    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(raw)) continue;
    const line = raw
      .replace(/^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/, '$1')
      .replace(/^(\s*)>\s?/, '$1')
      .replace(/^(\s*)[-*+]\s+(?=\S)/, '$1• ');
    lines.push(inlineToPlain(line));
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function inlineToPlain(line: string): string {
  return line
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\(\s*(\S+?)(?:\s+"[^"]*")?\s*\)/g, (_match, text: string, url: string) => (text.trim() === url ? url : `${text} (${url})`))
    .replace(/`([^`]+)`/g, '$1')
    .replace(/(\*\*|__)(?=\S)(.+?)(?<=\S)\1/g, '$2')
    .replace(/~~(?=\S)(.+?)(?<=\S)~~/g, '$1')
    .replace(/(^|[^\w*])\*(?=\S)([^*\n]+?)(?<=\S)\*(?!\w)/g, '$1$2');
}

function firstLine(text: string): string {
  return text.split('\n').find((line) => line.trim())?.trim() ?? '';
}

function truncate(text: string, max: number): string {
  const chars = [...text];
  if (chars.length <= max) return text;
  const cut = chars.slice(0, max).join('');
  const space = cut.lastIndexOf(' ');
  return (space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:–-]+$/, '');
}

function hasHashtag(body: string, tag: string): boolean {
  const escaped = escapeRegExp(tag);
  return new RegExp(`(^|\\s)#${escaped}(?![\\p{L}\\p{N}_])`, 'iu').test(body);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Whether the text already links to `url` (with or without the protocol,
 * "www." or a trailing slash), so the source line would only repeat it.
 */
export function mentionsUrl(text: string, url: string): boolean {
  const core = url.trim().replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/\/+$/, '');
  if (!core) return false;
  // The link must end where the URL ends: "…/post" is not "…/post-2".
  return new RegExp(`(?:^|[^\\w.-])(?:https?://)?(?:www\\.)?${escapeRegExp(core)}/?(?=$|[\\s)\\]>"'»”]|[.,;:!?…](?:\\s|$))`, 'i').test(text);
}

/** The line the system adds under a post to credit its source. */
export function sourceLine(language: 'vi' | 'en', canonicalUrl: string): string {
  return `${language === 'vi' ? 'Nguồn' : 'Source'}: ${canonicalUrl}`;
}

/** Hashtags a connector prints after the body itself (Instagram), as it prints them. */
function appendedHashtags(input: PostTextInput, contract: PlatformContract): string {
  return contract.hashtagMode === 'appended' && input.hashtags.length
    ? `\n\n${input.hashtags.map((tag) => `#${tag.replace(/^#+/, '')}`).join(' ')}`
    : '';
}

/**
 * The company footer to print below `text`, or '' when the destination takes
 * none (see `footerApplies`), the text carries it already, or the post would
 * no longer fit the limit with it: the footer never pushes a post over.
 */
function footerFor(text: string, input: PostTextInput, contract: PlatformContract, language: AudienceLanguage, format: TextFormat): string {
  if (!footerApplies(contract, language) || hasBrandFooter(text)) return '';
  const footer = brandFooter(format);
  if (contract.maxChars && countChars(`${text}\n\n${footer}${appendedHashtags(input, contract)}`, contract.counting) > contract.maxChars) return '';
  return footer;
}

const withFooter = (text: string, footer: string) => (footer ? `${text}\n\n${footer}` : text);

/** Language a post is read in: what its text is written in, else the destination's. */
function postLanguage(text: string, contract: PlatformContract): AudienceLanguage {
  const detected = detectLanguage(text);
  return detected === 'unknown' ? contract.language : detected;
}

/**
 * The exact title/body a destination receives. Forums and articles keep tags
 * in their own fields; short-form social keeps hashtags inline and only adds
 * missing ones while the post still fits the character limit. Posts on the
 * brand's own channels end with the company footer when it fits.
 *
 * A destination without a title field gets an empty title unless one was
 * written: Quora's flow puts the title above the body, and a title taken from
 * the first line would print that line twice.
 */
export function renderPostText(input: PostTextInput, contract: PlatformContract, canonicalUrl?: string | null): { title: string; body: string } {
  const { title, text, footer } = renderParts(input, contract, canonicalUrl);
  return { title, body: withFooter(text, footer) };
}

/** The company footer `renderPostText` ends this post with, or '' (for flows that place it themselves, like the manual copy). */
export function postFooter(input: PostTextInput, contract: PlatformContract, canonicalUrl?: string | null): string {
  return renderParts(input, contract, canonicalUrl).footer;
}

function renderParts(input: PostTextInput, contract: PlatformContract, canonicalUrl?: string | null): { title: string; text: string; footer: string } {
  const body = contract.format === 'plain' ? markdownToPlain(input.body) : input.body.trim();
  const rawTitle = input.title?.trim() || (contract.titleRequired ? firstLine(body) : '');
  const cleanTitle = contract.format === 'plain' ? markdownToPlain(rawTitle) : rawTitle;
  const title = contract.titleHardLimit ? truncate(cleanTitle, contract.titleHardLimit) : cleanTitle;
  const language = postLanguage(body, contract);
  // A post that already links to its source does not get the line again.
  const source = canonicalUrl && !mentionsUrl(body, canonicalUrl) ? sourceLine(language, canonicalUrl) : '';
  let text = [body, source].filter(Boolean).join('\n\n');
  if (contract.hashtagMode === 'inline') {
    const tags = [...new Set(input.hashtags.map((tag) => tag.trim().replace(/^#+/, '')).filter(Boolean))];
    const present = tags.filter((tag) => hasHashtag(body, tag)).length;
    const missing = tags.filter((tag) => !hasHashtag(body, tag)).slice(0, Math.max(0, contract.maxHashtags - present));
    const withTags = missing.length ? `${text}\n\n${missing.map((tag) => `#${tag}`).join(' ')}` : text;
    if (!contract.maxChars || countChars(withTags, contract.counting) <= contract.maxChars) text = withTags;
  }
  return { title, text, footer: footerFor(text, input, contract, language, contract.format) };
}

/** Connectors whose content field is HTML, whatever format the AI was asked to write. */
const HTML_FIELD_CONNECTORS = new Set(['wordpress', 'blogger']);

/**
 * Body a connector sends: the variant body as written (API connectors place
 * hashtags and links themselves) with the company footer below it where
 * `renderPostText` puts one, in the form the connector's field takes.
 */
export function apiPostBody(input: PostTextInput, contract: PlatformContract, connectorKey: string): string {
  const body = input.body.trim();
  if (!body) return input.body;
  const format: TextFormat = HTML_FIELD_CONNECTORS.has(connectorKey) ? 'html' : contract.format;
  const footer = footerFor(body, input, contract, postLanguage(body, contract), format);
  // Without a footer the connector gets the body exactly as before.
  return footer ? withFooter(body, footer) : input.body;
}

/** Length the destination counts, including what a connector appends itself. */
export function publishedLength(input: PostTextInput, contract: PlatformContract, canonicalUrl?: string | null): number {
  const { body } = renderPostText(input, contract, canonicalUrl);
  return countChars(`${body}${appendedHashtags(input, contract)}`, contract.counting);
}

/** Final text for an extension task, using the engine the account actually posts with. */
export function renderForExtension(input: PostTextInput, platformSlug: string, engine: ExtensionEngine, canonicalUrl: string | null) {
  return renderPostText(input, platformContract(platformSlug, { engine, sourceText: input.body }), canonicalUrl);
}
