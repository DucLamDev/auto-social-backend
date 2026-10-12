import {
  AccountStatus,
  MediaType,
  PlatformMode,
  PublishJobStatus,
  VariantStatus,
} from '@prisma/client';
import { ConnectorAccountsService } from '../connectors/connector-accounts.service';
import { ConnectorRegistryService } from '../connectors/core/connector-registry.service';
import { ConnectorError } from '../connectors/core/connector-error';
import { POST_MEDIA_MANAGED_STORAGE, PostPayload } from '../connectors/core/connector.types';
import { SocialPublisher } from '../connectors/core/social-publisher.interface';
import { ErrorCode } from '../common/exceptions/application.exception';
import { CampaignStatusService } from '../campaigns/campaign-status.service';
import { PrismaService } from '../database/prisma.service';
import { RedisService } from '../queue/redis.service';
import { DeadLetterDeliveryError } from '../queue/queue.types';
import {
  assertPublishAccountReady,
  assertFreshPublishAuthorization,
  assertVariantApproved,
  collectPublishMedia,
  effectiveConnectorCapability,
  filterPublishMediaForConnector,
  publishFingerprintLockKey,
  PublishingService,
} from './publishing.service';

function publishJobFixture(status: PublishJobStatus = PublishJobStatus.QUEUED) {
  return {
    id: 'job-1',
    status,
    publishedPost: null,
    attempts: [],
    platformAccountId: 'account-1',
    idempotencyKey: 'key-1',
    attemptCount: 0,
    maxAttempts: 3,
    platformAccount: {
      id: 'account-1',
      enabled: true,
      status: AccountStatus.CONNECTED,
      settings: {},
      platform: { slug: 'x', enabled: true },
    },
    target: {
      overrides: { allowDuplicate: true },
      campaignId: 'campaign-1',
      campaign: { id: 'campaign-1' },
      contentVariant: {
        status: VariantStatus.APPROVED,
        title: 'A topic',
        body: 'hello',
        summary: null,
        hashtags: [],
        media: [],
        content: { canonicalUrl: null, contentHash: 'content-hash', media: [] },
      },
    },
  };
}

function loadedAccountFixture(overrides: Record<string, unknown> = {}) {
  return {
    platform: 'x',
    connectorKey: 'x',
    platformEnabled: true,
    platformMode: PlatformMode.OFFICIAL_API,
    enabled: true,
    status: AccountStatus.CONNECTED,
    account: { id: 'account-1', settings: {}, credentials: {} },
    ...overrides,
  };
}

describe('PublishingService idempotency', () => {
  it('inherits canonical content media and combines it with variant-specific media', () => {
    const canonical = {
      id: 'canonical-image',
      type: MediaType.IMAGE,
      publicUrl: 'https://cdn.example/content.png',
      mimeType: 'image/png',
      metadata: { altText: 'Product dashboard' },
    };
    const media = collectPublishMedia(
      [canonical, { id: 'private', type: MediaType.IMAGE, publicUrl: null, mimeType: 'image/png' }],
      [
        canonical,
        {
          id: 'variant-video',
          type: MediaType.VIDEO,
          publicUrl: 'https://cdn.example/variant.mp4',
          mimeType: 'video/mp4',
        },
      ],
    );

    expect(media).toEqual([
      {
        type: 'image',
        url: 'https://cdn.example/content.png',
        mimeType: 'image/png',
        altText: 'Product dashboard',
      },
      { type: 'video', url: 'https://cdn.example/variant.mp4', mimeType: 'video/mp4' },
    ]);
  });

  it('carries database-owned storage provenance without exposing it in JSON', () => {
    const [media] = collectPublishMedia(
      [
        {
          id: 'managed-image',
          type: MediaType.IMAGE,
          publicUrl: 'http://localhost:9000/social-publisher/media/diagram.png',
          mimeType: 'image/png',
          storageKey: 'media/2026-10-09/diagram.png',
          checksum: 'a'.repeat(64),
          sizeBytes: BigInt(123),
        },
      ],
      [],
    );

    expect(media?.[POST_MEDIA_MANAGED_STORAGE]).toEqual({
      storageKey: 'media/2026-10-09/diagram.png',
      checksum: 'a'.repeat(64),
      sizeBytes: 123,
    });
    expect(JSON.stringify(media)).not.toContain('storageKey');
  });

  it('passes only connector-supported media, while preserving all media for manual handoff', () => {
    const media = [
      { type: 'image' as const, url: 'https://cdn.example/one.png' },
      { type: 'image' as const, url: 'https://cdn.example/two.png' },
      { type: 'video' as const, url: 'https://cdn.example/demo.mp4' },
      { type: 'document' as const, url: 'https://cdn.example/guide.pdf' },
    ];
    const imageOnly = {
      text: true,
      image: true,
      video: false,
      article: false,
      delete: false,
      schedule: false,
      analytics: false,
      maxImages: 1,
    };

    expect(filterPublishMediaForConnector(media, imageOnly, PlatformMode.OFFICIAL_API)).toEqual([
      media[0],
    ]);
    expect(filterPublishMediaForConnector(media, imageOnly, PlatformMode.MANUAL)).toEqual(media);
  });

  it('intersects shared connector capabilities with the selected platform capability', () => {
    const sharedBrowser = {
      text: true,
      image: true,
      video: false,
      article: true,
      delete: false,
      schedule: false,
      analytics: false,
      maxImages: 4,
    };

    expect(effectiveConnectorCapability(sharedBrowser, {
      ...sharedBrowser,
      image: false,
      maxImages: 1,
    })).toMatchObject({ image: false, maxImages: 1 });
    expect(effectiveConnectorCapability({ ...sharedBrowser, image: false }, {
      ...sharedBrowser,
      image: true,
    })).toMatchObject({ image: false });
  });

  it('builds a stable scoped fingerprint lock key and rejects unapproved variants', () => {
    const key = publishFingerprintLockKey('account-1', 'content-hash');
    expect(key).toMatch(/^lock:publish-fingerprint:[a-f0-9]{64}$/);
    expect(key).toBe(publishFingerprintLockKey('account-1', 'content-hash'));
    expect(key).not.toBe(publishFingerprintLockKey('account-2', 'content-hash'));
    expect(() => assertVariantApproved(VariantStatus.REJECTED)).toThrow('no longer approved');
  });

  it.each([
    [
      { enabled: true, status: AccountStatus.CONNECTED, platform: { enabled: false } },
      ErrorCode.CONNECTOR_NEEDS_ACTION,
    ],
    [
      { enabled: false, status: AccountStatus.DISABLED, platform: { enabled: true } },
      ErrorCode.CONNECTOR_NEEDS_ACTION,
    ],
    [
      { enabled: true, status: AccountStatus.RECONNECT_REQUIRED, platform: { enabled: true } },
      ErrorCode.PLATFORM_AUTH_FAILED,
    ],
  ] as const)('blocks disabled or unready publish destinations', (accountState, code) => {
    let thrown: unknown;
    try {
      assertPublishAccountReady(accountState);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ code });
  });

  it('requires a fresh browser session, attestation, and auto-submit at the provider boundary', () => {
    const storageState = {
      cookies: [{ name: 'session', value: 'secret', domain: 'voz.vn', path: '/' }],
      origins: [],
    };
    expect(() => assertFreshPublishAuthorization(loadedAccountFixture({
      connectorKey: 'browser-assisted',
      platformMode: PlatformMode.BROWSER_ASSISTED,
      account: {
        id: 'account-1',
        settings: { automationPermissionAttested: true, browserAutoSubmit: true },
        credentials: { storageState },
      },
    }))).not.toThrow();
    expect(() => assertFreshPublishAuthorization(loadedAccountFixture({
      connectorKey: 'browser-assisted',
      platformMode: PlatformMode.BROWSER_ASSISTED,
      account: {
        id: 'account-1',
        settings: { automationPermissionAttested: false, browserAutoSubmit: true },
        credentials: { storageState },
      },
    }))).toThrow('permission must be attested');
    expect(() => assertFreshPublishAuthorization(loadedAccountFixture({
      connectorKey: 'browser-assisted',
      platformMode: PlatformMode.BROWSER_ASSISTED,
      account: {
        id: 'account-1',
        settings: { automationPermissionAttested: true, browserAutoSubmit: true },
        credentials: { storageState: { cookies: [], origins: [] } },
      },
    }))).toThrow('missing or revoked');
  });

  it('does not invoke a connector when a duplicate delivery already has PublishedPost', async () => {
    const findJob = jest.fn().mockResolvedValue({
      id: 'job-1',
      status: PublishJobStatus.QUEUED,
      publishedPost: { id: 'published-1' },
      target: { campaignId: 'campaign-1' },
    });
    const prisma = {
      publishJob: {
        findUniqueOrThrow: findJob,
        findMany: jest.fn().mockResolvedValue([{ status: PublishJobStatus.PUBLISHED }]),
      },
      campaign: { update: jest.fn().mockResolvedValue({}) },
    } as unknown as PrismaService;
    const acquireLock = jest.fn().mockResolvedValue('lock-token');
    const releaseLock = jest.fn().mockResolvedValue(true);
    const redis = {
      acquireLock,
      extendLock: jest.fn().mockResolvedValue(true),
      releaseLock,
    } as unknown as RedisService;
    const loadAccount = jest.fn();
    const connectorAccounts = { load: loadAccount } as unknown as ConnectorAccountsService;
    const registry = { get: jest.fn() } as unknown as ConnectorRegistryService;
    const service = new PublishingService(
      prisma,
      redis,
      connectorAccounts,
      registry,
      new CampaignStatusService(prisma),
    );
    await service.process('job-1');
    expect(findJob).toHaveBeenCalledTimes(1);
    expect(loadAccount).not.toHaveBeenCalled();
    expect(releaseLock).toHaveBeenCalledWith('lock:publish:job-1', 'lock-token');
  });

  it('serializes different jobs with the same account and content fingerprint', async () => {
    const makeJob = (id: string) => ({
      id,
      status: PublishJobStatus.QUEUED,
      publishedPost: null,
      platformAccountId: 'account-1',
      idempotencyKey: `key-${id}`,
      attemptCount: 0,
      maxAttempts: 3,
      platformAccount: {
        id: 'account-1',
        enabled: true,
        status: AccountStatus.CONNECTED,
        settings: {},
        platform: { slug: 'x', enabled: true },
      },
      target: {
        overrides: {},
        campaignId: `campaign-${id}`,
        campaign: { id: `campaign-${id}` },
        contentVariant: {
          status: VariantStatus.APPROVED,
          title: null,
          body: 'same content',
          summary: null,
          hashtags: [],
          media: [],
          content: {
            canonicalUrl: null,
            contentHash: 'same-content-hash',
            media: [
              {
                id: 'canonical-image',
                type: MediaType.IMAGE,
                publicUrl: 'https://cdn.example/content.png',
                mimeType: 'image/png',
              },
            ],
          },
        },
      },
    });
    const jobs = new Map([
      ['job-1', makeJob('job-1')],
      ['job-2', makeJob('job-2')],
    ]);
    const jobUpdate = jest.fn().mockResolvedValue({});
    const publishedCreate = jest.fn().mockResolvedValue({});
    const transactionClient = {
      publishJob: { update: jobUpdate },
      publishAttempt: {
        create: jest.fn().mockResolvedValue({ id: 'attempt-1' }),
        update: jest.fn().mockResolvedValue({}),
      },
      publishedPost: { create: publishedCreate },
    };
    const prisma = {
      publishJob: {
        findUniqueOrThrow: jest.fn(({ where }: { where: { id: string } }) =>
          Promise.resolve(jobs.get(where.id)),
        ),
        findFirst: jest.fn().mockResolvedValue(null),
        update: jobUpdate,
      },
      publishedPost: { findFirst: jest.fn().mockResolvedValue(null) },
      $transaction: jest.fn((callback: (client: typeof transactionClient) => Promise<unknown>) =>
        callback(transactionClient),
      ),
    } as unknown as PrismaService;

    const locks = new Map<string, string>();
    const acquireLock = jest.fn((key: string) => {
      if (locks.has(key)) return Promise.resolve(null);
      const token = `token-${locks.size + 1}`;
      locks.set(key, token);
      return Promise.resolve(token);
    });
    const releaseLock = jest.fn((key: string, token: string) => {
      if (locks.get(key) !== token) return Promise.resolve(false);
      locks.delete(key);
      return Promise.resolve(true);
    });
    const redis = {
      acquireLock,
      extendLock: jest.fn().mockResolvedValue(true),
      releaseLock,
      consumeRateLimit: jest.fn().mockResolvedValue({ allowed: true, remaining: 9 }),
    } as unknown as RedisService;
    let signalStarted: (() => void) | undefined;
    let continuePublish: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      continuePublish = resolve;
    });
    const publish = jest.fn<
      Promise<{ externalId: string; status: 'PUBLISHED' }>,
      [account: unknown, payload: PostPayload]
    >(async () => {
      signalStarted?.();
      await gate;
      return { externalId: 'external-1', status: 'PUBLISHED' as const };
    });
    const connector = {
      validate: jest.fn().mockResolvedValue(undefined),
      publish,
    } as unknown as SocialPublisher;
    const campaignStatus = {
      refresh: jest.fn().mockResolvedValue(undefined),
    } as unknown as CampaignStatusService;
    const service = new PublishingService(
      prisma,
      redis,
      {
        load: jest
          .fn()
          .mockResolvedValue(loadedAccountFixture()),
      } as unknown as ConnectorAccountsService,
      { get: jest.fn().mockReturnValue(connector) } as unknown as ConnectorRegistryService,
      campaignStatus,
    );

    const first = service.process('job-1');
    await started;
    await service.process('job-2');
    continuePublish?.();
    await first;

    const fingerprintKey = publishFingerprintLockKey('account-1', 'same-content-hash');
    expect(acquireLock.mock.calls.filter(([key]) => key === fingerprintKey)).toHaveLength(2);
    expect(acquireLock).toHaveBeenCalledWith(fingerprintKey, 600_000);
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish.mock.calls[0]?.[1].media).toBeUndefined();
    expect(publishedCreate).toHaveBeenCalledTimes(1);
    expect(jobUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'job-2' },
        data: expect.objectContaining({ status: PublishJobStatus.RETRY }) as unknown,
      }),
    );
  });

  it.each([
    [
      'a published topic',
      {
        externalId: 'topic-42',
        url: 'https://forum.example/t/topic/42',
        status: 'PUBLISHED' as const,
        metadata: undefined,
      },
      true,
    ],
    [
      'a moderation submission',
      {
        externalId: 'pending-77',
        status: 'NEEDS_ACTION' as const,
        metadata: { moderationQueue: true, pendingPostId: 77 },
      },
      false,
    ],
    [
      'an uncertain Discourse submission',
      {
        externalId: 'pending:sp-external-id',
        status: 'NEEDS_ACTION' as const,
        metadata: {
          reconciliationRequired: true,
          submissionUncertain: true,
          providerExternalId: 'sp-external-id',
        },
      },
      false,
    ],
    [
      'a manual publishing action',
      {
        externalId: 'manual:action-1',
        status: 'NEEDS_ACTION' as const,
        metadata: { reason: 'Manual publishing is required' },
      },
      false,
    ],
  ] as const)(
    'recovers %s without replaying the connector after result persistence fails',
    async (_label, result, providerAcceptedRecovery) => {
      const job = publishJobFixture();
      const stateAfterFailedPersistence = {
        id: job.id,
        status: PublishJobStatus.PUBLISHING,
        publishedPost: null,
        attempts: [{ id: 'attempt-1', status: 'STARTED', responseMetadata: null }],
      };
      const jobUpdate = jest.fn().mockResolvedValue({});
      const jobUpdateMany = jest.fn().mockResolvedValue({ count: 1 });
      const attemptUpdate = jest.fn().mockResolvedValue({});
      const transactionClient = {
        publishJob: { update: jobUpdate, updateMany: jobUpdateMany },
        publishAttempt: {
          create: jest.fn().mockResolvedValue({ id: 'attempt-1' }),
          update: attemptUpdate,
        },
        publishedPost: { create: jest.fn().mockResolvedValue({}) },
      };
      let transactionNumber = 0;
      const prisma = {
        publishJob: {
          findUniqueOrThrow: jest
            .fn()
            .mockResolvedValueOnce(job)
            .mockResolvedValueOnce(stateAfterFailedPersistence),
        },
        $transaction: jest.fn(
          async (callback: (client: typeof transactionClient) => Promise<unknown>) => {
            transactionNumber += 1;
            if (transactionNumber === 2) throw new Error('database response lost');
            return callback(transactionClient);
          },
        ),
      } as unknown as PrismaService;
      const publish = jest.fn().mockResolvedValue(result);
      const campaignStatus = {
        refresh: jest.fn().mockResolvedValue(undefined),
      } as unknown as CampaignStatusService;
      const service = new PublishingService(
        prisma,
        {
          acquireLock: jest.fn().mockResolvedValue('token'),
          extendLock: jest.fn().mockResolvedValue(true),
          releaseLock: jest.fn().mockResolvedValue(true),
          consumeRateLimit: jest.fn().mockResolvedValue({ allowed: true, remaining: 9 }),
        } as unknown as RedisService,
        {
          load: jest
            .fn()
            .mockResolvedValue(loadedAccountFixture()),
        } as unknown as ConnectorAccountsService,
        {
          get: jest.fn().mockReturnValue({ validate: jest.fn(), publish }),
        } as unknown as ConnectorRegistryService,
        campaignStatus,
      );

      await expect(service.process(job.id)).resolves.toBeUndefined();

      expect(publish).toHaveBeenCalledTimes(1);
      expect(jobUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ id: job.id }) as unknown,
          data: expect.objectContaining({
            status: PublishJobStatus.NEEDS_ACTION,
            nextAttemptAt: null,
            lockedAt: null,
          }) as unknown,
        }),
      );
      if (providerAcceptedRecovery) {
        expect(attemptUpdate).toHaveBeenLastCalledWith(
          expect.objectContaining({
            where: { id: 'attempt-1' },
            data: expect.objectContaining({
              status: 'SUCCEEDED',
              responseMetadata: expect.objectContaining({
                ...(result.metadata ?? {}),
                externalPostId: result.externalId,
                providerAccepted: true,
                reconciliationRequired: true,
                persistenceRecoveryRequired: true,
                originalResultStatus: result.status,
              }) as unknown,
            }) as unknown,
          }),
        );
      } else {
        expect(attemptUpdate).toHaveBeenLastCalledWith(
          expect.objectContaining({
            where: { id: 'attempt-1' },
            data: expect.objectContaining({
              status: 'SUCCEEDED',
              responseMetadata: expect.objectContaining({
                ...(result.metadata ?? {}),
                resultPersistenceRecovered: true,
                originalResultStatus: result.status,
              }) as unknown,
            }) as unknown,
          }),
        );
        expect(attemptUpdate).toHaveBeenLastCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({
              responseMetadata: expect.not.objectContaining({
                providerAccepted: true,
              }) as unknown,
            }) as unknown,
          }),
        );
        expect(attemptUpdate).toHaveBeenLastCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({
              responseMetadata: expect.not.objectContaining({
                persistenceRecoveryRequired: true,
              }) as unknown,
            }) as unknown,
          }),
        );
      }
      expect(JSON.stringify(jobUpdate.mock.calls)).not.toContain(
        `"status":"${PublishJobStatus.RETRY}"`,
      );
    },
  );

  it('does not overwrite a result that committed when the persistence response was lost', async () => {
    const job = publishJobFixture();
    const committed = {
      id: job.id,
      status: PublishJobStatus.PUBLISHED,
      publishedPost: { id: 'published-1' },
      attempts: [{ id: 'attempt-1', status: 'SUCCEEDED', responseMetadata: {} }],
    };
    const recoveryUpdate = jest.fn();
    const transactionClient = {
      publishJob: { update: jest.fn().mockResolvedValue({}), updateMany: recoveryUpdate },
      publishAttempt: {
        create: jest.fn().mockResolvedValue({ id: 'attempt-1' }),
        update: jest.fn().mockResolvedValue({}),
      },
      publishedPost: { create: jest.fn().mockResolvedValue({}) },
    };
    let transactionNumber = 0;
    const prisma = {
      publishJob: {
        findUniqueOrThrow: jest.fn().mockResolvedValueOnce(job).mockResolvedValueOnce(committed),
      },
      $transaction: jest.fn(
        async (callback: (client: typeof transactionClient) => Promise<unknown>) => {
          transactionNumber += 1;
          if (transactionNumber === 2) throw new Error('commit response lost');
          return callback(transactionClient);
        },
      ),
    } as unknown as PrismaService;
    const publish = jest.fn().mockResolvedValue({
      externalId: 'topic-42',
      url: 'https://forum.example/t/topic/42',
      status: 'PUBLISHED',
    });
    const service = new PublishingService(
      prisma,
      {
        acquireLock: jest.fn().mockResolvedValue('token'),
        extendLock: jest.fn().mockResolvedValue(true),
        releaseLock: jest.fn().mockResolvedValue(true),
        consumeRateLimit: jest.fn().mockResolvedValue({ allowed: true, remaining: 9 }),
      } as unknown as RedisService,
      {
        load: jest
          .fn()
          .mockResolvedValue(loadedAccountFixture()),
      } as unknown as ConnectorAccountsService,
      {
        get: jest.fn().mockReturnValue({ validate: jest.fn(), publish }),
      } as unknown as ConnectorRegistryService,
      { refresh: jest.fn().mockResolvedValue(undefined) } as unknown as CampaignStatusService,
    );

    await service.process(job.id);

    expect(publish).toHaveBeenCalledTimes(1);
    expect(transactionNumber).toBe(2);
    expect(recoveryUpdate).not.toHaveBeenCalled();
  });

  it('marks the account for reconnect while keeping an uncertain accepted result in NEEDS_ACTION', async () => {
    const job = publishJobFixture();
    const jobUpdate = jest.fn().mockResolvedValue({});
    const accountUpdate = jest.fn().mockResolvedValue({});
    const transactionClient = {
      publishJob: { update: jobUpdate },
      publishAttempt: {
        create: jest.fn().mockResolvedValue({ id: 'attempt-1' }),
        update: jest.fn().mockResolvedValue({}),
      },
      platformAccount: { update: accountUpdate },
      publishedPost: { create: jest.fn().mockResolvedValue({}) },
    };
    const prisma = {
      publishJob: { findUniqueOrThrow: jest.fn().mockResolvedValue(job) },
      $transaction: jest.fn((callback: (client: typeof transactionClient) => Promise<unknown>) =>
        callback(transactionClient),
      ),
    } as unknown as PrismaService;
    const publish = jest.fn().mockResolvedValue({
      externalId: 'sp-uncertain',
      status: 'NEEDS_ACTION',
      metadata: {
        reconciliationRequired: true,
        reconciliationLookupErrorCode: ErrorCode.PLATFORM_TOKEN_EXPIRED,
        accountReconnectRequired: true,
      },
    });
    const service = new PublishingService(
      prisma,
      {
        acquireLock: jest.fn().mockResolvedValue('token'),
        extendLock: jest.fn().mockResolvedValue(true),
        releaseLock: jest.fn().mockResolvedValue(true),
        consumeRateLimit: jest.fn().mockResolvedValue({ allowed: true, remaining: 9 }),
      } as unknown as RedisService,
      {
        load: jest
          .fn()
          .mockResolvedValue(loadedAccountFixture()),
      } as unknown as ConnectorAccountsService,
      {
        get: jest.fn().mockReturnValue({ validate: jest.fn(), publish }),
      } as unknown as ConnectorRegistryService,
      { refresh: jest.fn().mockResolvedValue(undefined) } as unknown as CampaignStatusService,
    );

    await service.process(job.id);

    expect(accountUpdate).toHaveBeenCalledWith({
      where: { id: job.platformAccountId },
      data: { status: AccountStatus.RECONNECT_REQUIRED },
    });
    expect(jobUpdate).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: PublishJobStatus.NEEDS_ACTION,
          nextAttemptAt: null,
          lastErrorCode: null,
          lastErrorMessage: null,
        }) as unknown,
      }),
    );
  });

  it('reconciles a redelivered PUBLISHING job without calling the provider again', async () => {
    const job = {
      ...publishJobFixture(PublishJobStatus.PUBLISHING),
      attemptCount: 1,
      attempts: [{ id: 'attempt-1', status: 'STARTED', responseMetadata: null }],
    };
    const current = {
      id: job.id,
      status: PublishJobStatus.PUBLISHING,
      publishedPost: null,
      attempts: job.attempts,
    };
    const jobUpdateMany = jest.fn().mockResolvedValue({ count: 1 });
    const attemptUpdateMany = jest.fn().mockResolvedValue({ count: 1 });
    const transactionClient = {
      publishJob: { updateMany: jobUpdateMany },
      publishAttempt: { updateMany: attemptUpdateMany },
    };
    const prisma = {
      publishJob: {
        findUniqueOrThrow: jest.fn().mockResolvedValueOnce(job).mockResolvedValueOnce(current),
      },
      $transaction: jest.fn((callback: (client: typeof transactionClient) => Promise<unknown>) =>
        callback(transactionClient),
      ),
    } as unknown as PrismaService;
    const publish = jest.fn();
    const campaignStatus = {
      refresh: jest.fn().mockResolvedValue(undefined),
    } as unknown as CampaignStatusService;
    const service = new PublishingService(
      prisma,
      {
        acquireLock: jest.fn().mockResolvedValue('token'),
        extendLock: jest.fn().mockResolvedValue(true),
        releaseLock: jest.fn().mockResolvedValue(true),
      } as unknown as RedisService,
      { load: jest.fn() } as unknown as ConnectorAccountsService,
      { get: jest.fn().mockReturnValue({ publish }) } as unknown as ConnectorRegistryService,
      campaignStatus,
    );

    await service.process(job.id);

    expect(publish).not.toHaveBeenCalled();
    expect(jobUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: job.id, status: PublishJobStatus.PUBLISHING },
        data: expect.objectContaining({ status: PublishJobStatus.NEEDS_ACTION }) as unknown,
      }),
    );
    expect(attemptUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          responseMetadata: expect.objectContaining({
            reconciliationRequired: true,
            submissionUncertain: true,
          }) as unknown,
        }) as unknown,
      }),
    );
  });

  it('does not reconcile a redelivered PUBLISHING job while its heartbeat is fresh', async () => {
    const job = {
      ...publishJobFixture(PublishJobStatus.PUBLISHING),
      lockedAt: new Date(),
      attemptCount: 1,
      attempts: [{ id: 'attempt-1', status: 'STARTED', responseMetadata: null }],
    };
    const transaction = jest.fn();
    const publish = jest.fn();
    const refresh = jest.fn();
    const releaseLock = jest.fn().mockResolvedValue(true);
    const service = new PublishingService(
      {
        publishJob: { findUniqueOrThrow: jest.fn().mockResolvedValue(job) },
        $transaction: transaction,
      } as unknown as PrismaService,
      {
        acquireLock: jest.fn().mockResolvedValue('new-delivery-token'),
        extendLock: jest.fn().mockResolvedValue(true),
        releaseLock,
      } as unknown as RedisService,
      { load: jest.fn() } as unknown as ConnectorAccountsService,
      { get: jest.fn().mockReturnValue({ publish }) } as unknown as ConnectorRegistryService,
      { refresh } as unknown as CampaignStatusService,
    );

    await service.process(job.id);

    expect(publish).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
    expect(releaseLock).toHaveBeenCalledWith(
      `lock:publish:${job.id}`,
      'new-delivery-token',
    );
  });

  it('recognizes a committed result on redelivery before writing reconciliation state', async () => {
    const job = {
      ...publishJobFixture(PublishJobStatus.PUBLISHING),
      attempts: [{ id: 'attempt-1', status: 'STARTED', responseMetadata: null }],
    };
    const committed = {
      id: job.id,
      status: PublishJobStatus.PUBLISHED,
      publishedPost: { id: 'published-1' },
      attempts: [{ id: 'attempt-1', status: 'SUCCEEDED', responseMetadata: {} }],
    };
    const transaction = jest.fn();
    const prisma = {
      publishJob: {
        findUniqueOrThrow: jest.fn().mockResolvedValueOnce(job).mockResolvedValueOnce(committed),
      },
      $transaction: transaction,
    } as unknown as PrismaService;
    const publish = jest.fn();
    const service = new PublishingService(
      prisma,
      {
        acquireLock: jest.fn().mockResolvedValue('token'),
        extendLock: jest.fn().mockResolvedValue(true),
        releaseLock: jest.fn().mockResolvedValue(true),
      } as unknown as RedisService,
      { load: jest.fn() } as unknown as ConnectorAccountsService,
      { get: jest.fn().mockReturnValue({ publish }) } as unknown as ConnectorRegistryService,
      { refresh: jest.fn().mockResolvedValue(undefined) } as unknown as CampaignStatusService,
    );

    await service.process(job.id);

    expect(publish).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
  });

  it('blocks a new job when matching content is already waiting for reconciliation', async () => {
    const job = publishJobFixture();
    job.target.overrides = { allowDuplicate: false };
    const jobUpdate = jest.fn().mockResolvedValue({});
    const pendingDuplicate = jest.fn().mockResolvedValue({ id: 'prior-needs-action-job' });
    const prisma = {
      publishJob: {
        findUniqueOrThrow: jest.fn().mockResolvedValue(job),
        findFirst: pendingDuplicate,
        update: jobUpdate,
      },
      publishedPost: { findFirst: jest.fn().mockResolvedValue(null) },
    } as unknown as PrismaService;
    const publish = jest.fn();
    const campaignStatus = {
      refresh: jest.fn().mockResolvedValue(undefined),
    } as unknown as CampaignStatusService;
    const service = new PublishingService(
      prisma,
      {
        acquireLock: jest.fn().mockResolvedValue('token'),
        extendLock: jest.fn().mockResolvedValue(true),
        releaseLock: jest.fn().mockResolvedValue(true),
      } as unknown as RedisService,
      { load: jest.fn() } as unknown as ConnectorAccountsService,
      { get: jest.fn().mockReturnValue({ publish }) } as unknown as ConnectorRegistryService,
      campaignStatus,
    );

    await service.process(job.id);

    expect(pendingDuplicate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: { not: job.id },
          platformAccountId: job.platformAccountId,
          OR: expect.arrayContaining([
            {
              status: {
                in: expect.arrayContaining([
                  PublishJobStatus.PUBLISHING,
                  PublishJobStatus.PROCESSING,
                  PublishJobStatus.NEEDS_ACTION,
                ]) as unknown,
              },
            },
            {
              status: PublishJobStatus.POSSIBLE_DUPLICATE,
              lastErrorCode: 'WORKER_CRASH_UNCERTAIN_RESULT',
            },
          ]) as unknown,
        }) as unknown,
      }),
    );
    expect(JSON.stringify(pendingDuplicate.mock.calls)).not.toContain('PUBLISH_DUPLICATED');
    expect(jobUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: PublishJobStatus.POSSIBLE_DUPLICATE }) as unknown,
      }),
    );
    expect(publish).not.toHaveBeenCalled();
  });

  it('does not cross the provider boundary after the publish lease loses ownership', async () => {
    const job = publishJobFixture();
    const jobUpdate = jest.fn().mockResolvedValue({});
    const attemptUpdate = jest.fn().mockResolvedValue({});
    const transactionClient = {
      publishJob: { update: jobUpdate },
      publishAttempt: { create: jest.fn().mockResolvedValue({ id: 'attempt-1' }) },
    };
    const transaction = jest.fn(async (input: unknown) => {
      if (typeof input === 'function') {
        return (input as (client: typeof transactionClient) => Promise<unknown>)(transactionClient);
      }
      return Promise.all(input as Promise<unknown>[]);
    });
    const prisma = {
      publishJob: {
        findUniqueOrThrow: jest.fn().mockResolvedValue(job),
        update: jobUpdate,
      },
      publishAttempt: { update: attemptUpdate },
      platformAccount: { update: jest.fn().mockResolvedValue({}) },
      $transaction: transaction,
    } as unknown as PrismaService;
    const extendLock = jest.fn().mockResolvedValue(false);
    const releaseLock = jest.fn().mockResolvedValue(false);
    const publish = jest.fn();
    const connector = {
      mode: PlatformMode.OFFICIAL_API,
      capability: {
        text: true,
        image: false,
        video: false,
        article: false,
        delete: false,
        schedule: false,
        analytics: false,
      },
      validate: jest.fn().mockResolvedValue(undefined),
      publish,
    } as unknown as SocialPublisher;
    const refresh = jest.fn().mockResolvedValue(undefined);
    const service = new PublishingService(
      prisma,
      {
        acquireLock: jest.fn().mockResolvedValue('expired-owner-token'),
        extendLock,
        releaseLock,
        consumeRateLimit: jest.fn().mockResolvedValue({ allowed: true, remaining: 9 }),
      } as unknown as RedisService,
      {
        load: jest.fn().mockResolvedValue(loadedAccountFixture()),
      } as unknown as ConnectorAccountsService,
      { get: jest.fn().mockReturnValue(connector) } as unknown as ConnectorRegistryService,
      { refresh } as unknown as CampaignStatusService,
    );

    await service.process(job.id);

    expect(extendLock).toHaveBeenCalledWith(
      `lock:publish:${job.id}`,
      'expired-owner-token',
      120_000,
    );
    expect(publish).not.toHaveBeenCalled();
    expect(jobUpdate).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        id: job.id,
        status: PublishJobStatus.QUEUED,
        attemptCount: 0,
      },
      data: expect.objectContaining({ status: PublishJobStatus.PUBLISHING }) as unknown,
    }));
    expect(jobUpdate).toHaveBeenLastCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        status: PublishJobStatus.RETRY,
        lastErrorCode: ErrorCode.INFRASTRUCTURE_UNAVAILABLE,
      }) as unknown,
    }));
    expect(attemptUpdate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        errorCode: ErrorCode.INFRASTRUCTURE_UNAVAILABLE,
      }) as unknown,
    }));
    expect(refresh).toHaveBeenCalledWith(job.target.campaignId);
    expect(releaseLock).toHaveBeenCalledWith(
      `lock:publish:${job.id}`,
      'expired-owner-token',
    );
  });

  it.each([
    [
      '429',
      new ConnectorError(ErrorCode.PLATFORM_RATE_LIMITED, 'limited', true, 45),
      3,
      PublishJobStatus.RETRY,
    ],
    [
      'timeout',
      new ConnectorError(ErrorCode.PUBLISH_TIMEOUT, 'timeout', true),
      3,
      PublishJobStatus.RETRY,
    ],
    [
      'expired token',
      new ConnectorError(ErrorCode.PLATFORM_TOKEN_EXPIRED, 'expired', false),
      3,
      PublishJobStatus.FAILED,
    ],
    [
      '429 at max attempts',
      new ConnectorError(ErrorCode.PLATFORM_RATE_LIMITED, 'limited', true, 45),
      1,
      PublishJobStatus.FAILED,
    ],
  ] as const)(
    'classifies %s failures into %s',
    async (_label, failure, maxAttempts, expectedStatus) => {
      const job = {
        id: 'job-1',
        status: PublishJobStatus.QUEUED,
        publishedPost: null,
        platformAccountId: 'account-1',
        idempotencyKey: 'key',
        attemptCount: 0,
        maxAttempts,
        platformAccount: {
          id: 'account-1',
          enabled: true,
          status: AccountStatus.CONNECTED,
          settings: {},
          platform: { slug: 'x', enabled: true },
        },
        target: {
          overrides: { allowDuplicate: true },
          campaignId: 'campaign-1',
          campaign: { id: 'campaign-1' },
          contentVariant: {
            status: VariantStatus.APPROVED,
            title: null,
            body: 'hello',
            summary: null,
            hashtags: [],
            media: [],
            content: { canonicalUrl: null, contentHash: 'hash', media: [] },
          },
        },
      };
      const jobUpdate = jest.fn().mockResolvedValue({});
      const attemptUpdate = jest.fn().mockResolvedValue({});
      const accountUpdate = jest.fn().mockResolvedValue({});
      const transaction = jest.fn().mockImplementation(async (input: unknown) => {
        if (typeof input === 'function') {
          return (input as (client: unknown) => Promise<unknown>)({
            publishJob: { update: jobUpdate },
            publishAttempt: { create: jest.fn().mockResolvedValue({ id: 'attempt-1' }) },
          });
        }
        return Promise.all(input as Promise<unknown>[]);
      });
      const prisma = {
        publishJob: {
          findUniqueOrThrow: jest.fn().mockResolvedValue(job),
          update: jobUpdate,
          findMany: jest.fn().mockResolvedValue([]),
        },
        publishAttempt: { update: attemptUpdate },
        platformAccount: { update: accountUpdate },
        $transaction: transaction,
      } as unknown as PrismaService;
      const redis = {
        acquireLock: jest.fn().mockResolvedValue('token'),
        extendLock: jest.fn().mockResolvedValue(true),
        releaseLock: jest.fn().mockResolvedValue(true),
        consumeRateLimit: jest.fn().mockResolvedValue({ allowed: true, remaining: 9 }),
      } as unknown as RedisService;
      const connectorAccounts = {
        load: jest
          .fn()
          .mockResolvedValue(loadedAccountFixture()),
      } as unknown as ConnectorAccountsService;
      const connector = {
        validate: jest.fn().mockResolvedValue(undefined),
        publish: jest.fn().mockRejectedValue(failure),
      } as unknown as SocialPublisher;
      const registry = {
        get: jest.fn().mockReturnValue(connector),
      } as unknown as ConnectorRegistryService;
      const processing = new PublishingService(
        prisma,
        redis,
        connectorAccounts,
        registry,
        new CampaignStatusService(prisma),
      ).process('job-1');
      if (expectedStatus === PublishJobStatus.FAILED) {
        await expect(processing).rejects.toBeInstanceOf(DeadLetterDeliveryError);
      } else {
        await expect(processing).resolves.toBeUndefined();
      }
      expect(JSON.stringify(jobUpdate.mock.calls)).toContain(`"status":"${expectedStatus}"`);
      expect(JSON.stringify(attemptUpdate.mock.calls)).toContain(failure.code);
      if (failure.code === ErrorCode.PLATFORM_TOKEN_EXPIRED)
        expect(accountUpdate).toHaveBeenCalledTimes(1);
    },
  );
});
