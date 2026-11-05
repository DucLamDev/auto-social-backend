import type { ExtensionEngine } from './extension-delivery';

/** Latin letters without diacritics ("bảo mật" → "bao mat"), for sites whose tags are ASCII. */
function fold(text: string): string {
  return text.normalize('NFD').replace(/\p{M}+/gu, '').replace(/đ/g, 'd').replace(/Đ/g, 'D');
}

/**
 * Destinations whose composer has a tag field the extension fills, with the
 * form each site accepts. Other engines have no tag field (or print hashtags
 * inside the body), so AI tags are never sent to them.
 */
const TAG_RULES: Partial<Record<ExtensionEngine, { max: number; clean: (tag: string) => string }>> = {
  // Stack Exchange: existing tags only, ASCII, words joined by "-", 35 chars, 5 per question.
  stackexchange: {
    max: 5,
    clean: (tag) => fold(tag).toLowerCase().replace(/[\s_]+/g, '-').replace(/[^a-z0-9+#.-]/g, '').replace(/-{2,}/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 35),
  },
  // Discourse: Unicode allowed, spaces become "-"; the extension keeps only tags the category already has.
  discourse: {
    max: 5,
    clean: (tag) => tag.toLowerCase().replace(/[\s_]+/g, '-').replace(/[^\p{L}\p{N}-]/gu, '').replace(/-{2,}/g, '-').replace(/^-+|-+$/g, '').slice(0, 30),
  },
  // DEV: lowercase letters and digits only, at most 4 tags.
  devto: { max: 4, clean: (tag) => fold(tag).toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 30) },
  // Differ: one Keyword picked from its own topic list; these are the candidates the extension matches.
  differ: { max: 3, clean: (tag) => fold(tag).toLowerCase().replace(/[_-]+/g, ' ').replace(/[^a-z0-9 +#.]/g, '').replace(/\s+/g, ' ').trim().slice(0, 40) },
  // Discuss Disqus topics: free text of 2 to 30 characters, at most 5, committed as "a, b, c".
  disqus: { max: 5, clean: (tag) => tag.replace(/[,;]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 30) },
  // SlideShare: free-text tags separated by commas.
  slideshare: { max: 5, clean: (tag) => tag.replace(/[,\s]+/g, ' ').trim().toLowerCase().slice(0, 40) },
};

// How the AI should write "hashtags" so they survive the rules above.
const TAG_STYLES: Partial<Record<ExtensionEngine, string>> = {
  stackexchange: 'English tags that already exist on this Stack Exchange site, lowercase, words joined with "-" (for example "nginx", "reverse-proxy"); the question is refused without at least one real tag',
  devto: 'lowercase letters and digits only, no spaces, "-" or accents (for example "webdev", "selfhosting")',
  discourse: 'short lowercase tags this forum most likely already has, words joined with "-"',
  disqus: 'short English topics of 2 to 30 characters that site owners search for (for example "comments", "moderation", "audience growth")',
  differ: 'broad English topics a blogging site lists as categories, most relevant first (for example "programming", "devops", "linux", "security", "web development", "cloud computing")',
};

/** Extra guidance for the AI's topic tags on destinations with strict tag rules. */
export function tagStyle(engine: ExtensionEngine | undefined): string | undefined {
  return engine ? TAG_STYLES[engine] : undefined;
}

/** Engines whose tag field takes the AI's topic tags. */
export function takesSuggestedTags(engine: ExtensionEngine): boolean {
  return Boolean(TAG_RULES[engine]);
}

/**
 * The AI variant's topic tags in the form `engine`'s tag field accepts (also
 * used for DEV's API), after the tags the owner configured on the account and
 * without repeating them. The extension treats these as suggestions: one the
 * site does not have is skipped, never created, so a suggestion never blocks a post.
 */
export function destinationTags(engine: ExtensionEngine, hashtags: readonly string[], configured: readonly string[] = []): string[] {
  const rule = TAG_RULES[engine];
  if (!rule) return [];
  const taken = new Set(configured.map((tag) => rule.clean(tag.trim().replace(/^#+/, ''))));
  const tags: string[] = [];
  for (const raw of hashtags) {
    const tag = rule.clean(raw.trim().replace(/^#+/, ''));
    if (!tag || taken.has(tag)) continue;
    taken.add(tag);
    tags.push(tag);
  }
  return tags.slice(0, Math.max(0, rule.max - configured.length));
}
