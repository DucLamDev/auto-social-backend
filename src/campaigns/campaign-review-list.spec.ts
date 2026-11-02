import { PrismaService } from '../database/prisma.service';
import { PublishQueueService } from '../queue/publish-queue.service';
import { CampaignsService } from './campaigns.service';

describe('AI review list', () => {
  it('includes legacy campaign variants and Studio drafts without changing historical publishing state', async () => {
    const createdAt = new Date();
    const campaignRows = [{
      id: 'old-campaign', contentId: 'old-content', status: 'PARTIAL', createdAt,
      content: { id: 'old-content', title: 'Old content', status: 'APPROVED' },
      automationState: null, automationVariantIds: [], automationRequest: null,
      targets: [
        { platformAccountId: 'account-1', contentVariantId: 'old-variant-1', contentVariant: { status: 'APPROVED' } },
        { platformAccountId: 'account-2', contentVariantId: 'old-variant-2', contentVariant: { status: 'APPROVED' } },
      ],
    }];
    const contentRows = [{ id: 'studio-content', title: 'Studio', status: 'GENERATED', createdAt, updatedAt: createdAt, variants: [{ id: 'studio-variant', platformId: 'platform-1', status: 'GENERATED' }, { id: 'older-studio-variant', platformId: 'platform-1', status: 'APPROVED' }] }];
    const prisma = { campaign: { findMany: jest.fn().mockResolvedValue(campaignRows) }, content: { findMany: jest.fn().mockResolvedValue(contentRows) } };
    const service = new CampaignsService(prisma as unknown as PrismaService, {} as PublishQueueService);
    const result = await service.listAiReview('owner-1');
    expect(result).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'old-campaign', status: 'PARTIAL', reviewMode: 'EXISTING_CAMPAIGN', automationState: 'APPROVED', automationVariantIds: ['old-variant-1', 'old-variant-2'], automationAccountIds: ['account-1', 'account-2'] }),
      expect.objectContaining({ id: 'studio-content', reviewMode: 'CONTENT', automationState: 'WAITING_REVIEW', automationVariantIds: ['studio-variant', 'older-studio-variant'] }),
    ]));
    expect(campaignRows[0]?.automationState).toBeNull();
    expect(prisma.campaign.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ ownerId: 'owner-1' }) as unknown }));
    expect(prisma.content.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ ownerId: 'owner-1' }) as unknown }));
  });

  it('does not duplicate reserved variants and shows standalone generation before any variants exist', async () => {
    const createdAt = new Date();
    const prisma = {
      campaign: { findMany: jest.fn().mockResolvedValue([{ id: 'campaign-1', contentId: 'content-1', status: 'DRAFT', createdAt,
        content: { id: 'content-1', status: 'GENERATED' }, automationState: 'WAITING_REVIEW', automationVariantIds: ['reserved'],
        automationRequest: { platformAccountIds: ['account-1'] }, targets: [] }]) },
      content: { findMany: jest.fn().mockResolvedValue([
        { id: 'content-1', status: 'GENERATED', createdAt, updatedAt: createdAt, variants: [{ id: 'reserved', platformId: 'p-1', status: 'GENERATED' }] },
        { id: 'generating-content', status: 'AI_GENERATING', createdAt, updatedAt: createdAt, variants: [] },
      ]) },
    };
    const service = new CampaignsService(prisma as unknown as PrismaService, {} as PublishQueueService);
    const result = await service.listAiReview('owner-1');
    expect(result).toHaveLength(2);
    expect(result.find((row) => row.id === 'generating-content')).toMatchObject({ reviewMode: 'CONTENT', automationState: 'PROCESSING', automationVariantIds: [] });
    expect(result.flatMap((row) => row.automationVariantIds)).toEqual(['reserved']);
  });
});
