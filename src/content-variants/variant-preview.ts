import { EXTENSION_RECIPES, isExtensionDelivery, parseExtensionDeliverySettings, type ExtensionEngine } from '../connectors/extension/extension-delivery';
import { destinationTags } from '../connectors/extension/extension-tags';
import { PLATFORM_CATALOG, type PlatformGroupKey } from '../platforms/platform-catalog';
import { defaultEngineFor, type AudienceLanguage, type TextFormat } from '../platforms/platform-contract';
import { checkPostLength, contractFor } from '../platforms/post-length';
import { renderPostText, type PostTextInput } from '../platforms/post-text';

/**
 * How the destination shows the body: rendered Markdown, plain paragraphs, or
 * rich text (an editor the extension pastes HTML into, or an HTML field).
 */
export type PreviewAppearance = 'markdown' | 'plain' | 'rich';

/** Where on the site the post goes, from the account's settings, and in which language. */
export interface PreviewDestination {
  /** Lemmy / Discuit community or Reddit subreddit ("r/selfhosted"). */
  community?: string;
  /** Forum category or box set on the account. */
  category?: string;
  flair?: string;
  language: AudienceLanguage;
}

/** How the account posts: through the Chrome extension with its settings, or the platform's API. */
export type PreviewRoute =
  | { delivery: 'extension'; engine: ExtensionEngine; tags: string[]; category: string; flair: string; targetUrl: string }
  | { delivery: 'api' };

export interface VariantPreview {
  /** Empty for destinations without a title field (short-form social, Quora). */
  title: string;
  /**
   * The body as the destination receives it (Markdown removed for plain
   * editors, hashtags placed, source line added). For `rich` it keeps the
   * Markdown the extension turns into HTML, so the page can render it.
   */
  body: string;
  format: TextFormat;
  appearance: PreviewAppearance;
  /** Tags really sent in the destination's own tag field; empty when hashtags stay in the text. */
  tags: string[];
  destination: PreviewDestination;
  group: PlatformGroupKey;
  engine: ExtensionEngine | null;
  maxChars: number | null;
  length: number;
  overLimit: boolean;
}

/** Engines whose "category" setting names the community the post goes to. */
const COMMUNITY_ENGINES = new Set<ExtensionEngine>(['lemmy', 'discuit']);

/** The account's posting route; undefined when its extension settings are invalid (the platform default applies). */
export function previewRoute(settings: unknown): PreviewRoute | undefined {
  if (!isExtensionDelivery(settings)) return { delivery: 'api' };
  try {
    const parsed = parseExtensionDeliverySettings(settings);
    return { delivery: 'extension', engine: parsed.engine, tags: parsed.tags ?? [], category: parsed.category ?? '', flair: parsed.flair ?? '', targetUrl: parsed.targetUrl };
  } catch {
    return undefined;
  }
}

function destinationOf(route: PreviewRoute | undefined, language: AudienceLanguage): PreviewDestination {
  if (route?.delivery !== 'extension') return { language };
  const subreddit = route.engine === 'reddit' ? /^\/r\/([A-Za-z0-9_-]+)\//.exec(new URL(route.targetUrl).pathname)?.[1] : undefined;
  const community = COMMUNITY_ENGINES.has(route.engine) ? route.category : subreddit ? `r/${subreddit}` : '';
  const category = COMMUNITY_ENGINES.has(route.engine) ? '' : route.category;
  return { ...(community ? { community } : {}), ...(category ? { category } : {}), ...(route.flair ? { flair: route.flair } : {}), language };
}

/**
 * What a post will look like on its destination, built with the same contract,
 * text rendering and length check as publishing, so the review preview
 * matches the post. `engine` picks a posting flow when no account route is
 * known; an extension account's own route wins.
 */
export function variantPreview(
  input: PostTextInput,
  platformSlug: string,
  engine: ExtensionEngine | undefined,
  canonicalUrl: string | null,
  route?: PreviewRoute,
): VariantPreview {
  const extension = route?.delivery === 'extension' ? route : undefined;
  const resolvedEngine = extension?.engine ?? engine ?? defaultEngineFor(platformSlug);
  const contract = contractFor({ platformSlug, engine: resolvedEngine, body: input.body });
  const rendered = renderPostText(input, contract, canonicalUrl);
  const hashtags = [...new Set(input.hashtags.map((tag) => tag.trim().replace(/^#+/, '')).filter(Boolean))];
  // Rich editors get HTML made from the Markdown; an API account never goes through them.
  const pastesHtml = route?.delivery !== 'api' && resolvedEngine !== undefined && EXTENSION_RECIPES[resolvedEngine].inputMode === 'pasteHtml';
  const appearance: PreviewAppearance = pastesHtml || contract.format === 'html' ? 'rich' : contract.format === 'markdown' ? 'markdown' : 'plain';
  let body = pastesHtml ? renderPostText(input, { ...contract, format: 'markdown' }, canonicalUrl).body : rendered.body;
  // Instagram-style connectors append the hashtags after the caption themselves.
  if (contract.hashtagMode === 'appended' && hashtags.length) body = `${body}\n\n${hashtags.map((tag) => `#${tag}`).join(' ')}`;
  // Quora has no title field: the extension puts a written title above the body.
  if (resolvedEngine === 'quora' && rendered.title) body = `${rendered.title}\n\n${body}`;
  const tags = contract.hashtagMode !== 'tags' ? []
    // What the extension sends: the account's own tags, then the AI's tags in the form the site accepts.
    : extension ? [...extension.tags, ...destinationTags(extension.engine, hashtags, extension.tags)]
      : hashtags.slice(0, contract.maxHashtags);
  const length = checkPostLength({ ...input, platformSlug, engine: resolvedEngine, canonicalUrl });
  return {
    title: contract.titleRequired ? rendered.title : '',
    body,
    format: contract.format,
    appearance,
    tags,
    destination: destinationOf(route, contract.language),
    group: PLATFORM_CATALOG.find((platform) => platform.slug === platformSlug)?.groupKey ?? 'SOCIAL',
    engine: resolvedEngine ?? null,
    maxChars: length.maxChars,
    length: length.length,
    overLimit: length.over,
  };
}
