import { escapeHtml } from './markdown-html';
import { PLATFORM_CATALOG, type PlatformGroupKey } from './platform-catalog';
import type { AudienceLanguage, PlatformContract, TextFormat } from './platform-contract';

/** The company's own facts, shared by the footers and the suggested brand profile. */
export const BRAND_COMPANY_NAME = 'CÔNG TY CỔ PHẦN TẬP ĐOÀN VPSTTT';
export const BRAND_WEBSITE = 'https://vpsttt.com';
export const BRAND_EMAIL = 'lienhe@vpsttt.com';
export const BRAND_HOTLINE = '0328.812.674';
export const BRAND_ZALO = 'https://zalo.me/vpstttgroup';
export const BRAND_DATACENTERS = ['VNPT', 'Viettel', 'FPT', 'CMC'] as const;

/** The company's contact block, printed at the end of Vietnamese posts on the brand's own channels. */
export const BRAND_FOOTER_LINES = [
  `🏢 ${BRAND_COMPANY_NAME}`,
  `📍Datacenter: ${BRAND_DATACENTERS.join(' – ')}`,
  `☎ Hotline: ${BRAND_HOTLINE}`,
  `🌎 Website: ${BRAND_WEBSITE}`,
  `📧 Email: ${BRAND_EMAIL}`,
  `📲 Zalo tư vấn nhanh: ${BRAND_ZALO}`,
] as const;

/**
 * The same block for English readers: what the company is, and the contacts they
 * can use from abroad (the hotline in international form; Zalo is a Vietnamese app).
 */
export const BRAND_FOOTER_LINES_EN = [
  `🏢 VPSTTT – VPS and proxy services, datacenters in Vietnam (${BRAND_DATACENTERS.join(', ')})`,
  `🌎 Website: ${BRAND_WEBSITE}`,
  `📧 Email: ${BRAND_EMAIL}`,
  '☎ Phone: +84 328 812 674',
] as const;

/** Short feeds (X, Bluesky, Threads, Mastodon, Pixelfed): the website alone, in any language. */
export const BRAND_SHORT_LINE = `🌐 ${BRAND_WEBSITE}`;

/**
 * Social feeds, blogs, media and event pages publish from the brand's own
 * account, where a contact block is expected. Forums, communities, developer
 * sites and maker communities post under a member's name among peers: their
 * rules (Reddit, Stack Exchange, Voz, Tinhte, Discourse…) treat a company
 * signature as advertising, so they never get it.
 */
const FOOTER_GROUPS: ReadonlySet<PlatformGroupKey> = new Set(['SOCIAL', 'BLOGGING', 'MEDIA', 'EVENT']);

/**
 * Below this limit the full block would take a fifth of the post or more (X 280,
 * Bluesky 300, Threads / Mastodon / Pixelfed 500): those posts get the short line.
 */
export const FOOTER_MIN_LIMIT = 1000;

/** Which footer a post gets: the Vietnamese or English block, or the short website line. */
export type FooterKind = 'vi' | 'en' | 'short';

/** The hotline in any spacing ("0328.812.674", "0328 812 674", "0328812674", "+84 328 812 674"). */
const HOTLINE = /(?:0|\+84[\s.-]?)328[\s.-]?812[\s.-]?674/;
const WEBSITE = /(?:https?:\/\/)?(?:www\.)?vpsttt\.com(?![\w-])/i;
const LINK = /https?:\/\/[^\s<>()]+/g;

/**
 * The footer posts to this destination end with, or null: only the brand's own
 * channels get one; a short feed gets the website line, a longer post the block
 * in its readers' language.
 */
export function footerKind(contract: Pick<PlatformContract, 'slug' | 'maxChars'>, language: AudienceLanguage): FooterKind | null {
  const group = PLATFORM_CATALOG.find((platform) => platform.slug === contract.slug)?.groupKey;
  if (!group || !FOOTER_GROUPS.has(group)) return null;
  if (contract.maxChars && contract.maxChars < FOOTER_MIN_LIMIT) return 'short';
  return language;
}

/** Whether posts to this destination end with a company footer (see `footerKind`). */
export function footerApplies(contract: Pick<PlatformContract, 'slug' | 'maxChars'>, language: AudienceLanguage): boolean {
  return footerKind(contract, language) !== null;
}

/** The footer in the destination's format; HTML fields get one paragraph with real links. */
export function brandFooter(format: TextFormat, kind: FooterKind = 'vi'): string {
  const lines: readonly string[] = kind === 'short' ? [BRAND_SHORT_LINE] : kind === 'en' ? BRAND_FOOTER_LINES_EN : BRAND_FOOTER_LINES;
  if (format !== 'html') return lines.join('\n');
  const html = lines.map((line) => escapeHtml(line).replace(LINK, (url) => `<a href="${url}">${url}</a>`));
  return `<p>${html.join('<br>')}</p>`;
}

/**
 * The post already carries what the footer would add (pasted by the operator or
 * written by the AI): never print it twice. The blocks are recognised by the
 * hotline or the email, the short line by any link to the website.
 */
export function hasBrandFooter(text: string, kind: FooterKind = 'vi'): boolean {
  if (kind === 'short') return WEBSITE.test(text);
  return HOTLINE.test(text) || text.toLowerCase().includes(BRAND_EMAIL);
}
