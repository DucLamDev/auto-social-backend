import { PublishJobStatus } from '@prisma/client';
import { CampaignStatusService } from '../campaigns/campaign-status.service';
import { sha256 } from '../common/utils/crypto.utils';
import { PrismaService } from '../database/prisma.service';
import { StorageService } from '../storage/storage.service';
import { createHash } from 'node:crypto';
import { EXTENSION_RESULT_UNKNOWN, ExtensionAgentService, forumPost, threadIdFromUrl } from './extension-agent.service';

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
    expect(task?.post).toEqual({ title: 'Tiêu đề', body: 'Nội dung\n\n#vps', summary: '' });
    const claimCall = (prisma.publishJob.updateMany.mock.calls[1] as [{ where: Record<string, unknown> }])[0];
    expect(claimCall.where).toMatchObject({ id: 'job-1', lockedAt: null, lastErrorCode: null });
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
    const requeue = (prisma.publishJob.updateMany.mock.calls.at(-1) as [{ where: Record<string, unknown> }])[0];
    expect(requeue.where.lastErrorCode).toEqual({ startsWith: 'EXTENSION_', not: 'EXTENSION_MODERATION_PENDING' });
  });
});

describe('extension helpers', () => {
  it('derives thread ids from forum URLs', () => {
    expect(threadIdFromUrl('https://voz.vn/t/abc.123/')).toBe('123');
    expect(threadIdFromUrl('https://community.nginx.org/t/hello/4521/2')).toBe('4521');
    expect(threadIdFromUrl('https://forum.mikrotik.com/viewtopic.php?f=3&t=99')).toBe('99');
  });

  it('falls back to the first body line as title and appends source and tags', () => {
    expect(forumPost({ title: null, body: 'Dòng đầu\nDòng hai', hashtags: ['a'] }, 'https://vpsttt.com/x')).toEqual({
      title: 'Dòng đầu',
      body: 'Dòng đầu\nDòng hai\n\nNguồn: https://vpsttt.com/x\n\n#a',
    });
  });
});
