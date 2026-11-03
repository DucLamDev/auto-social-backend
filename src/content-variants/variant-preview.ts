import type { ExtensionEngine } from '../connectors/extension/extension-delivery';
import { extensionFlowForPlatform } from '../connectors/extension/extension-flows';
import { PLATFORM_CATALOG, type PlatformGroupKey } from '../platforms/platform-catalog';
import { platformContract, type TextFormat } from '../platforms/platform-contract';
import { publishedLength, renderPostText, type PostTextInput } from '../platforms/post-text';

export interface VariantPreview {
  /** Empty for destinations without a title field (short-form social). */
  title: string;
  /** The body as the destination receives it (Markdown removed for plain editors, hashtags placed). */
  body: string;
  format: TextFormat;
  /** Tags sent in the destination's own tag field (forums, articles); empty when hashtags stay in the text. */
  tags: string[];
  group: PlatformGroupKey;
  engine: ExtensionEngine | null;
  maxChars: number | null;
  length: number;
  overLimit: boolean;
}

/**
 * What a post will look like on its destination, built with the same contract
 * and text rendering as publishing, so the review preview matches the post.
 */
export function variantPreview(input: PostTextInput, platformSlug: string, engine: ExtensionEngine | undefined, canonicalUrl: string | null): VariantPreview {
  const resolvedEngine = engine ?? extensionFlowForPlatform(platformSlug)?.engine;
  const contract = platformContract(platformSlug, { engine: resolvedEngine, sourceText: input.body });
  const rendered = renderPostText(input, contract, canonicalUrl);
  const hashtags = [...new Set(input.hashtags.map((tag) => tag.trim().replace(/^#+/, '')).filter(Boolean))];
  // Instagram-style connectors append the hashtags after the caption themselves.
  const body = contract.hashtagMode === 'appended' && hashtags.length ? `${rendered.body}\n\n${hashtags.map((tag) => `#${tag}`).join(' ')}` : rendered.body;
  const length = publishedLength(input, contract, canonicalUrl);
  return {
    title: contract.titleRequired ? rendered.title : '',
    body,
    format: contract.format,
    tags: contract.hashtagMode === 'tags' ? hashtags.slice(0, contract.maxHashtags) : [],
    group: PLATFORM_CATALOG.find((platform) => platform.slug === platformSlug)?.groupKey ?? 'SOCIAL',
    engine: resolvedEngine ?? null,
    maxChars: contract.maxChars ?? null,
    length,
    overLimit: contract.maxChars !== undefined && length > contract.maxChars,
  };
}
