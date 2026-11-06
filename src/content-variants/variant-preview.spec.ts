import { EXTENSION_RECIPES } from '../connectors/extension/extension-delivery';
import { PrismaService } from '../database/prisma.service';
import { ContentVariantsService } from './content-variants.service';
import type { VariantApprovalService } from './variant-approval.service';
import { previewRoute, variantPreview, type PreviewRoute } from './variant-preview';

const markdown = '## Why\n\nA **fast** VPS with `nvme` disks.\n\n- 2 vCPU\n- 4 GB RAM';

describe('post preview shown during review', () => {
  it('shows a short-form post as plain text with its hashtags inline and the character limit', () => {
    const preview = variantPreview({ title: 'Ignored title', body: markdown, hashtags: ['VPS', '#Linux'] }, 'mastodon', undefined, null);
    expect(preview).toMatchObject({ title: '', format: 'plain', tags: [], group: 'SOCIAL', engine: 'mastodon', maxChars: 500, overLimit: false });
    expect(preview.body).toBe('Why\n\nA fast VPS with nvme disks.\n\n• 2 vCPU\n• 4 GB RAM\n\n#VPS #Linux');
    expect(preview.length).toBe([...preview.body].length);
    expect(variantPreview({ title: null, body: 'x'.repeat(600), hashtags: [] }, 'mastodon', undefined, null).overLimit).toBe(true);
  });

  it('keeps Markdown, the title and a separate tag field for a Discourse forum', () => {
    const preview = variantPreview({ title: 'NVMe VPS benchmarks', body: markdown, hashtags: ['vps', 'nginx'] }, 'nginx-community', undefined, 'https://example.test/post');
    expect(preview).toMatchObject({ title: 'NVMe VPS benchmarks', format: 'markdown', tags: ['vps', 'nginx'], group: 'FORUM', engine: 'discourse', maxChars: null });
    expect(preview.body).toContain('**fast**');
    expect(preview.body).toMatch(/Source: https:\/\/example\.test\/post$/);
  });

  it('cuts a title to the destination limit and uses the account posting route when given', () => {
    const preview = variantPreview({ title: `${'word '.repeat(60)}end`, body: 'Body', hashtags: [] }, 'stack-overflow', undefined, null);
    expect([...preview.title].length).toBeLessThanOrEqual(150);
    expect(variantPreview({ title: 'T', body: markdown, hashtags: [] }, 'devto', 'devto', null).format).toBe('markdown');
  });
});

describe('preview of the destination: appearance, tags really sent, where it goes', () => {
  const extension = (engine: string, targetUrl: string, extra: Record<string, unknown> = {}) =>
    previewRoute({ delivery: 'extension', extensionEngine: engine, extensionTargetUrl: targetUrl, extensionAutoSubmit: true, ...extra }) as PreviewRoute;
  // Rich-text editors get pasted HTML (the extension recipe says so).
  const medium = EXTENSION_RECIPES.medium;
  const mediumInput = medium.inputMode;
  beforeAll(() => { medium.inputMode = 'pasteHtml'; });
  afterAll(() => { medium.inputMode = mediumInput; });

  it('tells the page how to show the body: plain, Markdown, or rich text', () => {
    expect(variantPreview({ title: null, body: markdown, hashtags: [] }, 'mastodon', undefined, null).appearance).toBe('plain');
    expect(variantPreview({ title: 'T', body: markdown, hashtags: [] }, 'nginx-community', undefined, null).appearance).toBe('markdown');
    expect(variantPreview({ title: 'T', body: '<p>Hi</p>', hashtags: [] }, 'wordpress', undefined, null)).toMatchObject({ appearance: 'rich', format: 'html' });
    const rich = variantPreview({ title: 'NVMe', body: markdown, hashtags: [] }, 'medium', undefined, 'https://vpsttt.vn/a', extension('medium', 'https://medium.com/new-story'));
    // The Markdown is kept for the page to render as the editor will show it.
    expect(rich).toMatchObject({ appearance: 'rich', engine: 'medium' });
    expect(rich.body).toBe(`${markdown}\n\nSource: https://vpsttt.vn/a`);
    // The same platform through its API never goes through the rich editor.
    expect(variantPreview({ title: 'NVMe', body: markdown, hashtags: [] }, 'medium', undefined, null, { delivery: 'api' }).appearance).toBe('plain');
  });

  it('lists the tags really sent: the account tags then the AI tags the site accepts, none for inline hashtags', () => {
    const question = { title: 'curl with --socks5', body: 'Question body', hashtags: ['#curl', 'Proxy', 'linux', 'dns'] };
    const stack = extension('stackexchange', 'https://unix.stackexchange.com/questions/ask', { extensionTags: ['linux'] });
    expect(variantPreview(question, 'unix-linux-stackexchange', undefined, null, stack).tags).toEqual(['linux', 'curl', 'proxy', 'dns']);
    // Medium's extension flow has no tag field it fills: only the account's own tags.
    expect(variantPreview(question, 'medium', undefined, null, extension('medium', 'https://medium.com/new-story', { extensionTags: ['devops'] })).tags).toEqual(['devops']);
    expect(variantPreview(question, 'mastodon', undefined, null, extension('mastodon', 'https://mastodon.social/publish')).tags).toEqual([]);
    // An API account keeps the AI tags as they are.
    expect(variantPreview(question, 'devto', undefined, null, { delivery: 'api' }).tags).toEqual(['curl', 'Proxy', 'linux', 'dns']);
  });

  it('says where the post goes: community, subreddit, category, flair and language', () => {
    const post = { title: 'Self-hosting on a small VPS', body: 'We moved our website to a new server and page load time dropped a lot, here are the steps.', hashtags: [] };
    expect(variantPreview(post, 'lemmy-world', undefined, null, extension('lemmy', 'https://lemmy.world/create_post', { extensionCategory: 'selfhosted' })).destination)
      .toEqual({ community: 'selfhosted', language: 'en' });
    expect(variantPreview(post, 'reddit', undefined, null, extension('reddit', 'https://www.reddit.com/r/selfhosted/submit', { extensionFlair: 'Guide' })).destination)
      .toEqual({ community: 'r/selfhosted', flair: 'Guide', language: 'en' });
    expect(variantPreview(post, 'nginx-community', undefined, null, extension('discourse', 'https://community.nginx.org/new-topic', { extensionCategory: 'general' })).destination)
      .toEqual({ category: 'general', language: 'en' });
    expect(variantPreview({ ...post, body: 'Mình vừa chuyển website sang máy chủ mới và thời gian tải trang giảm hẳn.' }, 'mastodon', undefined, null, { delivery: 'api' }).destination)
      .toEqual({ language: 'vi' });
  });

  it('counts a Mastodon link as 23 characters, like Mastodon', () => {
    const link = `https://vpsttt.vn/blog/${'huong-dan-'.repeat(30)}`;
    const preview = variantPreview({ title: null, body: `${'a'.repeat(450)} ${link}`, hashtags: [] }, 'mastodon', undefined, 'https://vpsttt.vn/a');
    // 450 + space + link (23) + blank line + "Source: " + link (23).
    expect(preview).toMatchObject({ length: 450 + 1 + 23 + 2 + 8 + 23, maxChars: 500, overLimit: true });
    expect(variantPreview({ title: null, body: `${'a'.repeat(400)} ${link}`, hashtags: [] }, 'mastodon', undefined, null).overLimit).toBe(false);
  });

  it('shows no title field for Quora: a written title goes above the body, the first line is never repeated', () => {
    const body = 'Short answer: yes.\n\nWe moved our website to a new server and page load time dropped a lot.';
    const quora = extension('quora', 'https://www.quora.com/');
    expect(variantPreview({ title: null, body, hashtags: [] }, 'quora', undefined, null, quora)).toMatchObject({ title: '', body });
    expect(variantPreview({ title: 'Is a VPS worth it?', body, hashtags: [] }, 'quora', undefined, null, quora))
      .toMatchObject({ title: '', body: `Is a VPS worth it?\n\n${body}` });
  });
});

describe('ContentVariantsService.preview', () => {
  function setup(account: unknown) {
    const prisma = {
      contentVariant: { findFirstOrThrow: jest.fn().mockResolvedValue({ title: 'Stored', body: 'Stored body', hashtags: ['vps'], platformId: 'platform-1', platform: { slug: 'nginx-community' }, content: { canonicalUrl: null } }) },
      platformAccount: { findFirst: jest.fn().mockResolvedValue(account) },
    };
    return { prisma, service: new ContentVariantsService(prisma as unknown as PrismaService, { enabled: () => false } as unknown as VariantApprovalService) };
  }

  it('previews unsaved edits of an owned variant and reads the route only from the same owner and platform', async () => {
    const { prisma, service } = setup({ settings: { delivery: 'extension', extensionEngine: 'discourse', extensionTargetUrl: 'https://community.nginx.org/new-topic', extensionAutoSubmit: true } });
    const preview = await service.preview('owner-1', 'variant-1', { title: 'Edited', body: 'Edited body', platformAccountId: 'account-1' });
    expect(prisma.contentVariant.findFirstOrThrow).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'variant-1', content: { ownerId: 'owner-1' } } }));
    expect(prisma.platformAccount.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'account-1', ownerId: 'owner-1', platformId: 'platform-1' } }));
    expect(preview).toMatchObject({ title: 'Edited', body: 'Edited body', tags: ['vps'], engine: 'discourse' });
  });

  it('reads where an extension account posts, and treats an API account as the API route', async () => {
    const { service } = setup({ settings: { delivery: 'extension', extensionEngine: 'discourse', extensionTargetUrl: 'https://community.nginx.org/new-topic', extensionAutoSubmit: true, extensionTags: ['nginx'], extensionCategory: 'general' } });
    await expect(service.preview('owner-1', 'variant-1', { platformAccountId: 'account-1' }))
      .resolves.toMatchObject({ tags: ['nginx', 'vps'], destination: { category: 'general' } });
    const api = setup({ settings: {} });
    await expect(api.service.preview('owner-1', 'variant-1', { platformAccountId: 'account-1' }))
      .resolves.toMatchObject({ tags: ['vps'], destination: { language: 'en' }, engine: 'discourse' });
  });

  it('falls back to the stored text and the platform default without an account', async () => {
    const { prisma, service } = setup(null);
    await expect(service.preview('owner-1', 'variant-1', {})).resolves.toMatchObject({ title: 'Stored', body: 'Stored body' });
    expect(prisma.platformAccount.findFirst).not.toHaveBeenCalled();
  });
});
