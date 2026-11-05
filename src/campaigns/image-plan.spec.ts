import { accountImageNeed, imageSizeFor, planImages } from './image-plan';

const social = { text: true, image: true };
const extension = (engine: string, targetUrl: string) => ({ delivery: 'extension', extensionEngine: engine, extensionTargetUrl: targetUrl, extensionAutoSubmit: true });
const connectors = {
  has: (key: string) => ['instagram', 'discord', 'bluesky', 'extension'].includes(key),
  get: (key: string) => ({ capability: {
    instagram: { text: false, image: true },
    discord: { text: true, image: true },
    bluesky: { text: true, image: false },
    extension: { text: true, image: false },
  }[key] as never }),
};

const pixelfed = { settings: extension('pixelfed', 'https://pixelfed.social/i/web'), platform: { slug: 'pixelfed-social', capability: social } };
const blueskyChrome = { settings: extension('bluesky', 'https://bsky.app/intent/compose'), platform: { slug: 'bluesky', connectorKey: 'bluesky', capability: social } };
const blueskyApi = { settings: {}, platform: { slug: 'bluesky', connectorKey: 'bluesky', capability: social } };
const forum = { settings: extension('discourse', 'https://forum.hestiacp.com/new-topic'), platform: { slug: 'hestiacp-forum', capability: { text: true, image: false } } };
const instagram = { settings: {}, platform: { slug: 'instagram', connectorKey: 'instagram', capability: { text: false, image: true } } };
const discord = { settings: {}, platform: { slug: 'discord', connectorKey: 'discord', capability: social } };
const differ = { settings: extension('differ', 'https://differ.blog/new-story'), platform: { slug: 'differ', capability: social } };

describe('which destinations get an AI image', () => {
  it('follows what each publishing route can attach', () => {
    expect(accountImageNeed(pixelfed, connectors)).toBe('required');
    expect(accountImageNeed(blueskyChrome, connectors)).toBe('optional');
    expect(accountImageNeed(blueskyApi, connectors)).toBe('none');
    expect(accountImageNeed(forum, connectors)).toBe('none');
    expect(accountImageNeed(instagram, connectors)).toBe('required');
    expect(accountImageNeed(discord, connectors)).toBe('optional');
    // Differ's publish dialog takes an optional featured image.
    expect(accountImageNeed(differ, connectors)).toBe('optional');
    expect(accountImageNeed({ ...discord, platform: { ...discord.platform, capability: { text: true, image: false } } }, connectors)).toBe('none');
  });

  it('plans one image per destination with a fitting size, none for forums', () => {
    const plan = planImages([pixelfed, blueskyChrome, blueskyApi, forum, discord], { enabled: true, userImage: false }, connectors);
    expect([...plan.keys()].sort()).toEqual(['bluesky', 'discord', 'pixelfed-social']);
    expect(plan.get('pixelfed-social')).toMatchObject({ need: 'required', size: '1024x1024' });
    expect(plan.get('bluesky')).toMatchObject({ need: 'optional', size: '1536x1024' });
    expect(plan.get('bluesky')!.style).toMatch(/editorial/);
    expect(imageSizeFor('instagram')).toBe('1024x1024');
  });

  it('creates no AI image when the user supplied one or switched the option off', () => {
    expect(planImages([pixelfed, discord], { enabled: true, userImage: true }, connectors).size).toBe(0);
    expect(planImages([pixelfed, discord], { enabled: false, userImage: false }, connectors).size).toBe(0);
  });
});
