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

const STYLE: Record<string, string> = {
  'pixelfed-social': 'an authentic, photographic square image with natural light and a calm, aesthetic composition; Pixelfed is a photo-first community',
  instagram: 'a polished, visual-first square photo or lifestyle scene that stops the scroll',
  threads: 'a casual, friendly square photo that feels personal rather than an advertisement',
  linkedin: 'a clean, professional landscape photo or minimal business illustration suited to a B2B audience',
  bluesky: 'a simple, friendly editorial illustration in landscape, easy to read at small size',
  mastodon: 'a modest, informative landscape illustration; the fediverse dislikes ad-like visuals',
  'mastodon-social': 'a modest, informative landscape illustration; the fediverse dislikes ad-like visuals',
  'vivaldi-social': 'a modest, informative landscape illustration; the fediverse dislikes ad-like visuals',
  tumblr: 'an expressive, artistic landscape illustration with personality',
  x: 'a bold, high-contrast landscape visual with one clear focal point',
  discord: 'a friendly, community-style landscape illustration',
  devto: 'a developer-friendly flat tech illustration used as a wide article cover',
};

export function imageSizeFor(slug: string): AiImageSize {
  return SQUARE.has(slug) ? '1024x1024' : '1536x1024';
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
    plan.set(slug, {
      need: current?.need === 'required' || need === 'required' ? 'required' : 'optional',
      size: imageSizeFor(slug),
      style: STYLE[slug] ?? 'a clear, on-topic landscape illustration',
    });
  }
  return plan;
}
