import { PrismaService } from '../database/prisma.service';
import { ContentVariantsService } from './content-variants.service';
import { variantPreview } from './variant-preview';

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

describe('ContentVariantsService.preview', () => {
  function setup(account: unknown) {
    const prisma = {
      contentVariant: { findFirstOrThrow: jest.fn().mockResolvedValue({ title: 'Stored', body: 'Stored body', hashtags: ['vps'], platformId: 'platform-1', platform: { slug: 'nginx-community' }, content: { canonicalUrl: null } }) },
      platformAccount: { findFirst: jest.fn().mockResolvedValue(account) },
    };
    return { prisma, service: new ContentVariantsService(prisma as unknown as PrismaService) };
  }

  it('previews unsaved edits of an owned variant and reads the route only from the same owner and platform', async () => {
    const { prisma, service } = setup({ settings: { delivery: 'extension', extensionEngine: 'discourse', extensionTargetUrl: 'https://community.nginx.org/new-topic', extensionAutoSubmit: true } });
    const preview = await service.preview('owner-1', 'variant-1', { title: 'Edited', body: 'Edited body', platformAccountId: 'account-1' });
    expect(prisma.contentVariant.findFirstOrThrow).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'variant-1', content: { ownerId: 'owner-1' } } }));
    expect(prisma.platformAccount.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'account-1', ownerId: 'owner-1', platformId: 'platform-1' } }));
    expect(preview).toMatchObject({ title: 'Edited', body: 'Edited body', tags: ['vps'], engine: 'discourse' });
  });

  it('falls back to the stored text and the platform default without an account', async () => {
    const { prisma, service } = setup(null);
    await expect(service.preview('owner-1', 'variant-1', {})).resolves.toMatchObject({ title: 'Stored', body: 'Stored body' });
    expect(prisma.platformAccount.findFirst).not.toHaveBeenCalled();
  });
});
