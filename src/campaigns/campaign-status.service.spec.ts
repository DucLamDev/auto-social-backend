import { CampaignStatus, PublishJobStatus } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { CampaignStatusService } from './campaign-status.service';

describe('CampaignStatusService', () => {
  it('marks an all-published campaign completed', async () => {
    const update = jest.fn().mockResolvedValue({});
    const prisma = {
      publishJob: { findMany: jest.fn().mockResolvedValue([{ status: PublishJobStatus.PUBLISHED }]) },
      campaign: { update },
    } as unknown as PrismaService;

    await new CampaignStatusService(prisma).refresh('campaign-1');

    expect(update).toHaveBeenCalledWith({
      where: { id: 'campaign-1' },
      data: { status: CampaignStatus.COMPLETED },
    });
  });

  it('reconciles terminal active campaigns after crash recovery', async () => {
    const campaignFindMany = jest.fn().mockResolvedValue([{ id: 'campaign-1' }]);
    const update = jest.fn().mockResolvedValue({});
    const prisma = {
      publishJob: { findMany: jest.fn().mockResolvedValue([{ status: PublishJobStatus.POSSIBLE_DUPLICATE }]) },
      campaign: { findMany: campaignFindMany, update },
    } as unknown as PrismaService;

    await new CampaignStatusService(prisma).reconcileTerminal();

    expect(campaignFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        status: { in: [CampaignStatus.SCHEDULED, CampaignStatus.RUNNING] },
      }) as unknown,
      take: 100,
    }));
    expect(update).toHaveBeenCalledWith({
      where: { id: 'campaign-1' },
      data: { status: CampaignStatus.PARTIAL },
    });
  });
});
