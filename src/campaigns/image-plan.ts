import type { Prisma } from '@prisma/client';
import type { AiImageSize } from '../ai/ai-image.service';
import type { ConnectorCapability } from '../connectors/core/connector-capability';
import { EXTENSION_RECIPES, effectiveConnectorKey, isExtensionDelivery, parseExtensionDeliverySettings } from '../connectors/extension/extension-delivery';

/** required: the post cannot go out without an image; optional: the route can attach one. */
export type ImageNeed = 'required' | 'optional' | 'none';

export interface PlatformImagePlan {
  need: Exclude<ImageNeed, 'none'>;
  size: AiImageSize;
  /** Visual direction for this destination's audience and feed. */
  style: string;
}

export interface ImagePlanAccount {
  settings: Prisma.JsonValue;
  platform: { slug: string; connectorKey?: string | null; capability?: Prisma.JsonValue };
}

/** Looks up the API connector that would publish for an account. */
export interface ConnectorLookup {
  has(key: string): boolean;
  get(key: string): { capability: ConnectorCapability };
}

// Feeds that crop to a square, or only accept 4:5 to 1.91:1 (Instagram).
const SQUARE = new Set(['pixelfed-social', 'instagram', 'threads']);

// Format and tone per feed. The subject and the technology look shared by every
// destination are set in the writer's image instructions (imageInstructions).
const STYLE: Record<string, string> = {
  'pixelfed-social': 'a crisp, photographic square image of real technology hardware (server or network equipment, a laptop with an abstract glowing interface) in cool, clean studio light; Pixelfed is a photo-first community',
  instagram: 'a polished, visual-first square technology visual (product-style 3D render or high-tech photo) that stops the scroll',
  threads: 'a friendly, modern square technology illustration that feels personal rather than an advertisement',
  linkedin: 'a clean, professional landscape technology visual (data centre, cloud infrastructure or a minimal isometric diagram) suited to a B2B audience',
  bluesky: 'a simple editorial technology illustration in landscape, easy to read at small size',
  mastodon: 'an informative, modern technology illustration in landscape (isometric servers, network nodes, data flows); the fediverse dislikes ad-like visuals',
  'mastodon-social': 'an informative, modern technology illustration in landscape (isometric servers, network nodes, data flows); the fediverse dislikes ad-like visuals',
  'vivaldi-social': 'an informative, modern technology illustration in landscape (isometric servers, network nodes, data flows); the fediverse dislikes ad-like visuals',
  tumblr: 'an expressive, artistic landscape technology illustration with personality (stylised circuits, servers or network light trails)',
  x: 'a bold, high-contrast landscape technology visual with one clear focal point',
  discord: 'a friendly, community-style landscape technology illustration',
  devto: 'a developer-friendly flat tech illustration used as a wide article cover',
};

export function imageSizeFor(slug: string): AiImageSize {
  return SQUARE.has(slug) ? '1024x1024' : '1536x1024';
}

/** Image plan for one destination when no account decides it (an image added to an existing post). */
export function imagePlanFor(slug: string, need: Exclude<ImageNeed, 'none'> = 'optional'): PlatformImagePlan {
  return { need, size: imageSizeFor(slug), style: STYLE[slug] ?? 'a clear, on-topic landscape illustration' };
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** Whether the route that publishes this account can carry an image. */
export function accountImageNeed(account: ImagePlanAccount, connectors?: ConnectorLookup): ImageNeed {
  if (isExtensionDelivery(account.settings)) {
    let recipe;
    try { recipe = EXTENSION_RECIPES[parseExtensionDeliverySettings(account.settings).engine]; } catch { return 'none'; }
    if (recipe.requiredMedia === 'image') return 'required';
    return recipe.optionalMedia === 'image' ? 'optional' : 'none';
  }
  const key = effectiveConnectorKey(account.platform.connectorKey || account.platform.slug, account.settings);
  if (!connectors?.has(key)) return 'none';
  const connector = connectors.get(key).capability;
  const platform = record(account.platform.capability);
  // Same rule as publishing: a flag counts only when connector and platform both allow it.
  if (!(connector.image === true && platform.image === true)) return 'none';
  return connector.text === false || platform.text === false ? 'required' : 'optional';
}

/**
 * One image per destination whose route can attach it. A user-supplied image
 * replaces AI images everywhere; switching the option off leaves only text.
 */
export function planImages(
  accounts: ImagePlanAccount[],
  options: { enabled: boolean; userImage: boolean },
  connectors?: ConnectorLookup,
): Map<string, PlatformImagePlan> {
  const plan = new Map<string, PlatformImagePlan>();
  if (!options.enabled || options.userImage) return plan;
  for (const account of accounts) {
    const need = accountImageNeed(account, connectors);
    if (need === 'none') continue;
    const slug = account.platform.slug;
    const current = plan.get(slug);
    plan.set(slug, imagePlanFor(slug, current?.need === 'required' || need === 'required' ? 'required' : 'optional'));
  }
  return plan;
}
