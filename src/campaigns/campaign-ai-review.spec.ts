import { AccountStatus, CampaignStatus, ContentStatus, PlatformMode, VariantStatus } from '@prisma/client';
import { AiContentService } from '../ai/ai-content.service';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../database/prisma.service';
import { RedisService } from '../queue/redis.service';
import { CampaignAutomationService } from './campaign-automation.service';
import { CampaignAutomationWorkerService } from './campaign-automation-worker.service';
import { CampaignsService } from './campaigns.service';

/** A connected, enabled account as the account queries return it. */
function readyAccount(id: string, platformId: string, slug: string, patch: Record<string, unknown> = {}) {
  return {
    id, name: `${slug} account`, platformId, settings: {}, enabled: true, status: AccountStatus.CONNECTED,
    platform: { id: platformId, slug, name: slug.toUpperCase(), enabled: true, mode: PlatformMode.OFFICIAL_API }, ...patch,
  };
}

function setup() {
  const dto = { name: 'Launch', brief: 'Product brief', platformAccountIds: ['account-1'], aiProvider: 'openai' as const, publishImmediately: true };
  const content = { id: 'content-1', status: ContentStatus.DRAFT };
  const variant = { id: 'variant-1', platformId: 'platform-1', status: VariantStatus.GENERATED, recommended: true, body: 'Reviewed text' };
  const campaign = { id: 'campaign-1', ownerId: 'owner-1', contentId: content.id, content, targets: [], status: CampaignStatus.DRAFT, automationState: 'WAITING_REVIEW', automationRequest: dto, automationVariantIds: [variant.id], updatedAt: new Date(), automationRequestHash: '', automationErrorCode: null };
  const account = readyAccount('account-1', 'platform-1', 'devto');
  const prisma = {
    campaign: {
      findFirst: jest.fn().mockResolvedValue(null), findFirstOrThrow: jest.fn().mockResolvedValue(campaign),
      create: jest.fn().mockImplementation(({ data }: { data: object }) => ({ ...campaign, ...data })),
      update: jest.fn().mockResolvedValue(campaign), updateMany: jest.fn().mockResolvedValue({ count: 1 }), upsert: jest.fn().mockResolvedValue(campaign),
    },
    content: { create: jest.fn().mockResolvedValue(content), findFirstOrThrow: jest.fn().mockResolvedValue(content), update: jest.fn(), updateMany: jest.fn() },
    contentVariant: { findMany: jest.fn().mockResolvedValue([variant]), updateMany: jest.fn().mockResolvedValue({ count: 1 }), count: jest.fn().mockResolvedValue(0) },
    platformAccount: { findMany: jest.fn().mockResolvedValue([account]) },
    campaignTarget: { create: jest.fn().mockResolvedValue({ id: 'target-1' }), count: jest.fn().mockResolvedValue(0) },
    publishJob: { create: jest.fn() },
    $transaction: jest.fn(),
    $queryRaw: jest.fn(),
  };
  prisma.$transaction.mockImplementation((fn: (tx: typeof prisma) => unknown) => fn(prisma));
  const ai = { resolveProvider: jest.fn().mockReturnValue('openai'), assertReady: jest.fn(), generate: jest.fn().mockResolvedValue([variant]) };
  const campaigns = { get: jest.fn().mockResolvedValue(campaign), publish: jest.fn() };
  const service = new CampaignAutomationService(prisma as unknown as PrismaService, ai as unknown as AiContentService, campaigns as unknown as CampaignsService, { recordBestEffort: jest.fn() } as unknown as AuditService);
  return { dto, campaign, variant, prisma, ai, campaigns, service };
}

describe('Background AI review', () => {
  it('lets the owner publish an unused Studio variant to explicitly selected accounts without regenerating AI', async () => {
    const { service, prisma, ai, campaigns } = setup();
    await service.approveExistingContent('owner-1', 'content-1', { variantIds: ['variant-1'], platformAccountIds: ['account-1'], publishMode: 'NOW' });
    expect(prisma.contentVariant.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ contentId: 'content-1', targets: { none: {} } }) as unknown }));
    expect(prisma.campaign.upsert).toHaveBeenCalledTimes(1);
    expect(campaigns.publish).toHaveBeenCalledWith('owner-1', 'campaign-1');
    expect(ai.generate).not.toHaveBeenCalled();
  });

  it('does not turn an already assigned or missing variant into a new publish campaign', async () => {
    const { service, prisma, campaigns } = setup();
    prisma.contentVariant.findMany.mockResolvedValue([]);
    await expect(service.approveExistingContent('owner-1', 'content-1', { variantIds: ['variant-1'], platformAccountIds: ['account-1'] })).rejects.toThrow('unused variant');
    expect(prisma.campaign.upsert).not.toHaveBeenCalled();
    expect(campaigns.publish).not.toHaveBeenCalled();
  });
  it('persists the request and returns without generating or creating publish jobs, even if the caller requests immediate publication', async () => {
    const { service, prisma, ai, campaigns, dto } = setup();
    await service.automate('owner-1', dto, 'request-key-123', undefined, { enqueue: true });
    expect(prisma.campaign.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({
      automationState: 'QUEUED', automationRequest: { ...dto, publishImmediately: false, idempotencyKey: 'request-key-123' },
    }) as unknown }));
    expect(ai.generate).not.toHaveBeenCalled();
    expect(prisma.publishJob.create).not.toHaveBeenCalled();
    expect(campaigns.publish).not.toHaveBeenCalled();
  });

  it('replays a queued request without revalidating accounts or starting AI twice', async () => {
    const { service, prisma, ai, dto } = setup();
    await service.automate('owner-1', dto, 'request-key-123', undefined, { enqueue: true });
    const created: unknown = prisma.campaign.create.mock.results[0]?.value;
    prisma.campaign.findFirst.mockResolvedValue(created);
    prisma.platformAccount.findMany.mockClear();
    await service.automate('owner-1', dto, 'request-key-123', undefined, { enqueue: true });
    expect(prisma.campaign.create).toHaveBeenCalledTimes(1);
    expect(prisma.platformAccount.findMany).not.toHaveBeenCalled();
    expect(ai.generate).not.toHaveBeenCalled();
  });

  it('finishes generation in WAITING_REVIEW without approving variants or dispatching posts', async () => {
    const { service, prisma, ai, campaigns, dto, campaign } = setup();
    // The drafts are still undecided when the run ends, so it waits for review.
    prisma.contentVariant.count.mockResolvedValue(1);
    await service.automate('owner-1', dto, 'request-key-123', undefined, { enqueue: true });
    const created = prisma.campaign.create.mock.results[0]?.value as typeof campaign;
    prisma.campaign.findFirst.mockResolvedValue({ ...created, automationState: 'PROCESSING' });
    prisma.contentVariant.findMany.mockResolvedValue([]);
    const assertOwnership = jest.fn().mockResolvedValue(undefined);
    await service.automate('owner-1', { ...dto, publishImmediately: false }, 'request-key-123', undefined, { processingId: campaign.id, assertOwnership });
    expect(ai.generate).toHaveBeenCalledTimes(1);
    expect(assertOwnership).toHaveBeenCalled();
    expect(prisma.campaign.update).toHaveBeenCalledWith({ where: { id: campaign.id }, data: { automationState: 'WAITING_REVIEW', automationErrorCode: null, automationVariantIds: ['variant-1'] } });
    expect(prisma.contentVariant.updateMany).not.toHaveBeenCalled();
    expect(prisma.campaignTarget.create).not.toHaveBeenCalled();
    expect(prisma.publishJob.create).not.toHaveBeenCalled();
    expect(campaigns.publish).not.toHaveBeenCalled();
  });

  it('lists each draft on the campaign as soon as it is saved, so it can be reviewed during the run', async () => {
    const { service, prisma, ai, dto, campaign, variant } = setup();
    // The drafts are still undecided when the run ends, so it waits for review.
    prisma.contentVariant.count.mockResolvedValue(1);
    await service.automate('owner-1', dto, 'request-key-123', undefined, { enqueue: true });
    const created = prisma.campaign.create.mock.results[0]?.value as typeof campaign;
    prisma.campaign.findFirst.mockResolvedValue({ ...created, automationState: 'PROCESSING', automationVariantIds: ['stale'] });
    prisma.contentVariant.findMany.mockResolvedValue([]);
    ai.generate.mockImplementation(async (...args: unknown[]) => {
      await (args[6] as (saved: typeof variant) => Promise<void>)(variant);
      return [variant];
    });
    await service.automate('owner-1', { ...dto, publishImmediately: false }, 'request-key-123', undefined, { processingId: campaign.id, assertOwnership: jest.fn() });
    const updates = prisma.campaign.update.mock.calls.map(([call]: [{ data: unknown }]) => call.data);
    expect(updates[0]).toEqual({ automationVariantIds: [] });
    expect(updates[1]).toEqual({ automationVariantIds: { push: 'variant-1' } });
    expect(updates[2]).toMatchObject({ automationState: 'WAITING_REVIEW', automationVariantIds: ['variant-1'] });
  });

  it('resumes an interrupted run by generating only the platforms that still have no draft', async () => {
    const { service, prisma, ai, dto, campaign, variant } = setup();
    // The drafts are still undecided when the run ends, so it waits for review.
    prisma.contentVariant.count.mockResolvedValue(1);
    const second = { id: 'account-2', platformId: 'platform-2', platform: { id: 'platform-2', slug: 'x', mode: PlatformMode.OFFICIAL_API } };
    prisma.platformAccount.findMany.mockResolvedValue([{ id: 'account-1', platformId: 'platform-1', platform: { id: 'platform-1', slug: 'devto', mode: PlatformMode.OFFICIAL_API } }, second]);
    const request = { ...dto, platformAccountIds: ['account-1', 'account-2'], publishImmediately: false };
    await service.automate('owner-1', request, 'request-key-123', undefined, { enqueue: true });
    const created = prisma.campaign.create.mock.results[0]?.value as typeof campaign;
    prisma.campaign.findFirst.mockResolvedValue({ ...created, automationState: 'PROCESSING' });
    prisma.contentVariant.findMany.mockResolvedValue([variant]);
    const fresh = { ...variant, id: 'variant-2', platformId: 'platform-2' };
    ai.generate.mockResolvedValue([fresh]);
    await service.automate('owner-1', request, 'request-key-123', undefined, { processingId: campaign.id, assertOwnership: jest.fn() });
    expect(ai.generate).toHaveBeenCalledWith('owner-1', 'content-1', ['x'], 'openai', expect.any(Function), expect.any(Map), expect.any(Function));
    expect(prisma.contentVariant.updateMany).not.toHaveBeenCalled();
    expect(prisma.campaign.update).toHaveBeenCalledWith({ where: { id: campaign.id }, data: { automationVariantIds: ['variant-1'] } });
    expect(prisma.campaign.update).toHaveBeenLastCalledWith({ where: { id: campaign.id }, data: expect.objectContaining({ automationState: 'WAITING_REVIEW', automationVariantIds: ['variant-1', 'variant-2'] }) as unknown });
  });

  it('creates and activates posts only after the owner approves, using the requested schedule', async () => {
    const { service, prisma, campaigns } = setup();
    const date = new Date(Date.now() + 86_400_000);
    await service.approve('owner-1', 'campaign-1', { publishMode: 'SCHEDULED', scheduledAt: date.toISOString() });
    expect(prisma.campaign.findFirstOrThrow).toHaveBeenCalledWith({ where: { id: 'campaign-1', ownerId: 'owner-1' } });
    expect(prisma.campaign.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ ownerId: 'owner-1', automationState: 'WAITING_REVIEW' }) as unknown, data: { automationState: 'APPROVED', scheduledAt: date } }));
    expect(prisma.publishJob.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ scheduledAt: date, status: 'SCHEDULED' }) as unknown }));
    expect(campaigns.publish).toHaveBeenCalledWith('owner-1', 'campaign-1');
  });

  it('does not publish or create jobs when a schedule is in the past', async () => {
    const { service, prisma, campaigns } = setup();
    await expect(service.approve('owner-1', 'campaign-1', { publishMode: 'SCHEDULED', scheduledAt: '2000-01-01T00:00:00Z' })).rejects.toThrow('future');
    expect(prisma.publishJob.create).not.toHaveBeenCalled();
    expect(campaigns.publish).not.toHaveBeenCalled();
  });

  it('prevents duplicate approval from creating a second set of jobs', async () => {
    const { service, prisma } = setup();
    prisma.campaign.updateMany.mockResolvedValue({ count: 0 });
    await expect(service.approve('owner-1', 'campaign-1')).rejects.toThrow('already changed');
    expect(prisma.publishJob.create).not.toHaveBeenCalled();
  });

  it('rejects a campaign without creating or publishing posts', async () => {
    const { service, prisma, campaigns } = setup();
    await service.reject('owner-1', 'campaign-1');
    expect(prisma.campaign.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ ownerId: 'owner-1', automationState: 'WAITING_REVIEW' }) as unknown, data: { automationState: 'REJECTED' } }));
    expect(prisma.publishJob.create).not.toHaveBeenCalled();
    expect(campaigns.publish).not.toHaveBeenCalled();
  });
});

describe('Per-platform review', () => {
  function perPlatform() {
    const ctx = setup();
    const second = readyAccount('account-2', 'platform-2', 'x');
    const other = { ...ctx.variant, id: 'variant-2', platformId: 'platform-2', body: 'Second text' };
    const waiting = { ...ctx.campaign, automationVariantIds: ['variant-1', 'variant-2'], automationRequest: { ...ctx.dto, platformAccountIds: ['account-1', 'account-2'] } };
    ctx.prisma.campaign.findFirstOrThrow.mockResolvedValue(waiting);
    ctx.prisma.campaign.findFirst.mockResolvedValue(waiting);
    ctx.prisma.platformAccount.findMany.mockResolvedValue([readyAccount('account-1', 'platform-1', 'devto'), second]);
    Object.assign(ctx.prisma, { campaignTarget: { create: jest.fn().mockResolvedValue({ id: 'target-1' }), count: jest.fn().mockResolvedValue(1) } });
    return { ...ctx, waiting, other };
  }

  it('approves one platform: only its accounts get a job, the review stays open for the others', async () => {
    const { service, prisma, campaigns, variant } = perPlatform();
    prisma.contentVariant.findMany.mockResolvedValue([variant]);
    prisma.contentVariant.count.mockResolvedValue(1); // variant-2 still waiting
    await service.approveVariant('owner-1', 'campaign-1', 'variant-1');
    expect(prisma.$queryRaw).toHaveBeenCalled();
    expect(prisma.contentVariant.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ id: { in: ['variant-1'] }, targets: { none: {} } }) as unknown }));
    expect(prisma.contentVariant.updateMany).toHaveBeenCalledWith({ where: { id: { in: ['variant-1'] } }, data: { status: VariantStatus.APPROVED } });
    expect(prisma.publishJob.create).toHaveBeenCalledTimes(1);
    expect(prisma.publishJob.create).toHaveBeenCalledWith({ data: expect.objectContaining({ platformAccountId: 'account-1', status: 'SCHEDULED' }) as unknown });
    const update = (prisma.campaign.update.mock.calls.at(-1) as [{ data: Record<string, unknown> }])[0].data;
    expect(update.automationState).toBeUndefined();
    expect(campaigns.publish).toHaveBeenCalledWith('owner-1', 'campaign-1');
  });

  it('closes the review when the last platform is rejected and never publishes the rejected draft', async () => {
    const { service, prisma, campaigns, other, waiting } = perPlatform();
    prisma.campaign.findFirst.mockResolvedValue({ ...waiting, status: CampaignStatus.RUNNING });
    prisma.contentVariant.findMany.mockResolvedValue([other]);
    prisma.contentVariant.count.mockResolvedValue(0);
    await service.rejectVariant('owner-1', 'campaign-1', 'variant-2');
    expect(prisma.contentVariant.updateMany).toHaveBeenCalledWith({ where: { id: { in: ['variant-2'] }, targets: { none: {} } }, data: { status: VariantStatus.REJECTED } });
    expect(prisma.publishJob.create).not.toHaveBeenCalled();
    expect(prisma.campaign.update).toHaveBeenLastCalledWith({ where: { id: 'campaign-1' }, data: { automationState: 'APPROVED' } });
    expect(campaigns.publish).not.toHaveBeenCalled();
  });

  it('reopens a finished campaign for a platform approved later, and refuses a second approval of the same draft', async () => {
    const { service, prisma, campaigns, other, waiting } = perPlatform();
    prisma.campaign.findFirst.mockResolvedValue({ ...waiting, status: CampaignStatus.COMPLETED });
    prisma.contentVariant.findMany.mockResolvedValue([other]);
    await service.approveVariant('owner-1', 'campaign-1', 'variant-2');
    expect(prisma.campaign.update).toHaveBeenLastCalledWith({ where: { id: 'campaign-1' }, data: { automationState: 'APPROVED', status: CampaignStatus.RUNNING } });
    expect(campaigns.publish).not.toHaveBeenCalled();
    prisma.contentVariant.findMany.mockResolvedValue([]);
    await expect(service.approveVariant('owner-1', 'campaign-1', 'variant-2')).rejects.toThrow('already approved or rejected');
    await expect(service.approveVariant('owner-1', 'campaign-1', 'variant-9')).rejects.toThrow('not part of the campaign');
  });

  it('turns "approve all" and "reject" into decisions on the drafts still waiting once one platform was decided', async () => {
    const { service, prisma, other } = perPlatform();
    prisma.contentVariant.count.mockResolvedValueOnce(1).mockResolvedValue(0);
    prisma.contentVariant.findMany.mockResolvedValue([other]);
    await service.approve('owner-1', 'campaign-1');
    expect(prisma.contentVariant.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ id: { in: ['variant-1', 'variant-2'] } }) as unknown }));
    expect(prisma.publishJob.create).toHaveBeenCalledWith({ data: expect.objectContaining({ platformAccountId: 'account-2' }) as unknown });
    prisma.contentVariant.count.mockResolvedValueOnce(1).mockResolvedValue(0);
    await service.reject('owner-1', 'campaign-1');
    expect(prisma.contentVariant.updateMany).toHaveBeenLastCalledWith({ where: { id: { in: ['variant-2'] }, targets: { none: {} } }, data: { status: VariantStatus.REJECTED } });
  });
});

describe('Shorter review: approve ready posts while the AI writes, or publish passing posts automatically', () => {
  function processing() {
    const ctx = setup();
    const other = { ...ctx.variant, id: 'variant-2', platformId: 'platform-2', body: 'Second text' };
    const running = { ...ctx.campaign, automationState: 'PROCESSING', automationVariantIds: ['variant-1'], automationRequest: { ...ctx.dto, platformAccountIds: ['account-1', 'account-2'] } };
    ctx.prisma.campaign.findFirstOrThrow.mockResolvedValue(running);
    ctx.prisma.campaign.findFirst.mockResolvedValue(running);
    ctx.prisma.platformAccount.findMany.mockResolvedValue([readyAccount('account-1', 'platform-1', 'devto'), readyAccount('account-2', 'platform-2', 'x')]);
    return { ...ctx, other, running };
  }

  it('approves a finished platform while the AI still writes the others, and publishes it without closing the review', async () => {
    const { service, prisma, campaigns, variant } = processing();
    prisma.contentVariant.findMany.mockResolvedValue([variant]);
    await service.approveVariant('owner-1', 'campaign-1', 'variant-1');
    expect(prisma.publishJob.create).toHaveBeenCalledWith({ data: expect.objectContaining({ platformAccountId: 'account-1', status: 'SCHEDULED' }) as unknown });
    const update = (prisma.campaign.update.mock.calls.at(-1) as [{ data: Record<string, unknown> }])[0].data;
    expect(update.automationState).toBeUndefined();
    expect(campaigns.publish).toHaveBeenCalledWith('owner-1', 'campaign-1');
  });

  it('does not approve a post whose image is still being created; "approve all" takes only the ready ones', async () => {
    const { service, prisma, variant, other } = processing();
    const drawing = { ...other, mediaRecommendation: { type: 'image', prompt: 'p', status: 'generating' } };
    prisma.contentVariant.findMany.mockResolvedValue([drawing]);
    await expect(service.approveVariant('owner-1', 'campaign-1', 'variant-1')).rejects.toThrow('Ảnh của bài này đang được tạo');
    expect(prisma.publishJob.create).not.toHaveBeenCalled();
    prisma.contentVariant.findMany.mockResolvedValue([{ ...variant, mediaRecommendation: { type: 'image', status: 'generated' } }, drawing]);
    await service.approve('owner-1', 'campaign-1');
    expect(prisma.contentVariant.updateMany).toHaveBeenCalledWith({ where: { id: { in: ['variant-1'] } }, data: { status: VariantStatus.APPROVED } });
    expect(prisma.publishJob.create).toHaveBeenCalledTimes(1);
  });

  it('ends a run in APPROVED when every post was already decided during it', async () => {
    const { service, prisma, ai, dto, campaign } = setup();
    await service.automate('owner-1', dto, 'request-key-123', undefined, { enqueue: true });
    const created = prisma.campaign.create.mock.results[0]?.value as typeof campaign;
    // variant-1 was approved while the run was writing: it has a target now.
    prisma.campaign.findFirst.mockResolvedValue({ ...created, automationState: 'PROCESSING', automationVariantIds: ['variant-1'], targets: [{ id: 'target-1' }] });
    prisma.contentVariant.findMany.mockResolvedValue([{ id: 'variant-1', platformId: 'platform-1', recommended: true, reason: 'Đạt', mediaRecommendation: null }]);
    prisma.contentVariant.count.mockResolvedValue(0);
    Object.assign(prisma.campaignTarget, { count: jest.fn().mockResolvedValue(1) });
    await service.automate('owner-1', { ...dto, publishImmediately: false }, 'request-key-123', undefined, { processingId: campaign.id, assertOwnership: jest.fn() });
    // The approved platform is kept, not written again, and the run does not replay as "completed".
    expect(ai.generate).not.toHaveBeenCalled();
    expect(prisma.campaign.update).toHaveBeenLastCalledWith({ where: { id: campaign.id }, data: expect.objectContaining({ automationState: 'APPROVED' }) as unknown });
  });

  it('publishes each post the AI check passed as soon as it is written, when the run was created with autoPublish', async () => {
    const { service, prisma, ai, campaigns, dto, campaign, variant } = setup();
    const request = { ...dto, autoPublish: true };
    await service.automate('owner-1', request, 'request-key-auto', undefined, { enqueue: true });
    const created = prisma.campaign.create.mock.results[0]?.value as typeof campaign;
    const running = { ...created, automationState: 'PROCESSING', automationVariantIds: ['variant-1'], automationRequest: request };
    prisma.campaign.findFirst.mockResolvedValue(running);
    prisma.campaign.findFirstOrThrow.mockResolvedValue(running);
    prisma.contentVariant.findMany.mockResolvedValueOnce([]).mockResolvedValue([variant]);
    ai.generate.mockImplementation(async (...args: unknown[]) => {
      await (args[6] as (saved: typeof variant) => Promise<void>)(variant);
      return [variant];
    });
    await service.automate('owner-1', { ...request, publishImmediately: false }, 'request-key-auto', undefined, { processingId: campaign.id, assertOwnership: jest.fn() });
    expect(prisma.publishJob.create).toHaveBeenCalledWith({ data: expect.objectContaining({ platformAccountId: 'account-1', status: 'SCHEDULED' }) as unknown });
    expect(campaigns.publish).toHaveBeenCalledWith('owner-1', 'campaign-1');
  });

  it('leaves a post that did not pass the AI check waiting for review, even with autoPublish', async () => {
    const { service, prisma, ai, campaigns, dto, campaign, variant } = setup();
    const request = { ...dto, autoPublish: true };
    await service.automate('owner-1', request, 'request-key-auto-2', undefined, { enqueue: true });
    const created = prisma.campaign.create.mock.results[0]?.value as typeof campaign;
    prisma.campaign.findFirst.mockResolvedValue({ ...created, automationState: 'PROCESSING', automationRequest: request });
    prisma.contentVariant.findMany.mockResolvedValue([]);
    prisma.contentVariant.count.mockResolvedValue(1);
    const weak = { ...variant, recommended: false };
    ai.generate.mockImplementation(async (...args: unknown[]) => {
      await (args[6] as (saved: typeof weak) => Promise<void>)(weak);
      return [weak];
    });
    await service.automate('owner-1', { ...request, publishImmediately: false }, 'request-key-auto-2', undefined, { processingId: campaign.id, assertOwnership: jest.fn() });
    expect(prisma.publishJob.create).not.toHaveBeenCalled();
    expect(campaigns.publish).not.toHaveBeenCalled();
    expect(prisma.campaign.update).toHaveBeenLastCalledWith({ where: { id: campaign.id }, data: expect.objectContaining({ automationState: 'WAITING_REVIEW' }) as unknown });
  });

  it('treats autoPublish as part of the request, so a replay with another choice is refused', async () => {
    const { service, prisma, dto } = setup();
    await service.automate('owner-1', dto, 'request-key-hash', undefined, { enqueue: true });
    prisma.campaign.findFirst.mockResolvedValue(prisma.campaign.create.mock.results[0]?.value);
    await expect(service.automate('owner-1', { ...dto, autoPublish: true }, 'request-key-hash', undefined, { enqueue: true })).rejects.toThrow('different automation request');
  });
});

describe('Review with accounts that are not ready', () => {
  function withAccounts(accounts: ReturnType<typeof readyAccount>[]) {
    const ctx = setup();
    const other = { ...ctx.variant, id: 'variant-2', platformId: 'platform-2', body: 'Second text' };
    const waiting = { ...ctx.campaign, automationVariantIds: ['variant-1', 'variant-2'], automationRequest: { ...ctx.dto, platformAccountIds: accounts.map((account) => account.id) } };
    ctx.prisma.campaign.findFirstOrThrow.mockResolvedValue(waiting);
    ctx.prisma.campaign.findFirst.mockResolvedValue(waiting);
    ctx.prisma.platformAccount.findMany.mockResolvedValue(accounts);
    Object.assign(ctx.prisma, { campaignTarget: { create: jest.fn().mockResolvedValue({ id: 'target-1' }), count: jest.fn().mockResolvedValue(1) } });
    return { ...ctx, other };
  }

  it('approves one post on the ready accounts of its platform and reports the others instead of failing', async () => {
    const { service, prisma, variant } = withAccounts([
      readyAccount('account-1', 'platform-1', 'devto'),
      readyAccount('account-3', 'platform-1', 'devto', { status: AccountStatus.RECONNECT_REQUIRED }),
      readyAccount('account-2', 'platform-2', 'x', { enabled: false }),
    ]);
    prisma.contentVariant.findMany.mockResolvedValue([variant]);
    prisma.contentVariant.count.mockResolvedValue(1);
    const result = await service.approveVariant('owner-1', 'campaign-1', 'variant-1');
    expect(prisma.platformAccount.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: { in: ['account-1', 'account-3', 'account-2'] }, ownerId: 'owner-1' } }));
    expect(prisma.publishJob.create).toHaveBeenCalledTimes(1);
    expect(prisma.publishJob.create).toHaveBeenCalledWith({ data: expect.objectContaining({ platformAccountId: 'account-1' }) as unknown });
    // The other platform's disabled account is not this post's concern.
    expect(result).toMatchObject({ skippedAccounts: [{ id: 'account-3', name: 'devto account', platform: 'DEVTO', reason: 'NOT_CONNECTED' }], waitingVariantIds: [] });
  });

  it('refuses to approve a post whose platform has no ready account, naming each account and why', async () => {
    const { service, prisma, other, campaigns } = withAccounts([
      readyAccount('account-1', 'platform-1', 'devto'),
      readyAccount('account-2', 'platform-2', 'x', { status: AccountStatus.EXPIRED }),
      readyAccount('account-4', 'platform-2', 'x', { settings: { delivery: 'extension', extensionAutoSubmit: false } }),
    ]);
    prisma.contentVariant.findMany.mockResolvedValue([other]);
    await expect(service.approveVariant('owner-1', 'campaign-1', 'variant-2'))
      .rejects.toThrow('Chưa có tài khoản X nào sẵn sàng để đăng: x account (chưa kết nối, cần đăng nhập lại); x account (chưa bật "Tự bấm Đăng")');
    expect(prisma.contentVariant.updateMany).not.toHaveBeenCalled();
    expect(prisma.publishJob.create).not.toHaveBeenCalled();
    expect(campaigns.publish).not.toHaveBeenCalled();
  });

  it('"approve all" posts the platforms that have a ready account and keeps the others waiting', async () => {
    const { service, prisma, variant, other, campaigns } = withAccounts([
      readyAccount('account-1', 'platform-1', 'devto'),
      readyAccount('account-2', 'platform-2', 'x', { status: AccountStatus.RECONNECT_REQUIRED }),
    ]);
    prisma.contentVariant.findMany.mockResolvedValue([variant, other]);
    // Nothing decided before the click; variant-2 is still waiting after it.
    prisma.contentVariant.count.mockResolvedValueOnce(0).mockResolvedValue(1);
    const result = await service.approve('owner-1', 'campaign-1');
    expect(prisma.campaign.updateMany).not.toHaveBeenCalled();
    expect(prisma.contentVariant.updateMany).toHaveBeenCalledWith({ where: { id: { in: ['variant-1'] } }, data: { status: VariantStatus.APPROVED } });
    expect(prisma.publishJob.create).toHaveBeenCalledTimes(1);
    expect(prisma.publishJob.create).toHaveBeenCalledWith({ data: expect.objectContaining({ platformAccountId: 'account-1' }) as unknown });
    const update = (prisma.campaign.update.mock.calls.at(-1) as [{ data: Record<string, unknown> }])[0].data;
    expect(update.automationState).toBeUndefined();
    expect(campaigns.publish).toHaveBeenCalledWith('owner-1', 'campaign-1');
    expect(result).toMatchObject({ skippedAccounts: [], waitingVariantIds: ['variant-2'] });
  });

  it('"approve all" fails without changes when no platform has a ready account', async () => {
    const { service, prisma, variant, other, campaigns } = withAccounts([
      readyAccount('account-1', 'platform-1', 'devto', { enabled: false }),
      readyAccount('account-2', 'platform-2', 'x', { platform: { id: 'platform-2', slug: 'x', name: 'X', enabled: false, mode: PlatformMode.OFFICIAL_API } }),
    ]);
    prisma.contentVariant.findMany.mockResolvedValue([variant, other]);
    await expect(service.approve('owner-1', 'campaign-1')).rejects.toThrow('devto account (tài khoản đang tắt); x account (nền tảng đang tắt)');
    expect(prisma.publishJob.create).not.toHaveBeenCalled();
    expect(campaigns.publish).not.toHaveBeenCalled();
  });

  it('keeps the one-step approval when every account is ready', async () => {
    const { service, prisma } = setup();
    await service.approve('owner-1', 'campaign-1');
    expect(prisma.campaign.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ automationState: 'APPROVED' }) as unknown }));
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });
});

describe('Persistent AI queue recovery', () => {
  it('recovers an interrupted task and resets a stale generation marker without requiring an open web page', async () => {
    const { prisma, campaign, dto } = setup();
    prisma.campaign.findFirst.mockResolvedValue({ ...campaign, automationState: 'PROCESSING', automationRequest: { ...dto, idempotencyKey: 'request-key-123' } });
    const redis = { acquireLock: jest.fn().mockResolvedValue('token'), extendLock: jest.fn().mockResolvedValue(true), releaseLock: jest.fn() };
    const automation = { automate: jest.fn().mockResolvedValue({}) };
    const worker = new CampaignAutomationWorkerService(prisma as unknown as PrismaService, redis as unknown as RedisService, automation as unknown as CampaignAutomationService);
    await worker.processNext();
    expect(prisma.content.updateMany).toHaveBeenCalledWith({ where: { id: campaign.contentId, status: ContentStatus.AI_GENERATING }, data: { status: ContentStatus.DRAFT } });
    expect(automation.automate).toHaveBeenCalledWith('owner-1', dto, 'request-key-123', undefined, expect.objectContaining({ processingId: campaign.id }));
    expect(redis.releaseLock).toHaveBeenCalledWith('campaign-ai-worker', 'token');
    // A run whose first posts were approved (campaign already RUNNING) is resumed too; only a cancelled one is not.
    expect(prisma.campaign.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { automationState: { in: ['QUEUED', 'PROCESSING'] }, status: { not: 'CANCELLED' } } }));
  });

  it('does not process a second AI task while another worker owns the lease', async () => {
    const { prisma, service } = setup();
    const worker = new CampaignAutomationWorkerService(prisma as unknown as PrismaService, { acquireLock: jest.fn().mockResolvedValue(null) } as unknown as RedisService, service);
    await worker.processNext();
    expect(prisma.campaign.findFirst).not.toHaveBeenCalled();
  });
});


describe('Restore rejected AI content', () => {
  it('restores legacy bulk rejections, retaining content and never publishing or regenerating', async () => {
    const { service, prisma, campaign, ai, campaigns } = setup();
    prisma.campaign.findFirst.mockResolvedValue({ ...campaign, automationState: 'REJECTED' });
    await service.restore('owner-1', 'campaign-1');
    expect(prisma.campaign.findFirst).toHaveBeenCalledWith({ where: { id: 'campaign-1', ownerId: 'owner-1' } });
    expect(prisma.campaign.updateMany).toHaveBeenCalledWith({ where: { id: 'campaign-1', ownerId: 'owner-1', automationState: 'REJECTED', updatedAt: campaign.updatedAt }, data: { automationState: 'WAITING_REVIEW' } });
    expect(prisma.contentVariant.updateMany).toHaveBeenCalledWith({ where: {
      id: { in: ['variant-1'] }, contentId: 'content-1', content: { ownerId: 'owner-1' },
      status: { in: ['REJECTED', 'GENERATED', 'APPROVED'] }, targets: { none: {} },
    }, data: { status: 'GENERATED' } });
    expect(prisma.publishJob.create).not.toHaveBeenCalled();
    expect(prisma.campaignTarget.create).not.toHaveBeenCalled();
    expect(campaigns.publish).not.toHaveBeenCalled();
    expect(ai.generate).not.toHaveBeenCalled();
  });

  it.each(['WAITING_REVIEW', 'APPROVED', 'REJECTED'])('restores only a rejected, unused platform in a %s review', async (automationState) => {
    const { service, prisma, campaign } = setup();
    prisma.campaign.findFirst.mockResolvedValue({ ...campaign, automationState, status: CampaignStatus.COMPLETED, automationVariantIds: ['variant-1', 'variant-2'] });
    await service.restore('owner-1', 'campaign-1', 'variant-2');
    expect(prisma.$queryRaw).toHaveBeenCalled();
    expect(prisma.contentVariant.updateMany).toHaveBeenCalledWith({ where: {
      id: { in: ['variant-2'] }, contentId: 'content-1', content: { ownerId: 'owner-1' }, status: { in: ['REJECTED'] }, targets: { none: {} },
    }, data: { status: 'GENERATED' } });
    expect(prisma.campaign.updateMany).toHaveBeenCalledWith({ where: expect.any(Object) as unknown, data: { automationState: 'WAITING_REVIEW' } });
    expect(prisma.publishJob.create).not.toHaveBeenCalled();
  });

  it('refuses another owner or a variant outside the campaign', async () => {
    const { service, prisma, campaign } = setup();
    await expect(service.restore('other-owner', 'campaign-1')).rejects.toThrow('not found');
    expect(prisma.campaign.findFirst).toHaveBeenCalledWith({ where: { id: 'campaign-1', ownerId: 'other-owner' } });
    prisma.campaign.findFirst.mockResolvedValue(campaign);
    await expect(service.restore('owner-1', 'campaign-1', 'foreign-variant')).rejects.toThrow('not part');
    expect(prisma.contentVariant.updateMany).not.toHaveBeenCalled();
    expect(prisma.campaign.updateMany).not.toHaveBeenCalled();
  });

  it.each(['PROCESSING', 'QUEUED', 'FAILED', null])('refuses restoration in state %s', async (automationState) => {
    const { service, prisma, campaign } = setup();
    prisma.campaign.findFirst.mockResolvedValue({ ...campaign, automationState });
    await expect(service.restore('owner-1', 'campaign-1')).rejects.toThrow('Only rejected');
    expect(prisma.contentVariant.updateMany).not.toHaveBeenCalled();
  });

  it('rejects a stale decision and an already restored or assigned variant', async () => {
    const { service, prisma, campaign } = setup();
    prisma.campaign.findFirst.mockResolvedValue(campaign);
    prisma.campaign.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(service.restore('owner-1', 'campaign-1', 'variant-1')).rejects.toThrow('already changed');
    expect(prisma.contentVariant.updateMany).not.toHaveBeenCalled();
    prisma.contentVariant.updateMany.mockResolvedValue({ count: 0 });
    await expect(service.restore('owner-1', 'campaign-1', 'variant-1')).rejects.toThrow('No rejected, unpublished');
    expect(prisma.publishJob.create).not.toHaveBeenCalled();
  });
});
