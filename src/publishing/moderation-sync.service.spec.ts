import { CampaignStatusService } from '../campaigns/campaign-status.service';
import { SsrfSafeHttpService } from '../crawler/ssrf-safe-http.service';
import { PrismaService } from '../database/prisma.service';
import { findDiscourseTopic, ModerationSyncService, sameTitle } from './moderation-sync.service';
import { PublishJobsService } from './publish-jobs.service';

const title = 'IPv4 works, IPv6 fails: a dual-stack checklist';
const since = new Date('2026-11-06T00:00:00Z');
const createdBy = (topics: unknown[]) => ({ body: JSON.stringify({ topic_list: { topics } }), finalUrl: 'x' });

describe('moderation sync', () => {
  it('finds an approved Discourse topic by its title among the user\'s own topics, never an older one', async () => {
    const get = jest.fn().mockResolvedValue(createdBy([
      { id: 7, title: 'IPv4 works, IPv6 fails: a dual-stack checklist', slug: 'old', created_at: '2026-10-01T00:00:00Z' },
      { id: 4021, title: 'IPv4 Works, IPv6 Fails — a dual stack checklist', slug: 'ipv4-works-ipv6-fails', created_at: '2026-11-06T09:00:00Z' },
    ]));
    await expect(findDiscourseTopic(get, 'https://forum.mikrotik.com', 'vpsttt', title, since))
      .resolves.toEqual({ externalPostId: '4021', url: 'https://forum.mikrotik.com/t/ipv4-works-ipv6-fails/4021' });
    expect(get).toHaveBeenCalledWith('https://forum.mikrotik.com/topics/created-by/vpsttt.json', expect.any(Array));
    expect(sameTitle('Keeping a VPS patched', 'Keeping a small VPS patched')).toBe(false);
  });

  it('publishes a found post, and keeps when a post still waiting was checked', async () => {
    const settings = { delivery: 'extension', extensionEngine: 'discourse', extensionForumUrl: 'https://forum.mikrotik.com', extensionTargetUrl: 'https://forum.mikrotik.com/new-topic',
      extensionSession: { deviceId: 'dev-1', expectedUsername: 'vpsttt' } };
    const job = (id: string, jobTitle: string) => ({ id, createdAt: new Date('2026-11-06T08:00:00Z'), platformAccountId: 'acc-1',
      target: { campaignId: 'c-1', contentVariant: { title: jobTitle } }, platformAccount: { settings, platform: { slug: 'mikrotik-community' } },
      attempts: [{ id: `attempt-${id}`, startedAt: new Date('2026-11-06T08:00:00Z'), responseMetadata: { extensionQueued: true } }] });
    const prisma = {
      publishJob: { findMany: jest.fn().mockResolvedValue([job('approved', title), job('waiting', 'A topic still in the queue')]) },
      publishAttempt: { update: jest.fn().mockResolvedValue({}) },
    };
    const http = { getText: jest.fn().mockResolvedValue(createdBy([{ id: 4021, title, slug: 'ipv4', created_at: '2026-11-06T09:00:00Z' }])) };
    const jobs = { confirmPublished: jest.fn().mockResolvedValue(undefined) };
    const campaignStatus = { refresh: jest.fn().mockResolvedValue(undefined) };
    const service = new ModerationSyncService(prisma as unknown as PrismaService, http as unknown as SsrfSafeHttpService,
      jobs as unknown as PublishJobsService, campaignStatus as unknown as CampaignStatusService);

    await expect(service.syncPending('owner-1')).resolves.toEqual({ checked: 2, published: 1, notFound: 1, unsupported: 0, failed: 0 });
    expect(jobs.confirmPublished).toHaveBeenCalledWith('approved', { externalPostId: '4021', url: 'https://forum.mikrotik.com/t/ipv4/4021', platformAccountId: 'acc-1', source: 'sync' });
    expect(prisma.publishAttempt.update).toHaveBeenCalledWith({ where: { id: 'attempt-waiting' },
      data: { responseMetadata: { extensionQueued: true, moderationCheck: { at: expect.any(String) as unknown, outcome: 'not-found' } } } });
    expect(prisma.publishJob.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ target: { campaign: { ownerId: 'owner-1' } } }) as unknown }));
  });
});
