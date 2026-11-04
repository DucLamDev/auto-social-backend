import { ConfigService } from '@nestjs/config';
import { PublishJobStatus } from '@prisma/client';
import { CampaignStatusService } from '../campaigns/campaign-status.service';
import { sha256 } from '../common/utils/crypto.utils';
import { PrismaService } from '../database/prisma.service';
import { StorageService } from '../storage/storage.service';
import { createHash } from 'node:crypto';
import { EXTENSION_CONTENT_TOO_LONG, EXTENSION_RESULT_UNKNOWN, ExtensionAgentService, forumPost, threadIdFromUrl } from './extension-agent.service';
import { EXTENSION_RECIPES } from '../connectors/extension/extension-delivery';
import { ExtensionSelectorSuggestionService } from './ui-recovery/selector-suggestion.service';

const device = { id: 'dev-1', ownerId: 'owner-1', name: 'Chrome' };
const settings = { delivery: 'extension', extensionEngine: 'xenforo', extensionTargetUrl: 'https://voz.vn/f/a.17/post-thread', extensionAutoSubmit: true };

function setup() {
  const tx = {
    publishJob: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    publishedPost: { create: jest.fn().mockResolvedValue({}) },
    publishAttempt: { findFirst: jest.fn().mockResolvedValue({ id: 'att-1', responseMetadata: { extensionQueued: true } }), update: jest.fn().mockResolvedValue({}) },
  };
  const prisma = {
    extensionDevice: { findUnique: jest.fn(), update: jest.fn().mockResolvedValue({}), create: jest.fn(), updateMany: jest.fn(), count: jest.fn().mockResolvedValue(1) },
    publishJob: { findFirst: jest.fn(), findUniqueOrThrow: jest.fn(), updateMany: jest.fn().mockResolvedValue({ count: 1 }), count: jest.fn().mockResolvedValue(0) },
    publishAttempt: { findFirst: jest.fn().mockResolvedValue({ id: 'att-1', responseMetadata: { extensionQueued: true } }), update: jest.fn().mockResolvedValue({}) },
    platformAccount: { findMany: jest.fn().mockResolvedValue([]), findFirst: jest.fn(), update: jest.fn() },
    mediaAsset: { findFirst: jest.fn() },
    $transaction: jest.fn((run: (client: typeof tx) => Promise<unknown>) => run(tx)),
  };
  const campaignStatus = { refresh: jest.fn().mockResolvedValue(undefined) };
  const storage = { get: jest.fn() };
  const service = new ExtensionAgentService(prisma as unknown as PrismaService, campaignStatus as unknown as CampaignStatusService, storage as unknown as StorageService);
  return { service, prisma, tx, campaignStatus, storage };
}

const claimedJob = {
  id: 'job-1', status: PublishJobStatus.NEEDS_ACTION, lockedAt: new Date(), platformAccountId: 'acc-1',
  target: { campaignId: 'camp-1' }, platformAccount: { settings },
};

describe('ExtensionAgentService', () => {
  it('keeps the social title intact and uses the variant attachment before the content fallback', async () => {
    const { service, prisma } = setup();
    const socialSettings = { ...settings, extensionEngine: 'slideshare', extensionTargetUrl: 'https://www.slideshare.net/upload' };
    const title = 'Approved title '.repeat(15).trim();
    const asset = { id: 'variant-asset', type: 'DOCUMENT', mimeType: 'application/pdf', sizeBytes: 25n };
    const variant = { title, body: 'Approved body', hashtags: [], media: [asset], content: { canonicalUrl: null, media: [{ ...asset, id: 'content-asset' }] } };
    prisma.publishJob.findFirst.mockResolvedValue({ id: 'job-1' });
    prisma.publishJob.findUniqueOrThrow.mockResolvedValue({ id: 'job-1', platformAccount: { id: 'acc-1', name: 'Slides', settings: socialSettings, platform: { name: 'SlideShare', slug: 'slideshare' } }, target: { campaign: { name: 'Campaign' }, contentVariant: variant } });
    const task = await service.claim(device, [], ['slideshare']);
    expect(task?.post.title).toBe(title);
    expect(task?.media).toEqual([{ id: 'variant-asset', mimeType: 'application/pdf', sizeBytes: 25 }]);
    variant.media = [];
    expect((await service.claim(device, [], ['slideshare']))?.media).toEqual([{ id: 'content-asset', mimeType: 'application/pdf', sizeBytes: 25 }]);
  });

  it('sends one planned image to composers that can attach it, and none to text-only engines', async () => {
    const { service, prisma } = setup();
    const blueskySettings = { ...settings, extensionEngine: 'bluesky', extensionTargetUrl: 'https://bsky.app/intent/compose' };
    const image = (id: string) => ({ id, type: 'IMAGE', mimeType: 'image/png', sizeBytes: 9n });
    const variant = { title: null, body: 'Approved body', hashtags: [], media: [image('ai-image'), image('second-image')], content: { canonicalUrl: null, media: [image('shared-image')] } };
    prisma.publishJob.findFirst.mockResolvedValue({ id: 'job-1' });
    prisma.publishJob.findUniqueOrThrow.mockResolvedValue({ id: 'job-1', platformAccount: { id: 'acc-1', name: 'Bluesky', settings: blueskySettings, platform: { name: 'Bluesky', slug: 'bluesky' } }, target: { campaign: { name: 'Campaign' }, contentVariant: variant } });
    expect((await service.claim(device, [], ['bluesky']))?.media).toEqual([{ id: 'ai-image', mimeType: 'image/png', sizeBytes: 9 }]);

    prisma.publishJob.findUniqueOrThrow.mockResolvedValue({ id: 'job-1', platformAccount: { id: 'acc-1', name: 'DEV', settings: { ...settings, extensionEngine: 'devto', extensionTargetUrl: 'https://dev.to/new' }, platform: { name: 'DEV', slug: 'devto' } }, target: { campaign: { name: 'Campaign' }, contentVariant: variant } });
    expect((await service.claim(device, [], ['devto']))?.media).toEqual([]);
  });

  it('serves the image and its alt text to a composer that can attach one', async () => {
    const { service, prisma, storage } = setup();
    prisma.publishJob.findFirst.mockResolvedValue({ platformAccount: { settings: { ...settings, extensionEngine: 'mastodon', extensionTargetUrl: 'https://mastodon.social/publish' } }, target: { contentVariant: { id: 'variant-1', contentId: 'content-1' } } });
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    prisma.mediaAsset.findFirst.mockResolvedValue({ id: 'asset-1', storageKey: 'media/a.png', mimeType: 'image/png', sizeBytes: BigInt(bytes.length), checksum: createHash('sha256').update(bytes).digest('hex'), metadata: { altText: 'Máy chủ VPS' } });
    storage.get.mockResolvedValue(bytes);
    await expect(service.taskMedia(device, 'job-1', 'asset-1')).resolves.toMatchObject({ name: 'asset-1.png', mimeType: 'image/png', altText: 'Máy chủ VPS' });
  });

  it('keeps new social jobs away from extension versions that do not support their engine', async () => {
    const { service, prisma } = setup();
    prisma.platformAccount.findMany.mockResolvedValue([{ id: 'social-account', settings: { ...settings, extensionEngine: 'substack', extensionTargetUrl: 'https://example.substack.com/publish/post' } }]);
    prisma.publishJob.findFirst.mockResolvedValue(null);
    await service.claim(device);
    const oldQuery = (prisma.publishJob.findFirst.mock.calls[0] as [{ where: Record<string, unknown> }])[0];
    expect(oldQuery.where.platformAccountId).toEqual({ notIn: ['social-account'] });
    await service.claim(device, [], ['substack']);
    const newQuery = (prisma.publishJob.findFirst.mock.calls[1] as [{ where: Record<string, unknown> }])[0];
    expect(newQuery.where.platformAccountId).toBeUndefined();
  });

  it('serves only a managed attachment belonging to the owner and content of a claimed job', async () => {
    const { service, prisma, storage } = setup();
    prisma.publishJob.findFirst.mockResolvedValue({ platformAccount: { settings: { ...settings, extensionEngine: 'slideshare', extensionTargetUrl: 'https://www.slideshare.net/upload' } }, target: { contentVariant: { id: 'variant-1', contentId: 'content-1' } } });
    const bytes = Buffer.from('%PDF-1.4 test deck');
    const asset = { id: 'asset-1', storageKey: 'media/deck.pdf', mimeType: 'application/pdf', sizeBytes: BigInt(bytes.length), checksum: createHash('sha256').update(bytes).digest('hex') };
    prisma.mediaAsset.findFirst.mockResolvedValue(asset); storage.get.mockResolvedValue(bytes);
    const result = await service.taskMedia(device, 'job-1', 'asset-1');
    expect(Buffer.from(result.base64, 'base64')).toEqual(bytes);
    expect(result.name).toBe('asset-1.pdf');
    const query = (prisma.mediaAsset.findFirst.mock.calls[0] as [{ where: Record<string, unknown> }])[0];
    expect(query.where).toEqual({ id: 'asset-1', ownerId: 'owner-1', OR: [{ variantId: 'variant-1' }, { contentId: 'content-1', variantId: null }] });
    storage.get.mockResolvedValue(Buffer.from('changed file'));
    await expect(service.taskMedia(device, 'job-1', 'asset-1')).rejects.toThrow('integrity');
    prisma.mediaAsset.findFirst.mockResolvedValue({ ...asset, sizeBytes: 21n * 1024n * 1024n });
    await expect(service.taskMedia(device, 'job-1', 'asset-1')).rejects.toThrow('20 MiB');
    prisma.mediaAsset.findFirst.mockResolvedValue(null);
    await expect(service.taskMedia(device, 'job-1', 'foreign-asset')).rejects.toThrow('Attachment not found');
    prisma.publishJob.findFirst.mockResolvedValue(null);
    await expect(service.taskMedia(device, 'unclaimed-job', 'asset-1')).rejects.toThrow('Claimed extension job');
  });

  it('skips every account on an already active origin without blocking other forum jobs', async () => {
    const { service, prisma } = setup();
    prisma.platformAccount.findMany.mockResolvedValue([
      { id: 'busy-1', settings },
      { id: 'busy-2', settings: { ...settings, extensionTargetUrl: 'https://voz.vn/f/other.18/post-thread' } },
      { id: 'free', settings: { ...settings, extensionTargetUrl: 'https://forum.directadmin.com/forums/a.1/post-thread' } },
    ]);
    prisma.publishJob.findFirst.mockResolvedValue(null);
    await service.claim(device, ['https://voz.vn/']);
    const query = (prisma.publishJob.findFirst.mock.calls[0] as [{ where: Record<string, unknown> }])[0];
    expect(query.where).toMatchObject({ platformAccountId: { notIn: ['busy-1', 'busy-2'] }, target: { campaign: { ownerId: device.ownerId } } });
  });
  it('stores only the token hash and authenticates by it', async () => {
    const { service, prisma } = setup();
    prisma.extensionDevice.create.mockImplementation(({ data }: { data: { tokenHash: string } }) => Promise.resolve({ id: 'dev-1', name: 'Chrome', createdAt: new Date(), hash: data.tokenHash }));
    const created = await service.createDevice('owner-1', ' Chrome ');
    expect(created.token).toMatch(/^spx_/);
    const stored = (prisma.extensionDevice.create.mock.calls[0] as [{ data: { tokenHash: string; name: string } }])[0].data;
    expect(stored.tokenHash).toBe(sha256(created.token));
    expect(stored.name).toBe('Chrome');

    prisma.extensionDevice.findUnique.mockResolvedValueOnce({ id: 'dev-1', ownerId: 'owner-1', name: 'Chrome', revokedAt: null, lastSeenAt: null, owner: { enabled: true } });
    await expect(service.authenticate(`Bearer ${created.token}`)).resolves.toEqual(device);
    prisma.extensionDevice.findUnique.mockResolvedValueOnce({ id: 'dev-1', ownerId: 'owner-1', name: 'Chrome', revokedAt: new Date(), lastSeenAt: null, owner: { enabled: true } });
    await expect(service.authenticate(`Bearer ${created.token}`)).rejects.toThrow('revoked');
    await expect(service.authenticate('Bearer some-jwt')).rejects.toThrow('required');
  });

  it('expires silent claims as "result unknown" instead of handing them out again', async () => {
    const { service, prisma } = setup();
    prisma.publishJob.findFirst.mockResolvedValue(null);
    await expect(service.claim(device)).resolves.toBeNull();
    const sweep = (prisma.publishJob.updateMany.mock.calls[0] as [{ data: Record<string, unknown> }])[0];
    expect(sweep.data.lastErrorCode).toBe(EXTENSION_RESULT_UNKNOWN);
  });

  it('claims with compare-and-set and returns the recipe and forum-shaped post', async () => {
    const { service, prisma } = setup();
    prisma.publishJob.findFirst.mockResolvedValueOnce({ id: 'job-1' });
    prisma.publishJob.updateMany.mockResolvedValueOnce({ count: 0 }).mockResolvedValueOnce({ count: 1 });
    prisma.publishJob.findUniqueOrThrow.mockResolvedValue({
      id: 'job-1',
      platformAccount: { id: 'acc-1', name: 'Voz', settings, platform: { name: 'Voz Forums', slug: 'voz-forums' } },
      target: { campaign: { name: 'C' }, contentVariant: { title: 'Tiêu đề', body: 'Nội dung', hashtags: ['vps'], content: { canonicalUrl: null } } },
    });
    const task = await service.claim(device);
    expect(task).toMatchObject({ jobId: 'job-1', openUrl: settings.extensionTargetUrl, targetOrigin: 'https://voz.vn', autoSubmit: true, recipe: { engine: 'xenforo' } });
    // Forum topics keep tags in the forum's own tag field; hashtags are not printed in the body.
    expect(task?.post).toMatchObject({ title: 'Tiêu đề', body: 'Nội dung', summary: '', length: 8, language: 'vi' });
    expect(task?.post).not.toHaveProperty('bodyHtml');
    const claimCall = (prisma.publishJob.updateMany.mock.calls[1] as [{ where: Record<string, unknown> }])[0];
    expect(claimCall.where).toMatchObject({ id: 'job-1', lockedAt: null, lastErrorCode: null });
    // XenForo has no tag field the extension fills: the AI tag goes nowhere.
    expect(task?.options).toMatchObject({ tags: [], suggestedTags: [] });
  });

  it('sends the AI topic tags to a Stack Exchange tag field after the tags configured on the account', async () => {
    const { service, prisma } = setup();
    const unixSettings = { delivery: 'extension', extensionEngine: 'stackexchange', extensionTargetUrl: 'https://unix.stackexchange.com/questions/ask', extensionAutoSubmit: true, extensionTags: ['linux'] };
    prisma.publishJob.findFirst.mockResolvedValueOnce({ id: 'job-1' });
    prisma.publishJob.findUniqueOrThrow.mockResolvedValue({
      id: 'job-1',
      platformAccount: { id: 'acc-1', name: 'Unix', settings: unixSettings, platform: { name: 'Unix & Linux Stack Exchange', slug: 'unix-linux-stackexchange' } },
      target: { campaign: { name: 'C' }, contentVariant: { title: 'curl with --socks5', body: 'Question body', hashtags: ['#curl', 'Proxy', 'linux', 'dns'], content: { canonicalUrl: null } } },
    });
    const task = await service.claim(device);
    expect(task?.options).toMatchObject({ tags: ['linux'], suggestedTags: ['curl', 'proxy', 'dns'] });
    expect(task?.post.body).not.toContain('#curl');
  });

  it('sends approved AI selectors for this destination ahead of the built-in ones, and the recovery flag', async () => {
    const { prisma, campaignStatus, storage } = setup();
    const approvedFor = jest.fn().mockResolvedValue([{ field: 'body', selector: 'div.new-editor' }, { field: 'submit', selector: 'button.new-post' }]);
    const service = new ExtensionAgentService(
      prisma as unknown as PrismaService, campaignStatus as unknown as CampaignStatusService, storage as unknown as StorageService,
      { approvedFor } as unknown as ExtensionSelectorSuggestionService,
      { get: (key: string) => key === 'EXTENSION_UI_RECOVERY_ENABLED' } as unknown as ConfigService,
    );
    prisma.publishJob.findFirst.mockResolvedValueOnce({ id: 'job-1' });
    prisma.publishJob.findUniqueOrThrow.mockResolvedValue({
      id: 'job-1',
      platformAccount: { id: 'acc-1', name: 'Voz', settings, platform: { name: 'Voz Forums', slug: 'voz-forums' } },
      target: { campaign: { name: 'C' }, contentVariant: { title: 'Tiêu đề', body: 'Nội dung', hashtags: [], content: { canonicalUrl: null } } },
    });
    const task = await service.claim(device);
    expect(approvedFor).toHaveBeenCalledWith('owner-1', 'xenforo', 'https://voz.vn');
    expect(task?.recipe.bodySelectors[0]).toBe('div.new-editor');
    expect(task?.recipe.submitSelectors[0]).toBe('button.new-post');
    expect(task?.uiRecovery).toEqual({ enabled: true });
    expect(EXTENSION_RECIPES.xenforo.bodySelectors).not.toContain('div.new-editor');
  });

  it('completes a job only with a thread URL on the configured forum', async () => {
    const { service, prisma, tx, campaignStatus } = setup();
    prisma.publishJob.findFirst.mockResolvedValue(claimedJob);
    await expect(service.report(device, 'job-1', { outcome: 'PUBLISHED', url: 'https://evil.example/t/x.1/' })).rejects.toThrow('not on the configured forum');
    await expect(service.report(device, 'job-1', { outcome: 'PUBLISHED', url: 'https://voz.vn/f/a.17/post-thread' })).rejects.toThrow('does not look like');
    await expect(service.report(device, 'job-1', { outcome: 'PUBLISHED', url: 'https://voz.vn/t/bai-moi.555/' })).resolves.toMatchObject({ recorded: 'PUBLISHED', externalPostId: '555' });
    expect((tx.publishedPost.create.mock.calls[0] as [{ data: Record<string, unknown> }])[0].data).toMatchObject({ externalPostId: '555', url: 'https://voz.vn/t/bai-moi.555/' });
    expect(campaignStatus.refresh).toHaveBeenCalledWith('camp-1');
  });

  it('marks FAILED only for reasons where nothing was submitted, and keeps the claim while waiting for the operator', async () => {
    const { service, prisma } = setup();
    prisma.publishJob.findFirst.mockResolvedValue(claimedJob);
    await expect(service.report(device, 'job-1', { outcome: 'FAILED', reason: 'SUBMIT_REJECTED' })).rejects.toThrow('nothing was submitted');
    await service.report(device, 'job-1', { outcome: 'FAILED', reason: 'LOGIN_REQUIRED' });
    const failed = (prisma.publishJob.updateMany.mock.calls.at(-1) as [{ data: Record<string, unknown> }])[0].data;
    expect(failed).toMatchObject({ status: PublishJobStatus.FAILED, lockedAt: null, lastErrorCode: 'EXTENSION_LOGIN_REQUIRED' });
    await service.report(device, 'job-1', { outcome: 'NEEDS_ACTION', reason: 'CAPTCHA_REQUIRED' });
    const waiting = (prisma.publishJob.updateMany.mock.calls.at(-1) as [{ data: Record<string, unknown> }])[0].data;
    expect(waiting).toEqual({ lastErrorCode: 'EXTENSION_CAPTCHA_REQUIRED', lastErrorMessage: null });
  });

  it('rejects reports for jobs that are not claimed', async () => {
    const { service, prisma } = setup();
    prisma.publishJob.findFirst.mockResolvedValue({ ...claimedJob, lockedAt: null });
    await expect(service.report(device, 'job-1', { outcome: 'PUBLISHED', url: 'https://voz.vn/t/a.1/' })).rejects.toThrow('not claimed');
  });

  it('acknowledges a repeated published receipt but rejects another URL or device', async () => {
    const { service, prisma, tx } = setup();
    const finished = { id: 'job-1', status: PublishJobStatus.PUBLISHED, lockedAt: null, extensionClaimDeviceId: device.id,
      publishedPost: { url: 'https://voz.vn/t/a.1/', externalPostId: '1' }, platformAccount: { settings } };
    prisma.publishJob.findFirst.mockResolvedValue(finished);
    await expect(service.report(device, 'job-1', { outcome: 'PUBLISHED', url: finished.publishedPost.url })).resolves.toMatchObject({ recorded: 'PUBLISHED' });
    expect(tx.publishedPost.create).not.toHaveBeenCalled();
    await expect(service.report(device, 'job-1', { outcome: 'PUBLISHED', url: 'https://voz.vn/t/other.2/' })).rejects.toThrow('not claimed');
    prisma.publishJob.findFirst.mockResolvedValue({ ...finished, extensionClaimDeviceId: 'another-device' });
    await expect(service.report(device, 'job-1', { outcome: 'PUBLISHED', url: finished.publishedPost.url })).rejects.toThrow('another Chrome');
  });

  it('keeps moderation accepted, rejects requeue and ignores late uncertain reports', async () => {
    const { service, prisma, tx } = setup();
    prisma.publishJob.findFirst.mockResolvedValue(claimedJob);
    await service.report(device, 'job-1', { outcome: 'NEEDS_ACTION', reason: 'MODERATION_PENDING', message: 'Pending approval' });
    expect(prisma.publishJob.updateMany).toHaveBeenLastCalledWith(expect.objectContaining({ data: { lastErrorCode: 'EXTENSION_MODERATION_PENDING', lastErrorMessage: 'Pending approval' } }));
    prisma.publishJob.findFirst.mockResolvedValue({ ...claimedJob, lastErrorCode: 'EXTENSION_MODERATION_PENDING' });
    const writes = prisma.publishJob.updateMany.mock.calls.length;
    await service.report(device, 'job-1', { outcome: 'NEEDS_ACTION', reason: 'SUBMIT_UNCONFIRMED' });
    expect(prisma.publishJob.updateMany).toHaveBeenCalledTimes(writes);
    expect(tx.publishedPost.create).not.toHaveBeenCalled();
    prisma.publishJob.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(service.requeue(device.ownerId, 'job-1')).rejects.toThrow('waiting for the operator');
    const requeue = (prisma.publishJob.updateMany.mock.calls.at(-1) as [{ where: { OR: Array<Record<string, unknown>> } }])[0];
    expect(requeue.where.OR[0]!.lastErrorCode).toEqual({ startsWith: 'EXTENSION_', not: 'EXTENSION_MODERATION_PENDING' });
  });

  it('lets the operator hand back a claim that went silent past the claim timeout, but not a fresh one', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-11-04T10:00:00Z'));
    try {
      const { service, prisma } = setup();
      await expect(service.requeue('owner-1', 'job-1')).resolves.toEqual({ queued: true });
      const call = (prisma.publishJob.updateMany.mock.calls[0] as [{ where: Record<string, unknown>; data: Record<string, unknown> }])[0];
      expect(call.where).toMatchObject({ id: 'job-1', status: PublishJobStatus.NEEDS_ACTION, target: { campaign: { ownerId: 'owner-1' } } });
      expect((call.where.OR as unknown[])[1]).toEqual({
        lastErrorCode: null,
        lockedAt: { lt: new Date('2026-11-04T09:50:00Z') },
        publishedPost: null,
        attempts: { some: { responseMetadata: { path: ['extensionQueued'], equals: true } } },
      });
      expect(call.data).toMatchObject({ lastErrorCode: null, lockedAt: null, extensionClaimDeviceId: null });
    } finally { jest.useRealTimers(); }
  });

  it('accepts the sign-in details of a stop and keeps them in the attempt only', async () => {
    const { service, prisma } = setup();
    prisma.publishJob.findFirst.mockResolvedValue(claimedJob);
    await expect(service.report(device, 'job-1', { outcome: 'NEEDS_ACTION', reason: 'ACCOUNT_MISMATCH', message: 'Chrome đang đăng nhập tài khoản khác', detectedUsername: ' other_user ', googleBlocked: false }))
      .resolves.toEqual({ recorded: 'NEEDS_ACTION' });
    expect(prisma.publishJob.updateMany).toHaveBeenLastCalledWith(expect.objectContaining({ data: { lastErrorCode: 'EXTENSION_ACCOUNT_MISMATCH', lastErrorMessage: 'Chrome đang đăng nhập tài khoản khác' } }));
    expect(prisma.publishAttempt.update).toHaveBeenCalledWith({ where: { id: 'att-1' }, data: { responseMetadata: { extensionQueued: true, extensionReport: { detectedUsername: 'other_user' } } } });
    prisma.publishAttempt.update.mockClear();
    await service.report(device, 'job-1', { outcome: 'NEEDS_ACTION', reason: 'AUTH_REQUIRED', googleBlocked: true });
    expect(prisma.publishAttempt.update).toHaveBeenCalledWith({ where: { id: 'att-1' }, data: { responseMetadata: { extensionQueued: true, extensionReport: { googleBlocked: true } } } });
    prisma.publishAttempt.update.mockClear();
    await service.report(device, 'job-1', { outcome: 'NEEDS_ACTION', reason: 'AUTH_REQUIRED', googleBlocked: false });
    expect(prisma.publishAttempt.update).not.toHaveBeenCalled();
  });

  it('fails a task whose editor did not keep the text as EXTENSION_CONTENT_MISMATCH', async () => {
    const { service, prisma } = setup();
    prisma.publishJob.findFirst.mockResolvedValue(claimedJob);
    await expect(service.report(device, 'job-1', { outcome: 'FAILED', reason: 'CONTENT_MISMATCH', message: 'Trình soạn không giữ đúng nội dung' })).resolves.toEqual({ recorded: 'FAILED' });
    expect((prisma.publishJob.updateMany.mock.calls.at(-1) as [{ data: Record<string, unknown> }])[0].data).toMatchObject({ status: PublishJobStatus.FAILED, lastErrorCode: 'EXTENSION_CONTENT_MISMATCH' });
  });

  it('never hands out a post over the destination limit and goes on to the next job', async () => {
    const { service, prisma } = setup();
    const blueskySettings = { ...settings, extensionEngine: 'bluesky', extensionTargetUrl: 'https://bsky.app/intent/compose' };
    const job = (id: string, body: string) => ({ id, platformAccount: { id: 'acc-1', name: 'Bluesky', settings: blueskySettings, platform: { name: 'Bluesky', slug: 'bluesky' } },
      target: { campaign: { name: 'C' }, contentVariant: { title: null, body, hashtags: [], media: [], content: { canonicalUrl: null, media: [] } } } });
    const jobs: Record<string, ReturnType<typeof job>> = { 'too-long': job('too-long', 'x '.repeat(200).trim()), fits: job('fits', 'A short post that fits.') };
    prisma.publishJob.findFirst.mockResolvedValueOnce({ id: 'too-long' }).mockResolvedValueOnce({ id: 'fits' });
    prisma.publishJob.findUniqueOrThrow.mockImplementation(({ where }: { where: { id: string } }) => Promise.resolve(jobs[where.id]));
    const task = await service.claim(device, [], ['bluesky']);
    expect(task?.jobId).toBe('fits');
    expect(task?.post).toMatchObject({ maxChars: 300, length: 23, body: 'A short post that fits.' });
    const parked = (prisma.publishJob.updateMany.mock.calls as Array<[{ where: Record<string, unknown>; data: Record<string, unknown> }]>)
      .map(([call]) => call).find((call) => call.data.lastErrorCode === EXTENSION_CONTENT_TOO_LONG)!;
    expect(parked.where).toMatchObject({ id: 'too-long', extensionClaimDeviceId: device.id, lastErrorCode: null });
    expect(parked.data).toMatchObject({ lockedAt: null, extensionClaimDeviceId: null });
    expect(parked.data.lastErrorMessage).toBe('Bài Bluesky dài 399/300 ký tự, vượt giới hạn của nền tảng. Rút gọn trước khi duyệt hoặc đăng.');
  });

  it('returns nothing when every waiting post is too long', async () => {
    const { service, prisma } = setup();
    const blueskySettings = { ...settings, extensionEngine: 'bluesky', extensionTargetUrl: 'https://bsky.app/intent/compose' };
    prisma.publishJob.findFirst.mockResolvedValueOnce({ id: 'too-long' }).mockResolvedValueOnce(null);
    prisma.publishJob.findUniqueOrThrow.mockResolvedValue({ id: 'too-long', platformAccount: { id: 'acc-1', name: 'Bluesky', settings: blueskySettings, platform: { name: 'Bluesky', slug: 'bluesky' } },
      target: { campaign: { name: 'C' }, contentVariant: { title: null, body: 'y'.repeat(301), hashtags: [], media: [], content: { canonicalUrl: null, media: [] } } } });
    await expect(service.claim(device, [], ['bluesky'])).resolves.toBeNull();
    expect(prisma.publishJob.findFirst).toHaveBeenCalledTimes(2);
  });

  it('sends the length, language and form-fill flag, and HTML only to editors that paste it', async () => {
    const { prisma, campaignStatus, storage } = setup();
    const service = new ExtensionAgentService(
      prisma as unknown as PrismaService, campaignStatus as unknown as CampaignStatusService, storage as unknown as StorageService, undefined,
      { get: (key: string) => key === 'EXTENSION_AI_FORM_FILL_ENABLED' } as unknown as ConfigService,
    );
    const body = '## Why it matters\n\nThis guide explains **three** settings:\n\n- cache\n- workers <script>alert(1)</script>';
    const variant = { title: 'Tuning a small server', body, hashtags: ['nginx'], media: [], content: { canonicalUrl: 'https://vpsttt.com/blog/x', media: [] } };
    const account = (engine: string, slug: string, targetUrl: string) => ({ id: 'acc-1', name: slug, settings: { ...settings, extensionEngine: engine, extensionTargetUrl: targetUrl }, platform: { name: slug, slug } });
    prisma.publishJob.findFirst.mockResolvedValue({ id: 'job-1' });

    prisma.publishJob.findUniqueOrThrow.mockResolvedValue({ id: 'job-1', platformAccount: account('medium', 'medium', 'https://medium.com/new-story'), target: { campaign: { name: 'C' }, contentVariant: variant } });
    const medium = await service.claim(device, [], ['medium']);
    expect(medium?.formFill).toEqual({ enabled: true });
    expect(medium?.recipe.inputMode).toBe('pasteHtml');
    expect(medium?.post).toMatchObject({ language: 'en', maxChars: null });
    expect(medium?.post.length).toBeGreaterThan(0);
    // Plain text for the text/plain flavour, the formatted version as HTML.
    expect(medium?.post.body).not.toContain('**');
    expect(medium?.post.bodyHtml).toBe('<h2>Why it matters</h2><p>This guide explains <strong>three</strong> settings:</p>'
      + '<ul><li>cache</li><li>workers &lt;script&gt;alert(1)&lt;/script&gt;</li></ul>'
      + '<p>Source: <a href="https://vpsttt.com/blog/x">https://vpsttt.com/blog/x</a></p>');

    prisma.publishJob.findUniqueOrThrow.mockResolvedValue({ id: 'job-1', platformAccount: account('devto', 'devto', 'https://dev.to/new'), target: { campaign: { name: 'C' }, contentVariant: variant } });
    const devto = await service.claim(device, [], ['devto']);
    expect(devto?.recipe.inputMode).toBe('value');
    expect(devto?.post).not.toHaveProperty('bodyHtml');
    expect(devto?.post.body).toContain('**three**');
  });
});

describe('extension helpers', () => {
  it('derives thread ids from forum URLs', () => {
    expect(threadIdFromUrl('https://voz.vn/t/abc.123/')).toBe('123');
    expect(threadIdFromUrl('https://community.nginx.org/t/hello/4521/2')).toBe('4521');
    expect(threadIdFromUrl('https://forum.mikrotik.com/viewtopic.php?f=3&t=99')).toBe('99');
  });
  it('repairs a double-escaped AI body before it reaches the forum', () => {
    expect(forumPost({ title: 'T', body: 'Setup\\n- Version 24.04\\n\\n### Question\\nWhy?', hashtags: [] }, null).body)
      .toBe('Setup\n- Version 24.04\n\n### Question\nWhy?');
  });

  it('falls back to the first body line as title and appends source and tags', () => {
    expect(forumPost({ title: null, body: 'Dòng đầu\nDòng hai', hashtags: ['a'] }, 'https://vpsttt.com/x')).toEqual({
      title: 'Dòng đầu',
      body: 'Dòng đầu\nDòng hai\n\nNguồn: https://vpsttt.com/x\n\n#a',
    });
  });
});
