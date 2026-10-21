import { PlatformAvailability, PlatformMode } from '@prisma/client';
import { ConnectorCapability } from '../connectors/core/connector-capability';
import {
  REVIEWED_BROWSER_RECIPE_MANIFEST,
  reviewedBrowserRecipeForPlatform,
} from '../connectors/browser/browser-recipe.manifest';

export const PLATFORM_GROUP_KEYS = [
  'SOCIAL',
  'BLOGGING',
  'COMMUNITY',
  'FORUM',
  'DEVELOPER',
  'MEDIA',
  'COMMERCE',
  'EVENT',
] as const;

export type PlatformGroupKey = (typeof PLATFORM_GROUP_KEYS)[number];

export const PLATFORM_AUTOMATION_STATUSES = [
  'READY_AFTER_CREDENTIALS',
  'READY_AFTER_LOGIN',
  'API_CONNECTOR_REQUIRED',
  'BROWSER_RECIPE_REVIEW_REQUIRED',
  'POLICY_BLOCKED',
  'PLATFORM_RESEARCH_REQUIRED',
] as const;

export type PlatformAutomationStatus = (typeof PLATFORM_AUTOMATION_STATUSES)[number];

export interface PlatformAutomationMetadata {
  /** Trusted server-side readiness; never inferred from account-supplied settings. */
  status: PlatformAutomationStatus;
  route: 'API' | 'PLAYWRIGHT' | 'NONE';
  automaticPublishing: boolean;
  connectorKey?: string;
  browserRecipe?: string;
  browserRecipeRevision?: number;
  loginCaptureRequired?: boolean;
  permissionAttestationRequired?: boolean;
  autoSubmitDefault?: boolean;
  mediaUploadSupported?: boolean;
  requiredAccountSettings?: readonly string[];
  reasonCode?:
    | 'PUBLIC_API_CONNECTOR_NOT_IMPLEMENTED'
    | 'BROWSER_RECIPE_NOT_REVIEWED'
    | 'PLATFORM_POLICY_PROHIBITS_AUTOMATION'
    | 'PLATFORM_IDENTITY_UNRESOLVED';
}

export interface PlatformCatalogCapability extends ConnectorCapability {
  metadata: {
    automation: PlatformAutomationMetadata;
  };
}

export interface PlatformCatalogEntry {
  slug: string;
  name: string;
  connectorKey: string;
  groupKey: PlatformGroupKey;
  mode: PlatformMode;
  availability: PlatformAvailability;
  docsUrl?: string;
  enabled: boolean;
  defaultSettings: Record<string, string | number | boolean | string[]>;
  capability: PlatformCatalogCapability;
  promptRule: string;
}

type CatalogDefinition = Omit<PlatformCatalogEntry, 'connectorKey' | 'mode' | 'availability' | 'enabled' | 'defaultSettings' | 'capability' | 'promptRule'> &
  Partial<Pick<PlatformCatalogEntry, 'connectorKey' | 'mode' | 'availability' | 'enabled' | 'defaultSettings'>> & {
    capability?: ConnectorCapability;
    promptHint?: string;
  };

const GROUP_CAPABILITIES: Record<PlatformGroupKey, ConnectorCapability> = {
  SOCIAL: { text: true, image: true, video: false, article: false, delete: false, schedule: false, analytics: false },
  BLOGGING: { text: true, image: true, video: false, article: true, delete: false, schedule: false, analytics: false },
  COMMUNITY: { text: true, image: true, video: false, article: false, delete: false, schedule: false, analytics: false },
  FORUM: { text: true, image: false, video: false, article: true, delete: false, schedule: false, analytics: false },
  DEVELOPER: { text: true, image: false, video: false, article: true, delete: false, schedule: false, analytics: false },
  MEDIA: { text: true, image: true, video: true, article: false, delete: false, schedule: false, analytics: false },
  COMMERCE: { text: true, image: true, video: false, article: false, delete: false, schedule: false, analytics: false },
  EVENT: { text: true, image: true, video: false, article: true, delete: false, schedule: false, analytics: false },
};

const GROUP_PROMPT_RULES: Record<PlatformGroupKey, string> = {
  SOCIAL: 'Lead with a natural hook, keep the message scannable, use only relevant hashtags, and end with one clear call to action.',
  BLOGGING: 'Create an original SEO-friendly article with a precise search-intent title, a concise introduction, semantic H2/H3 headings, useful detail, and a non-spammy conclusion.',
  COMMUNITY: 'Write a concise community update that gives context, contributes value, avoids mass mentions, and invites a specific constructive response.',
  FORUM: 'Write a descriptive topic title and a self-contained Markdown post with context, evidence, and a focused question; follow community norms and avoid promotional language.',
  DEVELOPER: 'Write technically accurate Markdown for practitioners, explain assumptions, include reproducible details when supported by the source, and avoid invented code or benchmarks.',
  MEDIA: 'Create a discoverable caption with a strong opening, accessible media description, restrained hashtags, and a clear next action without engagement bait.',
  COMMERCE: 'Explain the concrete customer problem, differentiating value, proof supplied by the source, and a transparent call to action without unsupported claims.',
  EVENT: 'State the audience, value, date or location only when supplied, a concise agenda, and a clear registration action; never invent event details.',
};

function definePlatform(definition: CatalogDefinition): PlatformCatalogEntry {
  const connectorKey = definition.connectorKey ?? 'manual';
  const mode = definition.mode ?? PlatformMode.MANUAL;
  const availability = definition.availability ?? PlatformAvailability.MANUAL_ONLY;
  const enabled = definition.enabled ?? true;
  const defaultSettings = definition.defaultSettings ?? {};
  const baseCapability = definition.capability ?? GROUP_CAPABILITIES[definition.groupKey];
  const capability: PlatformCatalogCapability = {
    ...baseCapability,
    metadata: {
      automation: automationMetadata(definition, connectorKey, mode, availability, defaultSettings),
    },
  };
  const promptRule = [
    `Adapt the content specifically for ${definition.name}.`,
    GROUP_PROMPT_RULES[definition.groupKey],
    definition.promptHint,
    'Preserve factual accuracy, make the primary topic and keywords clear, and never fabricate links, results, endorsements, or community membership.',
  ].filter(Boolean).join(' ');
  return { ...definition, connectorKey, mode, availability, enabled, defaultSettings, capability, promptRule };
}

const POLICY_BLOCKED_BROWSER_AUTOMATION = new Set(['medium', 'in-plain-english']);

function automationMetadata(
  definition: CatalogDefinition,
  connectorKey: string,
  mode: PlatformMode,
  availability: PlatformAvailability,
  defaultSettings: Record<string, string | number | boolean | string[]>,
): PlatformAutomationMetadata {
  if (mode === PlatformMode.BROWSER_ASSISTED) {
    const reviewedRecipe = reviewedBrowserRecipeForPlatform(definition.slug);
    if (!reviewedRecipe) {
      throw new Error(`Browser-assisted platform '${definition.slug}' has no reviewed browser recipe`);
    }
    if (defaultSettings.browserRecipe !== reviewedRecipe.key) {
      throw new Error(
        `Browser-assisted platform '${definition.slug}' does not match its reviewed browser recipe`,
      );
    }
    return {
      status: 'READY_AFTER_LOGIN',
      route: 'PLAYWRIGHT',
      automaticPublishing: true,
      connectorKey,
      browserRecipe: reviewedRecipe.key,
      browserRecipeRevision: reviewedRecipe.revision,
      loginCaptureRequired: true,
      permissionAttestationRequired: reviewedRecipe.requiresAutomationPermissionAttestation,
      autoSubmitDefault: defaultSettings.browserAutoSubmit === true,
      mediaUploadSupported: reviewedRecipe.mediaUploadSupported,
      requiredAccountSettings: reviewedRecipe.requiredAccountSettings,
    };
  }
  if (mode === PlatformMode.OFFICIAL_API || mode === PlatformMode.COMPATIBLE_API) {
    return {
      status: 'READY_AFTER_CREDENTIALS',
      route: 'API',
      automaticPublishing: true,
      connectorKey,
    };
  }
  if (availability === PlatformAvailability.API_REVIEW_REQUIRED) {
    return {
      status: 'API_CONNECTOR_REQUIRED',
      route: 'API',
      automaticPublishing: false,
      reasonCode: 'PUBLIC_API_CONNECTOR_NOT_IMPLEMENTED',
    };
  }
  if (availability === PlatformAvailability.API_RESEARCH_REQUIRED) {
    return {
      status: 'PLATFORM_RESEARCH_REQUIRED',
      route: 'NONE',
      automaticPublishing: false,
      reasonCode: 'PLATFORM_IDENTITY_UNRESOLVED',
    };
  }
  if (POLICY_BLOCKED_BROWSER_AUTOMATION.has(definition.slug)) {
    return {
      status: 'POLICY_BLOCKED',
      route: 'NONE',
      automaticPublishing: false,
      reasonCode: 'PLATFORM_POLICY_PROHIBITS_AUTOMATION',
    };
  }
  return {
    status: 'BROWSER_RECIPE_REVIEW_REQUIRED',
    route: 'PLAYWRIGHT',
    automaticPublishing: false,
    reasonCode: 'BROWSER_RECIPE_NOT_REVIEWED',
  };
}

const definitions: CatalogDefinition[] = [
  { slug: 'instagram', name: 'Instagram', groupKey: 'SOCIAL', connectorKey: 'instagram', mode: PlatformMode.OFFICIAL_API, availability: PlatformAvailability.CREDENTIAL_REQUIRED, docsUrl: 'https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/content-publishing/', capability: { ...GROUP_CAPABILITIES.SOCIAL, text: false, maxImages: 1 }, promptHint: 'Use a visual-first caption, short paragraphs, image alt-text guidance, and a compact hashtag set.' },
  { slug: 'threads', name: 'Threads', groupKey: 'SOCIAL', connectorKey: 'threads', mode: PlatformMode.OFFICIAL_API, availability: PlatformAvailability.CREDENTIAL_REQUIRED, docsUrl: 'https://developers.facebook.com/docs/threads/posts/', capability: { ...GROUP_CAPABILITIES.SOCIAL, maxText: 500, maxImages: 1 }, promptHint: 'Sound conversational and invite a genuine reply rather than writing an advertisement.' },
  { slug: 'x', name: 'X (Twitter)', groupKey: 'SOCIAL', connectorKey: 'x', mode: PlatformMode.OFFICIAL_API, availability: PlatformAvailability.CREDENTIAL_REQUIRED, docsUrl: 'https://docs.x.com/x-api/posts/create-a-post', capability: { ...GROUP_CAPABILITIES.SOCIAL, image: false, delete: true, maxText: 280 }, promptHint: 'Fit the main post within 280 characters and put the strongest fact first.' },
  { slug: 'linkedin', name: 'LinkedIn', groupKey: 'SOCIAL', connectorKey: 'linkedin', mode: PlatformMode.OFFICIAL_API, availability: PlatformAvailability.CREDENTIAL_REQUIRED, docsUrl: 'https://learn.microsoft.com/linkedin/marketing/community-management/shares/posts-api', capability: { ...GROUP_CAPABILITIES.SOCIAL, image: false }, promptHint: 'Use a credible professional voice and structure the post as insight, implication, and practical takeaway.' },
  { slug: 'wordpress', name: 'WordPress', groupKey: 'BLOGGING', connectorKey: 'wordpress', mode: PlatformMode.OFFICIAL_API, availability: PlatformAvailability.CREDENTIAL_REQUIRED, docsUrl: 'https://developer.wordpress.org/rest-api/reference/posts/', capability: { ...GROUP_CAPABILITIES.BLOGGING, image: false, delete: true }, defaultSettings: { publishStatus: 'draft' }, promptHint: 'Return a publication-ready long-form draft with an SEO title, excerpt, meaningful headings, and suggested slug.' },
  { slug: 'medium', name: 'Medium', groupKey: 'BLOGGING', docsUrl: 'https://help.medium.com/hc/en-us/articles/213477928-Medium-Rules', defaultSettings: { manualUrl: 'https://medium.com/new-story' }, capability: { ...GROUP_CAPABILITIES.BLOGGING, image: false }, promptHint: 'Use a compelling but accurate headline, clean section breaks, a memorable opening, and up to five focused topic tags.' },
  { slug: 'blogger', name: 'Blogger', groupKey: 'BLOGGING', connectorKey: 'blogger', mode: PlatformMode.OFFICIAL_API, availability: PlatformAvailability.CREDENTIAL_REQUIRED, docsUrl: 'https://developers.google.com/blogger/docs/3.0/reference/posts/insert', capability: { ...GROUP_CAPABILITIES.BLOGGING, image: false, delete: true }, defaultSettings: { publishImmediately: false }, promptHint: 'Produce readable HTML-friendly long-form content with a descriptive title and useful section headings.' },
  { slug: 'substack', name: 'Substack', groupKey: 'BLOGGING', defaultSettings: { manualUrl: 'https://substack.com/home/post' }, promptHint: 'Use a newsletter-style subject, preview line, personal opening, useful body, and a clear subscriber-oriented close.' },
  { slug: 'tumblr', name: 'Tumblr', groupKey: 'BLOGGING', connectorKey: 'tumblr', mode: PlatformMode.OFFICIAL_API, availability: PlatformAvailability.CREDENTIAL_REQUIRED, docsUrl: 'https://www.tumblr.com/docs/en/api/v2', capability: { ...GROUP_CAPABILITIES.BLOGGING, image: false }, defaultSettings: { publishImmediately: true }, promptHint: 'Favor a distinctive voice, compact formatting, useful tags, and media-aware storytelling.' },
  { slug: 'devto', name: 'dev.to', groupKey: 'DEVELOPER', connectorKey: 'devto', mode: PlatformMode.OFFICIAL_API, availability: PlatformAvailability.CREDENTIAL_REQUIRED, docsUrl: 'https://developers.forem.com/api', capability: { ...GROUP_CAPABILITIES.DEVELOPER, image: true, maxImages: 1 }, defaultSettings: { publishImmediately: false }, promptHint: 'Create an original technical article as Markdown without YAML front matter, because title, publication state, tags, canonical URL, summary, and main image are supplied as separate API fields. Use no more than four relevant tags and keep a non-promotional tone.' },
  { slug: 'quora', name: 'Quora', groupKey: 'COMMUNITY', defaultSettings: { manualUrl: 'https://www.quora.com/' }, promptHint: 'Answer one clear question directly, explain the reasoning, and disclose any relevant affiliation.' },
  { slug: 'discord', name: 'Discord', groupKey: 'COMMUNITY', connectorKey: 'discord', mode: PlatformMode.OFFICIAL_API, availability: PlatformAvailability.CREDENTIAL_REQUIRED, docsUrl: 'https://docs.discord.com/developers/resources/webhook#execute-webhook', capability: { ...GROUP_CAPABILITIES.COMMUNITY, image: true, delete: true, maxText: 2000, maxImages: 10 }, promptHint: 'Keep the update channel-friendly, use compact bullets when helpful, and do not include mass mentions.' },
  { slug: 'reddit', name: 'Reddit', groupKey: 'FORUM', availability: PlatformAvailability.API_REVIEW_REQUIRED, docsUrl: 'https://www.reddit.com/dev/api/#POST_api_submit', defaultSettings: { manualUrl: 'https://www.reddit.com/submit' }, promptHint: 'Use a subreddit-appropriate title, prioritize discussion and transparency, and avoid marketing-style calls to action.' },
  { slug: 'slideshare', name: 'SlideShare', groupKey: 'MEDIA', defaultSettings: { manualUrl: 'https://www.slideshare.net/upload' }, promptHint: 'Provide a searchable deck title, concise description, slide outline, and speaker-note guidance.' },
  { slug: 'bluesky', name: 'Bluesky', groupKey: 'SOCIAL', connectorKey: 'bluesky', mode: PlatformMode.OFFICIAL_API, availability: PlatformAvailability.CREDENTIAL_REQUIRED, docsUrl: 'https://docs.bsky.app/docs/tutorials/creating-a-post', capability: { ...GROUP_CAPABILITIES.SOCIAL, image: false, maxText: 300 }, promptHint: 'Use a conversational 300-character post with a useful standalone point.' },
  { slug: 'aws-community', name: 'AWS Community', groupKey: 'DEVELOPER', defaultSettings: { manualUrl: 'https://community.aws/content' }, promptHint: 'Focus on a concrete AWS use case, architecture decision, reproducible lesson, and relevant service names without implying AWS endorsement.' },
  { slug: 'mastodon', name: 'Mastodon', groupKey: 'SOCIAL', connectorKey: 'mastodon', mode: PlatformMode.OFFICIAL_API, availability: PlatformAvailability.CREDENTIAL_REQUIRED, docsUrl: 'https://docs.joinmastodon.org/methods/statuses/', capability: { ...GROUP_CAPABILITIES.SOCIAL, image: false, delete: true }, promptHint: 'Use accessible, community-oriented language and include a content warning suggestion when the subject may need one.' },
  { slug: 'mastodon-social', name: 'Mastodon.social', groupKey: 'SOCIAL', connectorKey: 'mastodon', mode: PlatformMode.COMPATIBLE_API, availability: PlatformAvailability.CREDENTIAL_REQUIRED, docsUrl: 'https://docs.joinmastodon.org/methods/statuses/', capability: { ...GROUP_CAPABILITIES.SOCIAL, image: false, delete: true, maxText: 500 }, defaultSettings: { instanceUrl: 'https://mastodon.social', visibility: 'public' }, promptHint: 'Keep the post within the instance limit, use accessible language, and avoid engagement bait.' },
  { slug: 'tinhte', name: 'Tinhte.vn', groupKey: 'FORUM', defaultSettings: { manualUrl: 'https://tinhte.vn/' }, promptHint: 'Write natural Vietnamese, make the practical benefit clear, and ask a focused experience-based question.' },
  { slug: 'vivaldi-social', name: 'social.vivaldi.net', groupKey: 'SOCIAL', connectorKey: 'mastodon', mode: PlatformMode.COMPATIBLE_API, availability: PlatformAvailability.CREDENTIAL_REQUIRED, docsUrl: 'https://docs.joinmastodon.org/methods/statuses/', capability: { ...GROUP_CAPABILITIES.SOCIAL, image: false, delete: true }, defaultSettings: { instanceUrl: 'https://social.vivaldi.net', visibility: 'public' }, promptHint: 'Use a friendly federated-social tone and a small number of discoverable hashtags.' },
  { slug: 'pixelfed-social', name: 'pixelfed.social', groupKey: 'MEDIA', availability: PlatformAvailability.API_REVIEW_REQUIRED, docsUrl: 'https://github.com/pixelfed/pixelfed/blob/dev/routes/api.php', defaultSettings: { manualUrl: 'https://pixelfed.social/' }, promptHint: 'Write an image-led caption with useful alt text, location only when supplied, and focused discovery tags.' },
  { slug: 'voz-forums', name: 'Voz Forums', groupKey: 'FORUM', connectorKey: 'browser-assisted', mode: PlatformMode.BROWSER_ASSISTED, availability: PlatformAvailability.CREDENTIAL_REQUIRED, docsUrl: 'https://voz.vn/help/terms/', defaultSettings: { browserRecipe: 'voz-xenforo', forumPath: '', threadPrefixId: '', browserAutoSubmit: false, automationPermissionAttested: false }, promptHint: 'Use natural Vietnamese, supply enough context for readers, avoid seeding or disguised advertising, and follow the selected box rules. Use plain text or XenForo BBCode-compatible structure instead of Markdown-specific syntax. Never default to F17 or another box: the account owner must select a box whose rules allow the exact post.' },
  { slug: 'kubeby', name: 'KubeBy', groupKey: 'DEVELOPER', defaultSettings: { manualUrl: 'https://kubeby.com/' }, promptHint: 'Center the post on Kubernetes operations, explicit versions when known, commands grounded in the source, and expected outcomes.' },
  { slug: 'lemmy-world', name: 'lemmy.world', groupKey: 'FORUM', availability: PlatformAvailability.API_REVIEW_REQUIRED, docsUrl: 'https://join-lemmy.org/docs/contributors/04-api.html', defaultSettings: { manualUrl: 'https://lemmy.world/create_post' }, promptHint: 'Choose a relevant community, use a descriptive title, and write for discussion rather than promotion.' },
  { slug: 'discuit', name: 'discuit.org', groupKey: 'FORUM', defaultSettings: { manualUrl: 'https://discuit.org/' }, promptHint: 'Use a clear community-relevant title and a compact discussion starter.' },
  { slug: 'minds', name: 'Minds', groupKey: 'SOCIAL', defaultSettings: { manualUrl: 'https://www.minds.com/' }, promptHint: 'Write a concise standalone update with transparent sourcing and restrained hashtags.' },
  { slug: 'mewe', name: 'MeWe', groupKey: 'SOCIAL', defaultSettings: { manualUrl: 'https://mewe.com/' }, promptHint: 'Use a community-first, conversational update with one clear discussion prompt.' },
  { slug: 'dzone', name: 'DZone', groupKey: 'DEVELOPER', defaultSettings: { manualUrl: 'https://dzone.com/' }, promptHint: 'Create a technically deep, vendor-neutral article pitch with practical implementation value.' },
  { slug: 'daily-dev', name: 'daily.dev', groupKey: 'DEVELOPER', defaultSettings: { manualUrl: 'https://app.daily.dev/' }, promptHint: 'Craft a developer-focused headline and compact technical summary that clearly states the learning value.' },
  { slug: 'differ', name: 'Differ', groupKey: 'BLOGGING', defaultSettings: { manualUrl: 'https://differ.blog/' }, promptHint: 'Write an original long-form draft with a search-focused title, personal insight, and clean section structure.' },
  { slug: 'product-hunt', name: 'Product Hunt', groupKey: 'COMMERCE', defaultSettings: { manualUrl: 'https://www.producthunt.com/posts/new' }, promptHint: 'Provide a short product name, crisp tagline, maker comment, problem, differentiation, and transparent launch call to action.' },
  { slug: 'dailymotion', name: 'Dailymotion', groupKey: 'MEDIA', availability: PlatformAvailability.API_REVIEW_REQUIRED, docsUrl: 'https://developers.dailymotion.com/docs/upload-videos', defaultSettings: { manualUrl: 'https://www.dailymotion.com/upload' }, promptHint: 'Create a searchable video title, concise description, chapter suggestions, and relevant tags.' },
  { slug: 'in-plain-english', name: 'In Plain English', groupKey: 'DEVELOPER', defaultSettings: { manualUrl: 'https://medium.com/in-plain-english' }, promptHint: 'Explain the technical subject in plain language while retaining accuracy, practical examples, and an editorial-quality headline.' },
  { slug: 'hub', name: 'Hub', groupKey: 'BLOGGING', availability: PlatformAvailability.API_RESEARCH_REQUIRED, enabled: false, promptHint: 'Produce an evergreen, helpful article with a search-intent title, clear sections, and actionable takeaways.' },
  { slug: 'stack-overflow', name: 'Stack Overflow', groupKey: 'DEVELOPER', defaultSettings: { manualUrl: 'https://stackoverflow.com/questions/ask' }, promptHint: 'Draft a minimal reproducible programming question with observed behavior, expected behavior, attempts made, and precise tags; do not write promotion.' },
  { slug: 'server-fault', name: 'Server Fault', groupKey: 'DEVELOPER', defaultSettings: { manualUrl: 'https://serverfault.com/questions/ask' }, promptHint: 'Draft a professional systems-administration question with environment, diagnostics, logs with secrets removed, and a specific failure mode.' },
  { slug: 'level1techs-forum', name: 'Level1Techs Forum', groupKey: 'FORUM', connectorKey: 'discourse', mode: PlatformMode.COMPATIBLE_API, availability: PlatformAvailability.CREDENTIAL_REQUIRED, docsUrl: 'https://docs.discourse.org/', defaultSettings: { baseUrl: 'https://forum.level1techs.com' }, promptHint: 'Include relevant hardware or software details, troubleshooting already attempted, and one focused technical question.' },
  { slug: 'truenas-community', name: 'TrueNAS Community', groupKey: 'FORUM', connectorKey: 'discourse', mode: PlatformMode.COMPATIBLE_API, availability: PlatformAvailability.CREDENTIAL_REQUIRED, docsUrl: 'https://docs.discourse.org/', defaultSettings: { baseUrl: 'https://forums.truenas.com' }, promptHint: 'Include TrueNAS edition/version, storage topology, diagnostics, and safe troubleshooting context without exposing secrets.' },
  { slug: 'unraid-forums', name: 'Unraid Forums', groupKey: 'FORUM', defaultSettings: { manualUrl: 'https://forums.unraid.net/' }, promptHint: 'State the Unraid version, relevant hardware or containers, symptoms, and diagnostics already collected.' },
  { slug: 'flipboard', name: 'Flipboard', groupKey: 'MEDIA', defaultSettings: { manualUrl: 'https://flipboard.com/' }, promptHint: 'Create a concise curation headline and summary that accurately represents the linked story.' },
  { slug: 'scoop-it', name: 'Scoop.it', groupKey: 'MEDIA', availability: PlatformAvailability.API_REVIEW_REQUIRED, docsUrl: 'https://www.scoop.it/dev/api/1/urls', defaultSettings: { manualUrl: 'https://www.scoop.it/' }, promptHint: 'Add an original curator insight, a faithful summary, and topic-specific keywords instead of copying the source.' },
  { slug: 'hugging-face', name: 'Hugging Face', groupKey: 'DEVELOPER', defaultSettings: { manualUrl: 'https://huggingface.co/new-space' }, promptHint: 'State the model, dataset, or Space purpose, intended use, limitations, reproducibility details, and license only when known.' },
  { slug: 'directadmin-forums', name: 'DirectAdmin Forums', groupKey: 'FORUM', docsUrl: 'https://forum.directadmin.com/help/terms/', defaultSettings: { manualUrl: 'https://forum.directadmin.com/' }, promptHint: 'Include DirectAdmin and OS versions, sanitized configuration, logs, and the exact administration issue. Use plain text or XenForo BBCode-compatible structure instead of Markdown-specific syntax.' },
  { slug: 'almalinux-forum', name: 'AlmaLinux Forum', groupKey: 'FORUM', connectorKey: 'discourse', mode: PlatformMode.COMPATIBLE_API, availability: PlatformAvailability.CREDENTIAL_REQUIRED, docsUrl: 'https://docs.discourse.org/', defaultSettings: { baseUrl: 'https://forums.almalinux.org' }, promptHint: 'Include AlmaLinux version, package sources, commands attempted, and sanitized output.' },
  { slug: 'linux-containers-forum', name: 'Linux Containers Forum', groupKey: 'FORUM', connectorKey: 'discourse', mode: PlatformMode.COMPATIBLE_API, availability: PlatformAvailability.CREDENTIAL_REQUIRED, docsUrl: 'https://docs.discourse.org/', defaultSettings: { baseUrl: 'https://discuss.linuxcontainers.org' }, promptHint: 'Identify LXD, Incus, or LXC clearly, include versions and storage/network context, and provide reproducible diagnostics.' },
  { slug: 'linux-foundation-forum', name: 'Linux Foundation Forum', groupKey: 'FORUM', defaultSettings: { manualUrl: 'https://forum.linuxfoundation.org/' }, promptHint: 'Write for an open-source professional audience, identify the relevant project, and focus on a constructive technical question.' },
  { slug: 'warrior-forum', name: 'Warrior Forum', groupKey: 'FORUM', defaultSettings: { manualUrl: 'https://www.warriorforum.com/' }, promptHint: 'Offer a concrete marketing lesson with evidence from the source and avoid hype, income promises, or link dropping.' },
  { slug: 'disqus', name: 'Disqus', groupKey: 'COMMUNITY', availability: PlatformAvailability.API_REVIEW_REQUIRED, docsUrl: 'https://disqus.com/api/docs/posts/create/', defaultSettings: { manualUrl: 'https://disqus.com/' }, promptHint: 'Write a relevant, self-contained comment that responds to the discussion and avoids promotional links.' },
  { slug: 'eventbrite', name: 'Eventbrite', groupKey: 'EVENT', availability: PlatformAvailability.API_REVIEW_REQUIRED, docsUrl: 'https://www.eventbrite.com/platform/new/api', defaultSettings: { manualUrl: 'https://www.eventbrite.com/manage/events/create' }, promptHint: 'Create a discoverable event title, honest value proposition, audience, agenda, and registration description from supplied facts only.' },
  { slug: 'nginx-community', name: 'NGINX Community', groupKey: 'FORUM', connectorKey: 'discourse', mode: PlatformMode.COMPATIBLE_API, availability: PlatformAvailability.CREDENTIAL_REQUIRED, docsUrl: 'https://docs.discourse.org/', defaultSettings: { baseUrl: 'https://community.nginx.org' }, promptHint: 'Include NGINX product/version, a sanitized configuration excerpt, expected behavior, actual behavior, and relevant logs.' },
  { slug: 'gumroad', name: 'Gumroad', groupKey: 'COMMERCE', defaultSettings: { manualUrl: 'https://app.gumroad.com/products/new' }, promptHint: 'Write a clear product title, benefit-led description, included deliverables, target buyer, and transparent purchase call to action.' },
  { slug: 'caddy-community', name: 'Caddy Community', groupKey: 'FORUM', connectorKey: 'discourse', mode: PlatformMode.COMPATIBLE_API, availability: PlatformAvailability.CREDENTIAL_REQUIRED, docsUrl: 'https://docs.discourse.org/', defaultSettings: { baseUrl: 'https://caddy.community' }, promptHint: 'Include Caddy version, formatted Caddyfile, environment, expected result, actual result, and logs with private data removed.' },
  { slug: 'hestiacp-forum', name: 'HestiaCP Forum', groupKey: 'FORUM', connectorKey: 'discourse', mode: PlatformMode.COMPATIBLE_API, availability: PlatformAvailability.CREDENTIAL_REQUIRED, docsUrl: 'https://docs.discourse.org/', defaultSettings: { baseUrl: 'https://forum.hestiacp.com' }, promptHint: 'Include HestiaCP and OS versions, related service, sanitized commands, and exact symptoms.' },
  { slug: 'aapanel-forum', name: 'aaPanel Forum', groupKey: 'FORUM', defaultSettings: { manualUrl: 'https://www.aapanel.com/forum/' }, promptHint: 'Include aaPanel and OS versions, plugin or service involved, and sanitized diagnostic output.' },
  { slug: 'cpanel-community', name: 'cPanel Community', groupKey: 'FORUM', defaultSettings: { manualUrl: 'https://support.cpanel.net/hc/en-us/community/topics' }, promptHint: 'Include cPanel/WHM tier and version, OS, affected service, and sanitized logs.' },
  { slug: 'mikrotik-community', name: 'MikroTik Community', groupKey: 'FORUM', connectorKey: 'discourse', mode: PlatformMode.COMPATIBLE_API, availability: PlatformAvailability.CREDENTIAL_REQUIRED, docsUrl: 'https://docs.discourse.org/', defaultSettings: { baseUrl: 'https://forum.mikrotik.com' }, promptHint: 'Include RouterOS version, device model, topology, sanitized export, expected behavior, and observed behavior.' },
  { slug: 'ubiquiti-community', name: 'Ubiquiti Community', groupKey: 'FORUM', defaultSettings: { manualUrl: 'https://community.ui.com/' }, promptHint: 'Identify the UniFi product and versions, topology, troubleshooting performed, and sanitized logs.' },
  { slug: 'cloudpanel-forum', name: 'CloudPanel Forum', groupKey: 'FORUM', defaultSettings: { manualUrl: 'https://www.cloudpanel.io/' }, promptHint: 'Include CloudPanel and OS versions, application stack, symptoms, and sanitized service logs.' },
  { slug: 'opennebula-community', name: 'OpenNebula Community', groupKey: 'FORUM', connectorKey: 'discourse', mode: PlatformMode.COMPATIBLE_API, availability: PlatformAvailability.CREDENTIAL_REQUIRED, docsUrl: 'https://docs.discourse.org/', defaultSettings: { baseUrl: 'https://forum.opennebula.io' }, promptHint: 'Include OpenNebula version, hypervisor or cloud context, relevant templates, and sanitized logs.' },
  { slug: 'unix-linux-stackexchange', name: 'Unix & Linux Stack Exchange', groupKey: 'DEVELOPER', defaultSettings: { manualUrl: 'https://unix.stackexchange.com/questions/ask' }, promptHint: 'Draft a narrowly scoped Unix/Linux question with distribution, shell, command, expected output, actual output, and research attempted.' },
  { slug: 'replit-community', name: 'Replit Community', groupKey: 'FORUM', defaultSettings: { manualUrl: 'https://replit.com/community' }, promptHint: 'Include language/runtime, Repl environment, minimal reproduction, errors, and the learning goal.' },
  { slug: 'mongodb-community', name: 'MongoDB Community', groupKey: 'FORUM', connectorKey: 'discourse', mode: PlatformMode.COMPATIBLE_API, availability: PlatformAvailability.CREDENTIAL_REQUIRED, docsUrl: 'https://docs.discourse.org/', defaultSettings: { baseUrl: 'https://www.mongodb.com/community/forums' }, promptHint: 'Include MongoDB product/version, deployment topology, schema/query sample with private data removed, explain output, and expected result.' },
  { slug: 'redis-community-forum', name: 'Redis Community Forum', groupKey: 'FORUM', defaultSettings: { manualUrl: 'https://redis.io/community/' }, promptHint: 'Include Redis product/version, topology, commands, sanitized diagnostics, expected behavior, and observed behavior.' },
  { slug: 'tiktok', name: 'TikTok', groupKey: 'MEDIA', availability: PlatformAvailability.API_REVIEW_REQUIRED, docsUrl: 'https://developers.tiktok.com/products/content-posting-api', defaultSettings: { manualUrl: 'https://www.tiktok.com/upload' }, promptHint: 'Create a short-video hook, concise caption, on-screen-text suggestion, accessible description, and relevant hashtags without engagement bait.' },
  { slug: 'discourse', name: 'Discourse', groupKey: 'FORUM', connectorKey: 'discourse', mode: PlatformMode.COMPATIBLE_API, availability: PlatformAvailability.CREDENTIAL_REQUIRED, docsUrl: 'https://docs.discourse.org/', promptHint: 'Respect the selected site category and tag rules, provide context, and invite constructive discussion without cross-post spam.' },
];

export const PLATFORM_CATALOG: readonly PlatformCatalogEntry[] = definitions.map(definePlatform);

export function assertPlatformCatalog(): void {
  const slugs = new Set<string>();
  for (const platform of PLATFORM_CATALOG) {
    if (slugs.has(platform.slug)) throw new Error(`Duplicate platform slug '${platform.slug}'`);
    slugs.add(platform.slug);
    const automation = platform.capability.metadata.automation;
    if (platform.mode === PlatformMode.BROWSER_ASSISTED) {
      if (
        platform.connectorKey !== 'browser-assisted'
        || automation.status !== 'READY_AFTER_LOGIN'
        || automation.route !== 'PLAYWRIGHT'
        || !automation.browserRecipe
        || platform.defaultSettings.browserRecipe !== automation.browserRecipe
      ) {
        throw new Error(`Browser-assisted platform '${platform.slug}' has inconsistent recipe metadata`);
      }
      if (
        platform.defaultSettings.browserAutoSubmit !== false
        || platform.defaultSettings.automationPermissionAttested !== false
      ) {
        throw new Error(`Browser-assisted platform '${platform.slug}' must fail closed by default`);
      }
      for (const key of automation.requiredAccountSettings ?? []) {
        if (!(key in platform.defaultSettings)) {
          throw new Error(`Browser-assisted platform '${platform.slug}' has no default for '${key}'`);
        }
      }
    }
    if (
      (platform.mode === PlatformMode.OFFICIAL_API || platform.mode === PlatformMode.COMPATIBLE_API)
      && (automation.route !== 'API' || automation.status !== 'READY_AFTER_CREDENTIALS')
    ) {
      throw new Error(`API platform '${platform.slug}' has inconsistent automation metadata`);
    }
    if (platform.mode === PlatformMode.MANUAL && automation.automaticPublishing) {
      throw new Error(`Manual platform '${platform.slug}' cannot advertise automatic publishing`);
    }
  }
  for (const recipe of REVIEWED_BROWSER_RECIPE_MANIFEST) {
    const platform = PLATFORM_CATALOG.find(({ slug }) => slug === recipe.platformSlug);
    if (
      !platform
      || platform.mode !== PlatformMode.BROWSER_ASSISTED
      || platform.capability.metadata.automation.browserRecipe !== recipe.key
    ) {
      throw new Error(`Reviewed browser recipe '${recipe.key}' is not bound to its platform`);
    }
  }
}
