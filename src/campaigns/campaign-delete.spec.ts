import { ConflictException, NotFoundException } from '@nestjs/common';
import { AiContentService } from '../ai/ai-content.service';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../database/prisma.service';
import { CampaignAutomationService } from './campaign-automation.service';
import { CampaignsService } from './campaigns.service';

function setup(state = 'FAILED', kind: string | null = 'brief') {
  const campaign = { id: 'campaign-1', name: 'Proxy HTTP hay SOCKS5', contentId: 'content-1', automationState: state, content: { aiAnalysis: kind ? { kind } : null } };
  const prisma = {
    $queryRaw: jest.fn(),
    campaign: { findFirst: jest.fn().mockResolvedValue(campaign), delete: jest.fn(), count: jest.fn().mockResolvedValue(0) },
    publishedPost: { count: jest.fn().mockResolvedValue(0) },
    publishJob: { count: jest.fn().mockResolvedValue(0) },
    campaignTarget: { count: jest.fn().mockResolvedValue(0) },
    content: { delete: jest.fn() },
    $transaction: jest.fn(),
  };
  prisma.$transaction.mockImplementation((fn: (tx: typeof prisma) => unknown) => fn(prisma));
  const audit = { recordBestEffort: jest.fn() };
  const service = new CampaignAutomationService(prisma as unknown as PrismaService, {} as AiContentService, {} as CampaignsService, audit as unknown as AuditService);
  return { service, prisma, audit };
}

describe('Deleting an AI run from "Content đợi duyệt"', () => {
  it('deletes a failed run with its jobs and the brief content made for it, and records it', async () => {
    const { service, prisma, audit } = setup('FAILED');
    await expect(service.remove('owner-1', 'campaign-1')).resolves.toEqual({ deleted: true, contentRemoved: true });
    // The row is locked first so the worker cannot claim it meanwhile; only the owner's AI runs are found.
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    expect(prisma.campaign.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'campaign-1', ownerId: 'owner-1', automationState: { not: null } } }));
    expect(prisma.campaign.delete).toHaveBeenCalledWith({ where: { id: 'campaign-1' } });
    expect(prisma.content.delete).toHaveBeenCalledWith({ where: { id: 'content-1' } });
    expect(audit.recordBestEffort).toHaveBeenCalledWith(expect.objectContaining({ action: 'CAMPAIGN_AUTOMATION_DELETED', entityId: 'campaign-1' }));
  });

  it('keeps library content, and brief content another campaign still uses', async () => {
    const library = setup('WAITING_REVIEW', null);
    await expect(library.service.remove('owner-1', 'campaign-1')).resolves.toEqual({ deleted: true, contentRemoved: false });
    expect(library.prisma.content.delete).not.toHaveBeenCalled();
    const shared = setup('WAITING_REVIEW');
    shared.prisma.campaign.count.mockResolvedValue(1);
    await expect(shared.service.remove('owner-1', 'campaign-1')).resolves.toEqual({ deleted: true, contentRemoved: false });
    expect(shared.prisma.content.delete).not.toHaveBeenCalled();
  });

  it('refuses while the AI writes, while a post is being published, and once a post is live', async () => {
    const writing = setup('PROCESSING');
    await expect(writing.service.remove('owner-1', 'campaign-1')).rejects.toThrow('AI đang viết bài cho lượt này');
    const publishing = setup('APPROVED');
    publishing.prisma.publishJob.count.mockResolvedValue(1);
    await expect(publishing.service.remove('owner-1', 'campaign-1')).rejects.toBeInstanceOf(ConflictException);
    const live = setup('APPROVED');
    live.prisma.publishedPost.count.mockResolvedValue(2);
    await expect(live.service.remove('owner-1', 'campaign-1')).rejects.toThrow('đã có 2 bài đăng lên social');
    for (const blocked of [writing, publishing, live]) expect(blocked.prisma.campaign.delete).not.toHaveBeenCalled();
  });

  it('does not find another owner\'s run or a campaign that is not an AI run', async () => {
    const { service, prisma } = setup();
    prisma.campaign.findFirst.mockResolvedValue(null);
    await expect(service.remove('owner-2', 'campaign-1')).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.campaign.delete).not.toHaveBeenCalled();
  });
});
