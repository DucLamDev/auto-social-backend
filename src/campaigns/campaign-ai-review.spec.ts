import { CampaignStatus, ContentStatus, PlatformMode, VariantStatus } from '@prisma/client';
import { AiContentService } from '../ai/ai-content.service';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../database/prisma.service';
import { RedisService } from '../queue/redis.service';
import { CampaignAutomationService } from './campaign-automation.service';
import { CampaignAutomationWorkerService } from './campaign-automation-worker.service';
import { CampaignsService } from './campaigns.service';

function setup() {
  const dto = { name: 'Launch', brief: 'Product brief', platformAccountIds: ['account-1'], aiProvider: 'openai' as const, publishImmediately: true };
  const content = { id: 'content-1', status: ContentStatus.DRAFT };
  const variant = { id: 'variant-1', platformId: 'platform-1', status: VariantStatus.GENERATED, recommended: true, body: 'Reviewed text' };
  const campaign = { id: 'campaign-1', ownerId: 'owner-1', contentId: content.id, content, targets: [], status: CampaignStatus.DRAFT, automationState: 'WAITING_REVIEW', automationRequest: dto, automationVariantIds: [variant.id], updatedAt: new Date(), automationRequestHash: '', automationErrorCode: null };
  const account = { id: 'account-1', platformId: 'platform-1', platform: { id: 'platform-1', slug: 'devto', mode: PlatformMode.OFFICIAL_API } };
  const prisma = {
    campaign: {
      findFirst: jest.fn().mockResolvedValue(null), findFirstOrThrow: jest.fn().mockResolvedValue(campaign),
      create: jest.fn().mockImplementation(({ data }: { data: object }) => ({ ...campaign, ...data })),
      update: jest.fn().mockResolvedValue(campaign), updateMany: jest.fn().mockResolvedValue({ count: 1 }), upsert: jest.fn().mockResolvedValue(campaign),
    },
    content: { create: jest.fn().mockResolvedValue(content), findFirstOrThrow: jest.fn().mockResolvedValue(content), update: jest.fn(), updateMany: jest.fn() },
    contentVariant: { findMany: jest.fn().mockResolvedValue([variant]), updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    platformAccount: { findMany: jest.fn().mockResolvedValue([account]) },
    campaignTarget: { create: jest.fn().mockResolvedValue({ id: 'target-1' }) },
    publishJob: { create: jest.fn() },
    $transaction: jest.fn(),
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
  });

  it('does not process a second AI task while another worker owns the lease', async () => {
    const { prisma, service } = setup();
    const worker = new CampaignAutomationWorkerService(prisma as unknown as PrismaService, { acquireLock: jest.fn().mockResolvedValue(null) } as unknown as RedisService, service);
    await worker.processNext();
    expect(prisma.campaign.findFirst).not.toHaveBeenCalled();
  });
});
