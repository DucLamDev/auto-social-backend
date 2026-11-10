import { escapeHtml } from './markdown-html';
import { PLATFORM_CATALOG, type PlatformGroupKey } from './platform-catalog';
import type { AudienceLanguage, PlatformContract, TextFormat } from './platform-contract';

/** The company's contact block, printed at the end of posts on the brand's own channels. */
export const BRAND_FOOTER_LINES = [
  '🏢 CÔNG TY CỔ PHẦN TẬP ĐOÀN VPSTTT',
  '📍Datacenter: VNPT – Viettel – FPT – CMC',
  '☎ Hotline: 0328.812.674',
  '🌎 Website: https://vpsttt.com',
  '📧 Email: lienhe@vpsttt.com',
  '📲 Zalo tư vấn nhanh: https://zalo.me/vpstttgroup',
] as const;

/**
 * Social feeds, blogs, media and event pages publish from the brand's own
 * account, where a contact block is expected. Forums, communities, developer
 * sites and maker communities post under a member's name among peers: their
 * rules (Reddit, Stack Exchange, Voz, Tinhte, Discourse…) treat a company
 * signature as advertising, so they never get it.
 */
const FOOTER_GROUPS: ReadonlySet<PlatformGroupKey> = new Set(['SOCIAL', 'BLOGGING', 'MEDIA', 'EVENT']);

/**
 * Below this limit the footer would take a fifth of the post or more (X 280,
 * Bluesky 300, Threads / Mastodon / Pixelfed 500): those posts stay without it.
 */
export const FOOTER_MIN_LIMIT = 1000;

/** The hotline in any spacing ("0328.812.674", "0328 812 674", "0328812674"). */
const HOTLINE = /0328[\s.-]?812[\s.-]?674/;
const LINK = /https?:\/\/[^\s<>()]+/g;

/**
 * Whether posts to this destination end with the company footer: the brand's
 * own channel, room for it, and readers of the footer's language (Vietnamese).
 */
export function footerApplies(contract: Pick<PlatformContract, 'slug' | 'maxChars'>, language: AudienceLanguage): boolean {
  const group = PLATFORM_CATALOG.find((platform) => platform.slug === contract.slug)?.groupKey;
  if (!group || !FOOTER_GROUPS.has(group) || language !== 'vi') return false;
  return !contract.maxChars || contract.maxChars >= FOOTER_MIN_LIMIT;
}

/** The footer in the destination's format; HTML fields get one paragraph with real links. */
export function brandFooter(format: TextFormat): string {
  if (format !== 'html') return BRAND_FOOTER_LINES.join('\n');
  const lines = BRAND_FOOTER_LINES.map((line) => escapeHtml(line).replace(LINK, (url) => `<a href="${url}">${url}</a>`));
  return `<p>${lines.join('<br>')}</p>`;
}

/** The post already carries the contact block (pasted by the operator or written by the AI): never print it twice. */
export function hasBrandFooter(text: string): boolean {
  return HOTLINE.test(text);
}
