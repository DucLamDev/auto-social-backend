import { ConflictException } from '@nestjs/common';
import { CampaignStatus, ContentStatus, PlatformMode, VariantStatus } from '@prisma/client';
import { AiContentService } from '../ai/ai-content.service';
import { AuditService } from '../audit/audit.service';
import { sha256 } from '../common/utils/crypto.utils';
import { PrismaService } from '../database/prisma.service';
import { CampaignAutomationService } from './campaign-automation.service';
import { CampaignsService } from './campaigns.service';
import { AutomateCampaignDto } from './dto/automate-campaign.dto';
import { CredentialsService } from '../credentials/credentials.service';

describe('CampaignAutomationService', () => {
  const ownerId = '11111111-1111-4111-8111-111111111111';
  const accountId = '22222222-2222-4222-8222-222222222222';
  const campaignId = '33333333-3333-4333-8333-333333333333';
  const contentId = '44444444-4444-4444-8444-444444444444';
  const variantId = '55555555-5555-4555-8555-555555555555';
  const dto: AutomateCampaignDto = {
    name: 'Launch',
    brief: 'A grounded product brief',
    platformAccountIds: [accountId],
    aiProvider: 'openai',
    timezone: 'UTC',
    publishImmediately: true,
  };
  const account = {
    id: accountId,
    platformId: 'platform-devto',
    platform: { id: 'platform-devto', slug: 'devto', mode: PlatformMode.OFFICIAL_API },
  };

  function providerResolver() {
    return jest.fn((provider?: AutomateCampaignDto['aiProvider']) => provider ?? 'openai');
  }

  function resultCampaign(status: CampaignStatus = CampaignStatus.RUNNING) {
    return {
      id: campaignId,
      contentId,
      status,
      targets: [{
        contentVariantId: variantId,
        publishJobs: [{ id: 'job-1' }],
      }],
    };
  }

  it('creates, approves, targets, and activates a campaign without publishing in-process', async () => {
    const content = { id: contentId, ownerId, title: dto.name, body: dto.brief, status: ContentStatus.DRAFT };
    const reservation = {
      id: campaignId,
      ownerId,
      contentId,
      status: CampaignStatus.DRAFT,
      automationRequestHash: '',
      automationErrorCode: null,
      updatedAt: new Date(),
      content,
      targets: [],
    };
    const campaignFindFirst = jest.fn().mockResolvedValue(null);
    const transactionContentCreate = jest.fn().mockResolvedValue(content);
    const transactionCampaignCreate = jest.fn().mockImplementation((input: {
      data: { automationRequestHash: string };
    }) => ({
      ...reservation,
      automationRequestHash: input.data.automationRequestHash,
    }));
    const variantUpdateMany = jest.fn().mockResolvedValue({ count: 1 });
    const campaignTargetCreate = jest.fn().mockResolvedValue({ id: 'target-1' });
    const publishJobCreate = jest.fn().mockResolvedValue({ id: 'job-1' });
    const prisma = {
      platformAccount: { findMany: jest.fn().mockResolvedValue([account]) },
      campaign: {
        findFirst: campaignFindFirst,
        create: transactionCampaignCreate,
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      content: {
        create: transactionContentCreate,
        update: jest.fn().mockResolvedValue({}),
        findFirstOrThrow: jest.fn().mockResolvedValue({ ...content, status: ContentStatus.APPROVED }),
      },
      contentVariant: { updateMany: variantUpdateMany },
      campaignTarget: { create: campaignTargetCreate },
      publishJob: { create: publishJobCreate },
    };
    Object.assign(prisma, {
      $transaction: jest.fn((callback: (transaction: typeof prisma) => Promise<unknown>) => callback(prisma)),
    });
    const ai = {
      resolveProvider: providerResolver(),
      assertReady: jest.fn().mockResolvedValue(undefined),
      generate: jest.fn().mockResolvedValue([{
        id: variantId,
        platformId: account.platformId,
        status: VariantStatus.GENERATED,
      }]),
    };
    const campaigns = {
      publish: jest.fn().mockResolvedValue(undefined),
      get: jest.fn().mockResolvedValue(resultCampaign()),
    };
    const audit = { recordBestEffort: jest.fn().mockResolvedValue(undefined) };
    const service = new CampaignAutomationService(
      prisma as unknown as PrismaService,
      ai as unknown as AiContentService,
      campaigns as unknown as CampaignsService,
      audit as unknown as AuditService,
    );

    const result = await service.automate(ownerId, dto, 'request-key-123', 'request-id');

    expect(ai.resolveProvider).toHaveBeenCalledWith('openai');
    expect(ai.assertReady).toHaveBeenCalledWith(['devto'], 'openai');
    expect(ai.generate).toHaveBeenCalledWith(ownerId, contentId, ['devto'], 'openai');
    expect(variantUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: { in: [variantId] }, status: VariantStatus.GENERATED }) as unknown,
      data: { status: VariantStatus.APPROVED },
    }));
    expect(campaignTargetCreate).toHaveBeenCalledTimes(1);
    expect(publishJobCreate).toHaveBeenCalledTimes(1);
    expect(campaigns.publish).toHaveBeenCalledWith(ownerId, campaignId);
    expect(result).toMatchObject({ generatedVariants: 1, jobsCreated: 1, activated: true });
  });

  it('performs AI preflight before creating persistent content or campaign records', async () => {
    const transaction = jest.fn();
    const prisma = {
      campaign: { findFirst: jest.fn().mockResolvedValue(null) },
      platformAccount: { findMany: jest.fn().mockResolvedValue([account]) },
      $transaction: transaction,
    };
    const unavailable = new Error('OPENAI_API_KEY is not configured');
    const ai = {
      resolveProvider: providerResolver(),
      assertReady: jest.fn().mockRejectedValue(unavailable),
      generate: jest.fn(),
    };
    const service = new CampaignAutomationService(
      prisma as unknown as PrismaService,
      ai as unknown as AiContentService,
      {} as CampaignsService,
      { recordBestEffort: jest.fn() } as unknown as AuditService,
    );

    await expect(service.automate(ownerId, dto, 'request-key-123')).rejects.toBe(unavailable);
    expect(transaction).not.toHaveBeenCalled();
    expect(ai.generate).not.toHaveBeenCalled();
  });

  it('returns an exact completed replay without requiring the account or AI to still be online', async () => {
    const firstMediaId = '66666666-6666-4666-8666-666666666666';
    const secondMediaId = '77777777-7777-4777-8777-777777777777';
    const replayDto = { ...dto, mediaAssetIds: [secondMediaId, firstMediaId] };
    const requestHash = sha256(JSON.stringify({
      name: replayDto.name,
      brief: replayDto.brief,
      platformAccountIds: [accountId],
      mediaAssetIds: [firstMediaId, secondMediaId],
      aiProvider: 'openai',
      scheduledAt: null,
      timezone: 'UTC',
      publishImmediately: true,
    }));
    const existing = {
      ...resultCampaign(CampaignStatus.RUNNING),
      automationRequestHash: requestHash,
      automationErrorCode: null,
      updatedAt: new Date(),
      content: { id: contentId },
    };
    const platformFindMany = jest.fn();
    const prisma = {
      campaign: { findFirst: jest.fn().mockResolvedValue(existing) },
      platformAccount: { findMany: platformFindMany },
      content: { findFirstOrThrow: jest.fn().mockResolvedValue({ id: contentId }) },
    };
    const ai = { resolveProvider: providerResolver(), assertReady: jest.fn(), generate: jest.fn() };
    const campaigns = { publish: jest.fn(), get: jest.fn().mockResolvedValue(resultCampaign()) };
    const service = new CampaignAutomationService(
      prisma as unknown as PrismaService,
      ai as unknown as AiContentService,
      campaigns as unknown as CampaignsService,
      { recordBestEffort: jest.fn().mockResolvedValue(undefined) } as unknown as AuditService,
    );

    await expect(service.automate(ownerId, replayDto, 'request-key-123')).resolves.toMatchObject({
      generatedVariants: 1,
      jobsCreated: 1,
      activated: true,
    });
    expect(platformFindMany).not.toHaveBeenCalled();
    expect(ai.assertReady).not.toHaveBeenCalled();
    expect(ai.generate).not.toHaveBeenCalled();
    expect(campaigns.publish).not.toHaveBeenCalled();
  });

  it('returns an exact scheduled replay even after its scheduled time has passed', async () => {
    const scheduledDto = { ...dto, scheduledAt: '2025-01-01T00:00:00.000Z' };
    const requestHash = sha256(JSON.stringify({
      name: scheduledDto.name,
      brief: scheduledDto.brief,
      platformAccountIds: [accountId],
      mediaAssetIds: [],
      aiProvider: 'openai',
      scheduledAt: scheduledDto.scheduledAt,
      timezone: 'UTC',
      publishImmediately: true,
    }));
    const existing = {
      ...resultCampaign(CampaignStatus.SCHEDULED),
      automationRequestHash: requestHash,
      automationErrorCode: null,
      updatedAt: new Date(),
      content: { id: contentId },
    };
    const prisma = {
      campaign: { findFirst: jest.fn().mockResolvedValue(existing) },
      content: { findFirstOrThrow: jest.fn().mockResolvedValue({ id: contentId }) },
    };
    const campaigns = {
      publish: jest.fn(),
      get: jest.fn().mockResolvedValue(resultCampaign(CampaignStatus.SCHEDULED)),
    };
    const service = new CampaignAutomationService(
      prisma as unknown as PrismaService,
      {
        resolveProvider: providerResolver(), assertReady: jest.fn(), generate: jest.fn(),
      } as unknown as AiContentService,
      campaigns as unknown as CampaignsService,
      { recordBestEffort: jest.fn().mockResolvedValue(undefined) } as unknown as AuditService,
    );

    await expect(service.automate(ownerId, scheduledDto, 'request-key-123')).resolves.toMatchObject({
      activated: true,
    });
  });

  it('leaves a generated campaign in DRAFT when publishImmediately is false', async () => {
    const draftDto = { ...dto, publishImmediately: false };
    const requestHash = sha256(JSON.stringify({
      name: draftDto.name,
      brief: draftDto.brief,
      platformAccountIds: [accountId],
      mediaAssetIds: [],
      aiProvider: 'openai',
      scheduledAt: null,
      timezone: 'UTC',
      publishImmediately: false,
    }));
    const existing = {
      ...resultCampaign(CampaignStatus.DRAFT),
      automationRequestHash: requestHash,
      automationErrorCode: null,
      updatedAt: new Date(),
      content: { id: contentId },
    };
    const prisma = {
      campaign: { findFirst: jest.fn().mockResolvedValue(existing) },
      content: { findFirstOrThrow: jest.fn().mockResolvedValue({ id: contentId }) },
    };
    const campaigns = { publish: jest.fn(), get: jest.fn().mockResolvedValue(resultCampaign(CampaignStatus.DRAFT)) };
    const service = new CampaignAutomationService(
      prisma as unknown as PrismaService,
      {
        resolveProvider: providerResolver(), assertReady: jest.fn(), generate: jest.fn(),
      } as unknown as AiContentService,
      campaigns as unknown as CampaignsService,
      { recordBestEffort: jest.fn().mockResolvedValue(undefined) } as unknown as AuditService,
    );

    await expect(service.automate(ownerId, draftDto, 'request-key-123')).resolves.toMatchObject({
      activated: false,
    });
    expect(campaigns.publish).not.toHaveBeenCalled();
  });

  it('resumes a failed automation with its complete generated variant set instead of calling AI again', async () => {
    const retryDto = { ...dto, publishImmediately: false };
    const requestHash = sha256(JSON.stringify({
      name: retryDto.name,
      brief: retryDto.brief,
      platformAccountIds: [accountId],
      mediaAssetIds: [],
      aiProvider: 'openai',
      scheduledAt: null,
      timezone: 'UTC',
      publishImmediately: false,
    }));
    const existing = {
      id: campaignId,
      ownerId,
      contentId,
      status: CampaignStatus.DRAFT,
      automationRequestHash: requestHash,
      automationErrorCode: 'INTERNAL_ERROR',
      updatedAt: new Date(),
      content: { id: contentId },
      targets: [],
    };
    const prisma = {
      campaign: {
        findFirst: jest.fn().mockResolvedValue(existing),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        update: jest.fn().mockResolvedValue({}),
      },
      platformAccount: { findMany: jest.fn().mockResolvedValue([account]) },
      contentVariant: {
        findMany: jest.fn().mockResolvedValue([{ id: variantId, platformId: account.platformId }]),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      campaignTarget: { create: jest.fn().mockResolvedValue({ id: 'target-1' }) },
      publishJob: { create: jest.fn().mockResolvedValue({ id: 'job-1' }) },
      content: {
        update: jest.fn().mockResolvedValue({}),
        findFirstOrThrow: jest.fn().mockResolvedValue({ id: contentId, status: ContentStatus.APPROVED }),
      },
    };
    Object.assign(prisma, {
      $transaction: jest.fn((callback: (transaction: typeof prisma) => Promise<unknown>) => callback(prisma)),
    });
    const ai = {
      resolveProvider: providerResolver(),
      assertReady: jest.fn().mockResolvedValue(undefined),
      generate: jest.fn(),
    };
    const campaigns = {
      publish: jest.fn(),
      get: jest.fn().mockResolvedValue(resultCampaign(CampaignStatus.DRAFT)),
    };
    const service = new CampaignAutomationService(
      prisma as unknown as PrismaService,
      ai as unknown as AiContentService,
      campaigns as unknown as CampaignsService,
      { recordBestEffort: jest.fn().mockResolvedValue(undefined) } as unknown as AuditService,
    );

    await expect(service.automate(ownerId, retryDto, 'request-key-123')).resolves.toMatchObject({
      generatedVariants: 1,
      jobsCreated: 1,
      activated: false,
    });
    expect(ai.generate).not.toHaveBeenCalled();
    expect(prisma.campaignTarget.create).toHaveBeenCalledTimes(1);
    expect(prisma.publishJob.create).toHaveBeenCalledTimes(1);
  });

  it('rejects reuse of an idempotency key with a different payload', async () => {
    const prisma = {
      campaign: { findFirst: jest.fn().mockResolvedValue({
        id: campaignId,
        automationRequestHash: 'different-request',
        targets: [],
      }) },
    };
    const service = new CampaignAutomationService(
      prisma as unknown as PrismaService,
      { resolveProvider: providerResolver(), assertReady: jest.fn() } as unknown as AiContentService,
      {} as CampaignsService,
      { recordBestEffort: jest.fn().mockResolvedValue(undefined) } as unknown as AuditService,
    );

    await expect(service.automate(ownerId, dto, 'request-key-123')).rejects.toBeInstanceOf(ConflictException);
  });

  it('rejects manual destinations from one-click campaign automation', async () => {
    const manualAccount = {
      ...account,
      platform: { ...account.platform, slug: 'reddit', mode: PlatformMode.MANUAL },
    };
    const prisma = {
      campaign: { findFirst: jest.fn().mockResolvedValue(null) },
      platformAccount: { findMany: jest.fn().mockResolvedValue([manualAccount]) },
    };
    const service = new CampaignAutomationService(
      prisma as unknown as PrismaService,
      {} as AiContentService,
      {} as CampaignsService,
      {} as AuditService,
    );
    const target = service as unknown as {
      loadConnectedAccounts(owner: string, accountIds: string[]): Promise<typeof manualAccount[]>;
    };

    await expect(target.loadConnectedAccounts(ownerId, [accountId]))
      .rejects.toThrow('Automatic publishing is unavailable for: reddit');
  });

  it('requires a real session and explicit browser auto-submit consent during preflight', async () => {
    const browserAccount = {
      id: accountId,
      platformId: 'platform-voz',
      settings: {
        browserRecipe: 'voz-xenforo',
        automationPermissionAttested: true,
        browserAutoSubmit: true,
      },
      credential: { status: 'ACTIVE', expiresAt: null },
      platform: {
        id: 'platform-voz',
        slug: 'voz-forums',
        mode: PlatformMode.BROWSER_ASSISTED,
        connectorKey: 'browser-assisted',
      },
    };
    const findMany = jest.fn().mockResolvedValue([browserAccount]);
    const resolve = jest.fn().mockResolvedValue({
      storageState: {
        cookies: [{ name: 'session', value: 'secret', domain: 'voz.vn', path: '/' }],
        origins: [],
      },
    });
    const service = new CampaignAutomationService(
      { platformAccount: { findMany } } as unknown as PrismaService,
      {} as AiContentService,
      {} as CampaignsService,
      {} as AuditService,
      { resolve } as unknown as CredentialsService,
    );
    const target = service as unknown as {
      loadConnectedAccounts(owner: string, accountIds: string[]): Promise<unknown[]>;
    };

    await expect(target.loadConnectedAccounts(ownerId, [accountId])).resolves.toHaveLength(1);
    resolve.mockResolvedValueOnce({ storageState: { cookies: [], origins: [] } });
    await expect(target.loadConnectedAccounts(ownerId, [accountId]))
      .rejects.toThrow('requires a captured login session');
    browserAccount.settings.browserAutoSubmit = false;
    await expect(target.loadConnectedAccounts(ownerId, [accountId]))
      .rejects.toThrow('requires a captured login session');
  });

  it('validates and atomically attaches media, while accepting the same attachment on retry', async () => {
    const imageId = '66666666-6666-4666-8666-666666666666';
    const updateMany = jest.fn().mockResolvedValue({ count: 1 });
    const transaction = { mediaAsset: { updateMany } };
    const prisma = {
      mediaAsset: {
        findMany: jest.fn().mockResolvedValue([{
          id: imageId,
          contentId,
          variantId: null,
        }]),
      },
      $transaction: jest.fn(
        (callback: (client: typeof transaction) => Promise<void>) => callback(transaction),
      ),
    };
    const service = new CampaignAutomationService(
      prisma as unknown as PrismaService,
      {} as AiContentService,
      {} as CampaignsService,
      {} as AuditService,
    );
    const target = service as unknown as {
      validateMediaAssets(owner: string, ids: string[], reservationId?: string): Promise<void>;
      attachMediaAssets(owner: string, targetContentId: string, ids: string[]): Promise<void>;
    };

    await expect(target.validateMediaAssets(ownerId, [imageId], contentId)).resolves.toBeUndefined();
    await expect(target.attachMediaAssets(ownerId, contentId, [imageId])).resolves.toBeUndefined();
    expect(updateMany).toHaveBeenCalledWith({
      where: {
        id: { in: [imageId] },
        ownerId,
        variantId: null,
        OR: [{ contentId: null }, { contentId }],
      },
      data: { contentId },
    });
  });

  it('rejects media already attached to another content item', async () => {
    const imageId = '66666666-6666-4666-8666-666666666666';
    const service = new CampaignAutomationService(
      {
        mediaAsset: {
          findMany: jest.fn().mockResolvedValue([{
            id: imageId,
            contentId: '77777777-7777-4777-8777-777777777777',
            variantId: null,
          }]),
        },
      } as unknown as PrismaService,
      {} as AiContentService,
      {} as CampaignsService,
      {} as AuditService,
    );
    const target = service as unknown as {
      validateMediaAssets(owner: string, ids: string[], reservationId?: string): Promise<void>;
    };

    await expect(target.validateMediaAssets(ownerId, [imageId], contentId))
      .rejects.toThrow('must be unattached');
  });

  it('recovers a stale crashed automation content claim before retrying', async () => {
    const campaignUpdateMany = jest.fn().mockResolvedValue({ count: 1 });
    const contentUpdateMany = jest.fn().mockResolvedValue({ count: 1 });
    const service = new CampaignAutomationService(
      {
        campaign: { updateMany: campaignUpdateMany },
        content: { updateMany: contentUpdateMany },
      } as unknown as PrismaService,
      {} as AiContentService,
      {} as CampaignsService,
      {} as AuditService,
    );
    const target = service as unknown as {
      claimRetry(owner: string, campaign: {
        id: string;
        contentId: string;
        automationErrorCode: string | null;
        updatedAt: Date;
      }): Promise<void>;
    };

    await target.claimRetry(ownerId, {
      id: campaignId,
      contentId,
      automationErrorCode: null,
      updatedAt: new Date(Date.now() - 21 * 60 * 1000),
    });

    expect(contentUpdateMany).toHaveBeenCalledWith({
      where: { id: contentId, ownerId, status: ContentStatus.AI_GENERATING },
      data: { status: ContentStatus.DRAFT },
    });
  });
});
