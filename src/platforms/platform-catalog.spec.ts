import { PlatformAvailability, PlatformMode } from '@prisma/client';
import { assertPlatformCatalog, PLATFORM_CATALOG } from './platform-catalog';

const EXPECTED_SLUGS = [
  'instagram', 'threads', 'x', 'linkedin', 'wordpress', 'medium', 'blogger',
  'substack', 'tumblr', 'devto', 'quora', 'discord', 'reddit', 'slideshare',
  'bluesky', 'aws-community', 'mastodon', 'mastodon-social', 'tinhte',
  'vivaldi-social', 'pixelfed-social', 'voz-forums', 'kubeby', 'lemmy-world',
  'discuit', 'minds', 'mewe', 'dzone', 'daily-dev', 'differ', 'product-hunt',
  'dailymotion', 'in-plain-english', 'hub', 'stack-overflow', 'server-fault',
  'level1techs-forum', 'truenas-community', 'unraid-forums', 'flipboard',
  'scoop-it', 'hugging-face', 'directadmin-forums', 'almalinux-forum',
  'linux-containers-forum', 'linux-foundation-forum', 'warrior-forum',
  'disqus', 'eventbrite', 'nginx-community', 'gumroad', 'caddy-community',
  'hestiacp-forum', 'aapanel-forum', 'cpanel-community', 'mikrotik-community',
  'ubiquiti-community', 'cloudpanel-forum', 'opennebula-community',
  'unix-linux-stackexchange', 'replit-community', 'mongodb-community',
  'redis-community-forum', 'tiktok', 'discourse',
] as const;

describe('platform catalog', () => {
  it('covers the deduplicated requested catalog plus generic connector entries', () => {
    expect(() => assertPlatformCatalog()).not.toThrow();
    const slugs = PLATFORM_CATALOG.map(({ slug }) => slug);
    expect(slugs).toHaveLength(65);
    expect(new Set(slugs).size).toBe(slugs.length);
    expect([...slugs].sort()).toEqual([...EXPECTED_SLUGS].sort());
    expect(PLATFORM_CATALOG.filter(({ slug }) => slug === 'differ')).toHaveLength(1);
    expect(PLATFORM_CATALOG.filter(({ slug }) => slug === 'mewe')).toHaveLength(1);
  });

  it('keeps Medium on a manual handoff because automated browser posting is not permitted by default', () => {
    const medium = PLATFORM_CATALOG.find(({ slug }) => slug === 'medium');
    expect(medium).toMatchObject({
      connectorKey: 'manual',
      mode: PlatformMode.MANUAL,
      availability: PlatformAvailability.MANUAL_ONLY,
      defaultSettings: {
        manualUrl: 'https://medium.com/new-story',
      },
    });
    expect(JSON.stringify(medium)).not.toMatch(/rapidapi|apiKey|secret|browserRecipe|browserAutoSubmit/i);
    expect(medium?.capability.metadata.automation).toEqual({
      status: 'POLICY_BLOCKED',
      route: 'NONE',
      automaticPublishing: false,
      reasonCode: 'PLATFORM_POLICY_PROHIBITS_AUTOMATION',
    });
    expect(PLATFORM_CATALOG.find(({ slug }) => slug === 'in-plain-english')?.capability.metadata.automation)
      .toMatchObject({ status: 'POLICY_BLOCKED', route: 'NONE' });
    for (const platform of PLATFORM_CATALOG) {
      expect(Object.keys(platform.defaultSettings).join(',')).not.toMatch(/api.?key|secret|token|password/i);
    }
  });

  it('routes platforms with confirmed public publishing APIs to connector review instead of Playwright', () => {
    const apiCandidates = [
      'tumblr',
      'reddit',
      'pixelfed-social',
      'lemmy-world',
      'dailymotion',
      'scoop-it',
      'disqus',
      'eventbrite',
      'tiktok',
    ];
    for (const slug of apiCandidates) {
      expect(PLATFORM_CATALOG.find((platform) => platform.slug === slug)).toMatchObject({
        mode: PlatformMode.MANUAL,
        availability: PlatformAvailability.API_REVIEW_REQUIRED,
        capability: {
          metadata: {
            automation: {
              status: 'API_CONNECTOR_REQUIRED',
              route: 'API',
              automaticPublishing: false,
              reasonCode: 'PUBLIC_API_CONNECTOR_NOT_IMPLEMENTED',
            },
          },
        },
      });
      expect(PLATFORM_CATALOG.find((platform) => platform.slug === slug)?.docsUrl)
        .toMatch(/^https:\/\//);
    }
  });

  it('advertises a single DEV article main image while keeping drafts as the default', () => {
    expect(PLATFORM_CATALOG.find(({ slug }) => slug === 'devto')).toMatchObject({
      capability: { image: true, maxImages: 1 },
      defaultSettings: { publishImmediately: false },
    });
  });

  it('reuses connector implementations only for compatible platforms', () => {
    expect(PLATFORM_CATALOG.find(({ slug }) => slug === 'mastodon-social')?.connectorKey).toBe('mastodon');
    expect(PLATFORM_CATALOG.find(({ slug }) => slug === 'vivaldi-social')?.connectorKey).toBe('mastodon');
    expect(PLATFORM_CATALOG.find(({ slug }) => slug === 'truenas-community')?.connectorKey).toBe('discourse');
    expect(PLATFORM_CATALOG.find(({ slug }) => slug === 'mikrotik-community')).toMatchObject({
      connectorKey: 'discourse',
      mode: PlatformMode.COMPATIBLE_API,
      defaultSettings: { baseUrl: 'https://forum.mikrotik.com' },
    });
    expect(PLATFORM_CATALOG.find(({ slug }) => slug === 'replit-community')).toMatchObject({
      connectorKey: 'manual',
      mode: PlatformMode.MANUAL,
    });
    expect(PLATFORM_CATALOG.find(({ slug }) => slug === 'redis-community-forum')).toMatchObject({
      connectorKey: 'manual',
      mode: PlatformMode.MANUAL,
    });
    expect(PLATFORM_CATALOG.find(({ slug }) => slug === 'hub')).toMatchObject({
      enabled: false,
      availability: PlatformAvailability.API_RESEARCH_REQUIRED,
    });
  });

  it('enables only the live-verified XenForo browser adapter with submission disabled by default', () => {
    expect(PLATFORM_CATALOG.find(({ slug }) => slug === 'voz-forums')).toMatchObject({
      connectorKey: 'browser-assisted',
      mode: PlatformMode.BROWSER_ASSISTED,
      availability: PlatformAvailability.CREDENTIAL_REQUIRED,
      defaultSettings: {
        browserRecipe: 'voz-xenforo',
        forumPath: '',
        browserAutoSubmit: false,
        automationPermissionAttested: false,
      },
      capability: {
        metadata: {
          automation: {
            status: 'READY_AFTER_LOGIN',
            route: 'PLAYWRIGHT',
            automaticPublishing: true,
            browserRecipe: 'voz-xenforo',
            browserRecipeRevision: 1,
            loginCaptureRequired: true,
            permissionAttestationRequired: true,
            autoSubmitDefault: false,
            mediaUploadSupported: false,
            requiredAccountSettings: [
              'forumPath',
              'automationPermissionAttested',
              'browserAutoSubmit',
            ],
          },
        },
      },
    });
    expect(PLATFORM_CATALOG.find(({ slug }) => slug === 'directadmin-forums')).toMatchObject({
      connectorKey: 'manual',
      mode: PlatformMode.MANUAL,
      availability: PlatformAvailability.MANUAL_ONLY,
      defaultSettings: { manualUrl: 'https://forum.directadmin.com/' },
    });
    expect(PLATFORM_CATALOG.find(({ slug }) => slug === 'tinhte')).toMatchObject({
      connectorKey: 'manual',
      mode: PlatformMode.MANUAL,
      capability: {
        metadata: {
          automation: {
            status: 'BROWSER_RECIPE_REVIEW_REQUIRED',
            route: 'PLAYWRIGHT',
            automaticPublishing: false,
          },
        },
      },
    });
  });

  it('publishes a deterministic automation status for every platform', () => {
    for (const platform of PLATFORM_CATALOG) {
      const automation = platform.capability.metadata.automation;
      expect(automation.status).toBeTruthy();
      expect(['API', 'PLAYWRIGHT', 'NONE']).toContain(automation.route);
      if (platform.mode === PlatformMode.MANUAL) {
        expect(automation.automaticPublishing).toBe(false);
      }
    }
  });

  it('provides a tailored v2-ready prompt rule for every entry', () => {
    for (const platform of PLATFORM_CATALOG) {
      expect(platform.promptRule).toContain(platform.name);
      expect(platform.promptRule.length).toBeGreaterThan(180);
    }
  });
});
