import { ExtensionEngine } from '../connectors/extension/extension-delivery';
import { countChars, detectLanguage, PlatformContract, platformContract } from './platform-contract';

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
  const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|\\s)#${escaped}(?![\\p{L}\\p{N}_])`, 'iu').test(body);
}

/**
 * The exact title/body a destination receives. Forums and articles keep tags
 * in their own fields; short-form social keeps hashtags inline and only adds
 * missing ones while the post still fits the character limit.
 */
export function renderPostText(input: PostTextInput, contract: PlatformContract, canonicalUrl?: string | null): { title: string; body: string } {
  const body = contract.format === 'plain' ? markdownToPlain(input.body) : input.body.trim();
  const rawTitle = input.title?.trim() || firstLine(body);
  const cleanTitle = contract.format === 'plain' ? markdownToPlain(rawTitle) : rawTitle;
  const title = contract.titleHardLimit ? truncate(cleanTitle, contract.titleHardLimit) : cleanTitle;
  const detected = detectLanguage(body);
  const language = detected === 'unknown' ? contract.language : detected;
  let text = [body, canonicalUrl ? `${language === 'vi' ? 'Nguồn' : 'Source'}: ${canonicalUrl}` : ''].filter(Boolean).join('\n\n');
  if (contract.hashtagMode === 'inline') {
    const tags = [...new Set(input.hashtags.map((tag) => tag.trim().replace(/^#+/, '')).filter(Boolean))];
    const present = tags.filter((tag) => hasHashtag(body, tag)).length;
    const missing = tags.filter((tag) => !hasHashtag(body, tag)).slice(0, Math.max(0, contract.maxHashtags - present));
    const withTags = missing.length ? `${text}\n\n${missing.map((tag) => `#${tag}`).join(' ')}` : text;
    if (!contract.maxChars || countChars(withTags, contract.counting) <= contract.maxChars) text = withTags;
  }
  return { title, body: text };
}

/** Length the destination counts, including what a connector appends itself. */
export function publishedLength(input: PostTextInput, contract: PlatformContract, canonicalUrl?: string | null): number {
  const { body } = renderPostText(input, contract, canonicalUrl);
  const appended = contract.hashtagMode === 'appended' && input.hashtags.length
    ? `\n\n${input.hashtags.map((tag) => `#${tag.replace(/^#+/, '')}`).join(' ')}`
    : '';
  return countChars(`${body}${appended}`, contract.counting);
}

/** Final text for an extension task, using the engine the account actually posts with. */
export function renderForExtension(input: PostTextInput, platformSlug: string, engine: ExtensionEngine, canonicalUrl: string | null) {
  return renderPostText(input, platformContract(platformSlug, { engine, sourceText: input.body }), canonicalUrl);
}
