import { HttpStatus } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApplicationException, ErrorCode } from '../common/exceptions/application.exception';
import { PrismaService } from '../database/prisma.service';
import { AiProvider } from './ai-provider';
import { failedPlatformOf, AiContentService, contractInstructions, extractJsonObject } from './ai-content.service';
import { approvalHash, approvalJsonSchema, ApprovalSchema } from './content-approval';
import { scoreFromReason } from './content-quality';
import { platformContract } from '../platforms/platform-contract';
import { checkPostLength } from '../platforms/post-length';
import { BrandProfileService } from './brand-profile.service';
import { GeminiKeyPoolService } from './gemini-key-pool.service';

type ConfigValue = string | number | undefined;

const BASE_TEST_CONFIG: Record<string, ConfigValue> = {
  AI_DEFAULT_PROVIDER: 'openai',
  AI_TIMEOUT_MS: 60_000,
  OPENAI_TIMEOUT_MS: 60_000,
  OPENAI_API_KEY: '',
  DEEPSEEK_API_KEY: '',
  GEMINI_API_KEY: '',
  OPENAI_MODEL: 'openai-test-model',
  DEEPSEEK_MODEL: 'deepseek-test-model',
  GEMINI_MODEL: 'gemini-test-model',
  GEMINI_FALLBACK_MODEL: 'gemini-fallback-test-model',
};

/**
 * A deliberately minimal ConfigService double. Unlike the real ConfigService,
 * it cannot fall through to process.env or values loaded from a local .env.
 */
function isolatedConfig(overrides: Record<string, ConfigValue> = {}): ConfigService {
  const values = { ...BASE_TEST_CONFIG, ...overrides };
  return {
    get: jest.fn((key: string, defaultValue?: unknown) => (
      Object.prototype.hasOwnProperty.call(values, key) ? values[key] : defaultValue
    )),
  } as unknown as ConfigService;
}

function installClient(service: AiContentService, provider: AiProvider, client: unknown): void {
  const target = service as unknown as { clients: Partial<Record<AiProvider, unknown>> };
  target.clients[provider] = client;
  if (provider === 'gemini') (service as unknown as { createGeminiClient: () => unknown }).createGeminiClient = () => client;
}

function createService(prisma: PrismaService, config: ConfigService): AiContentService {
  const service = new AiContentService(prisma, config, {
    configured: () => Promise.resolve(Boolean(config.get<string>('GEMINI_API_KEY') || (service as unknown as { clients: Record<string, unknown> }).clients.gemini)),
    run: <T>(request: (key: string) => Promise<T>) => request('unit-test-gemini-key'),
  } as unknown as GeminiKeyPoolService);
  return service;
}

function skipGeminiRetryDelay(service: AiContentService): jest.Mock<Promise<void>, [number]> {
  const delay = jest.fn<Promise<void>, [number]>().mockResolvedValue(undefined);
  const target = service as unknown as { delay: (milliseconds: number) => Promise<void> };
  target.delay = delay;
  return delay;
}

function callModel(
  service: AiContentService,
  provider: AiProvider,
  platform: string,
  systemPrompt: string,
  userTemplate: string,
  content: { title: string; body: string; summary: string | null; canonicalUrl: string | null },
): Promise<unknown> {
  const target = service as unknown as {
    callModel(
      selectedProvider: AiProvider,
      selectedPlatform: string,
      system: string,
      template: string,
      source: { title: string; body: string; summary: string | null; canonicalUrl: string | null },
    ): Promise<unknown>;
  };
  return target.callModel(provider, platform, systemPrompt, userTemplate, content);
}

async function captureApplicationError(promise: Promise<unknown>): Promise<ApplicationException> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ApplicationException) return error;
    throw error;
  }
  throw new Error('Expected an ApplicationException');
}

describe('AiContentService structured parsing and provider routing', () => {
  let fetchSpy: jest.SpiedFunction<typeof globalThis.fetch>;

  beforeEach(() => {
    fetchSpy = jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Network is disabled in AI unit tests'));
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('accepts schema-compliant model output', () => {
    const service = createService({} as PrismaService, isolatedConfig());
    const result = service.parseOutput(JSON.stringify({
      platform: 'linkedin',
      title: 'A title',
      body: 'A useful body',
      summary: null,
      hashtags: ['nestjs'],
      cta: 'Discuss below',
      recommended: true,
      reason: 'Relevant audience',
      media: { type: 'image', altText: 'Architecture diagram' },
    }));
    expect(result.platform).toBe('linkedin');
    expect(result.recommended).toBe(true);
  });

  it('rejects invalid JSON and invalid schema output', () => {
    const service = createService({} as PrismaService, isolatedConfig());
    expect(() => service.parseOutput('{bad')).toThrow('AI returned invalid JSON');
    expect(() => service.parseOutput(JSON.stringify({ platform: 'x' }))).toThrow('required schema');
  });

  it('reports only safe provider metadata and honors the configured default', async () => {
    const service = createService(
      {} as PrismaService,
      isolatedConfig({ AI_DEFAULT_PROVIDER: 'deepseek' }),
    );
    installClient(service, 'deepseek', { chat: { completions: {} } });

    expect(await service.providers()).toEqual([
      {
        id: 'openai', label: 'OpenAI', model: 'openai-test-model', configured: false, isDefault: false,
      },
      {
        id: 'deepseek', label: 'DeepSeek', model: 'deepseek-test-model', configured: true, isDefault: true,
      },
      {
        id: 'gemini', label: 'Google Gemini', model: 'gemini-test-model', configured: false, isDefault: false,
      },
      {
        id: 'vpsttt', label: 'VPSTTT AI', model: 'claude:sonnet', configured: false, isDefault: false,
      },
    ]);
    expect(service.resolveProvider()).toBe('deepseek');
    expect(Object.keys((await service.providers())[0] ?? {})).not.toContain('apiKey');
  });

  it('uses the stable Gemini default model when no model override is configured', async () => {
    const service = createService(
      {} as PrismaService,
      isolatedConfig({ GEMINI_MODEL: '' }),
    );

    expect(await service.providers()).toContainEqual(expect.objectContaining({
      id: 'gemini',
      model: 'gemini-3.5-flash',
    }));
  });

  it('fails readiness before querying platforms when the selected provider is missing', async () => {
    const findMany = jest.fn();
    const unconfigured = createService(
      { platform: { findMany } } as unknown as PrismaService,
      isolatedConfig(),
    );

    await expect(unconfigured.assertReady(['devto'], 'gemini')).rejects.toThrow('GEMINI_API_KEY is not configured');
    expect(findMany).not.toHaveBeenCalled();
  });

  it('fails readiness when a selected platform has no active prompt', async () => {
    const configured = createService(
      {
        platform: {
          findMany: jest.fn().mockResolvedValue([{ slug: 'devto', prompts: [] }]),
        },
      } as unknown as PrismaService,
      isolatedConfig(),
    );
    installClient(configured, 'openai', {});

    await expect(configured.assertReady(['devto'], 'openai')).rejects.toThrow('No active AI prompt for: devto');
  });

  it('uses strict OpenAI Responses Structured Outputs without server-side response storage', async () => {
    type Request = { model?: string; store?: boolean; text?: { format?: { type?: string; strict?: boolean } } };
    const output = JSON.stringify({
      platform: 'x', title: null, body: 'Hello', summary: null, hashtags: [], cta: null,
      recommended: true, reason: 'Concise', media: { type: 'none', altText: '' },
    });
    const create = jest.fn<Promise<{ output_text: string }>, [Request]>().mockResolvedValue({ output_text: output });
    const configured = createService({} as PrismaService, isolatedConfig());
    installClient(configured, 'openai', { responses: { create } });

    await callModel(configured, 'openai', 'x', 'Ground all claims.', '{{body}}', {
      title: 'Title', body: 'Source', summary: null, canonicalUrl: null,
    });

    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      model: 'openai-test-model',
      store: false,
      text: { format: expect.objectContaining({ type: 'json_schema', strict: true }) as unknown },
    }));
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('uses DeepSeek chat JSON mode and validates its JSON response locally', async () => {
    const output = JSON.stringify({
      platform: 'devto', title: 'DeepSeek title', body: 'DeepSeek body', summary: null,
      hashtags: ['ai'], cta: null, recommended: true, reason: 'Relevant',
      media: { type: 'none', altText: '' },
    });
    const create = jest.fn().mockResolvedValue({ choices: [{ message: { content: output } }] });
    const configured = createService({} as PrismaService, isolatedConfig());
    installClient(configured, 'deepseek', { chat: { completions: { create } } });

    const result = await callModel(configured, 'deepseek', 'devto', 'Stay grounded.', '{{body}}', {
      title: 'Title', body: 'Source', summary: null, canonicalUrl: null,
    });

    expect(result).toMatchObject({ platform: 'devto', body: 'DeepSeek body' });
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      model: 'deepseek-test-model',
      response_format: { type: 'json_object' },
      messages: expect.arrayContaining([
        expect.objectContaining({
          role: 'system',
          content: expect.stringContaining('JSON Schema') as unknown,
        }),
      ]) as unknown,
    }));
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('uses Gemini chat parsing and validates the parsed structured response', async () => {
    const parsed = {
      platform: 'linkedin', title: 'Gemini title', body: 'Gemini body', summary: null,
      hashtags: [], cta: 'Read more', recommended: true, reason: 'Relevant',
      media: { type: 'image', altText: 'Diagram' },
    };
    const parse = jest.fn().mockResolvedValue({ choices: [{ message: { parsed, content: null } }] });
    const configured = createService({} as PrismaService, isolatedConfig());
    installClient(configured, 'gemini', { chat: { completions: { parse } } });

    const result = await callModel(configured, 'gemini', 'linkedin', 'Stay grounded.', '{{body}}', {
      title: 'Title', body: 'Source', summary: null, canonicalUrl: null,
    });

    expect(result).toMatchObject({ platform: 'linkedin', body: 'Gemini body' });
    expect(parse).toHaveBeenCalledWith(expect.objectContaining({
      model: 'gemini-test-model',
      response_format: expect.objectContaining({ type: 'json_schema' }) as unknown,
    }));
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('retries a transient Gemini primary-model failure before falling back', async () => {
    const parsed = {
      platform: 'devto', title: 'Recovered', body: 'Gemini body', summary: null,
      hashtags: [], cta: null, recommended: true, reason: 'Relevant',
      media: { type: 'none', altText: '' },
    };
    const parse = jest.fn()
      .mockRejectedValueOnce({ status: 503, message: 'raw-upstream-body' })
      .mockResolvedValueOnce({ choices: [{ message: { parsed, content: null } }] });
    const configured = createService({} as PrismaService, isolatedConfig());
    const delay = skipGeminiRetryDelay(configured);
    installClient(configured, 'gemini', { chat: { completions: { parse } } });

    const result = await callModel(configured, 'gemini', 'devto', 'Stay grounded.', '{{body}}', {
      title: 'Title', body: 'Source', summary: null, canonicalUrl: null,
    });

    expect(result).toMatchObject({ platform: 'devto', title: 'Recovered' });
    expect(parse).toHaveBeenNthCalledWith(1, expect.objectContaining({ model: 'gemini-test-model' }));
    expect(parse).toHaveBeenNthCalledWith(2, expect.objectContaining({ model: 'gemini-test-model' }));
    expect(delay).toHaveBeenCalledWith(750);
  });

  it('uses the configured Gemini fallback after retryable primary-model failures', async () => {
    const parsed = {
      platform: 'devto', title: 'Fallback', body: 'Fallback body', summary: null,
      hashtags: [], cta: null, recommended: true, reason: 'Relevant',
      media: { type: 'none', altText: '' },
    };
    const parse = jest.fn()
      .mockRejectedValueOnce({ status: 503, message: 'raw-primary-limit' })
      .mockRejectedValueOnce({ status: 503, message: 'raw-primary-outage' })
      .mockResolvedValueOnce({ choices: [{ message: { parsed, content: null } }] });
    const configured = createService({} as PrismaService, isolatedConfig());
    const delay = skipGeminiRetryDelay(configured);
    installClient(configured, 'gemini', { chat: { completions: { parse } } });

    const result = await callModel(configured, 'gemini', 'devto', 'Stay grounded.', '{{body}}', {
      title: 'Title', body: 'Source', summary: null, canonicalUrl: null,
    });

    expect(result).toMatchObject({ platform: 'devto', title: 'Fallback' });
    expect(parse).toHaveBeenNthCalledWith(1, expect.objectContaining({ model: 'gemini-test-model' }));
    expect(parse).toHaveBeenNthCalledWith(2, expect.objectContaining({ model: 'gemini-test-model' }));
    expect(parse).toHaveBeenNthCalledWith(3, expect.objectContaining({ model: 'gemini-fallback-test-model' }));
    expect(delay).toHaveBeenCalledTimes(1);
  });

  it('maps DeepSeek insufficient balance errors without exposing the upstream response', async () => {
    const rawUpstreamDetail = 'raw-upstream-secret-and-account-id';
    const create = jest.fn().mockRejectedValue({
      status: 402,
      message: rawUpstreamDetail,
      error: { message: rawUpstreamDetail, account: rawUpstreamDetail },
    });
    const configured = createService({} as PrismaService, isolatedConfig());
    installClient(configured, 'deepseek', { chat: { completions: { create } } });

    const error = await captureApplicationError(callModel(
      configured,
      'deepseek',
      'devto',
      'Stay grounded.',
      '{{body}}',
      { title: 'Title', body: 'Source', summary: null, canonicalUrl: null },
    ));

    expect(error.code).toBe(ErrorCode.INFRASTRUCTURE_UNAVAILABLE);
    expect(error.getStatus()).toBe(HttpStatus.SERVICE_UNAVAILABLE);
    expect(error.getResponse()).toMatchObject({
      message: 'DeepSeek account has insufficient balance or quota',
    });
    expect(JSON.stringify(error.getResponse())).not.toContain(rawUpstreamDetail);
    expect(error.details).toBeUndefined();
  });

  it('maps Gemini rate limits without exposing the upstream response', async () => {
    const rawUpstreamDetail = 'raw-provider-limit-body';
    const parse = jest.fn().mockRejectedValue({
      status: 429,
      message: rawUpstreamDetail,
      error: { message: rawUpstreamDetail },
    });
    const configured = createService({} as PrismaService, isolatedConfig());
    skipGeminiRetryDelay(configured);
    installClient(configured, 'gemini', { chat: { completions: { parse } } });

    const error = await captureApplicationError(callModel(
      configured,
      'gemini',
      'linkedin',
      'Stay grounded.',
      '{{body}}',
      { title: 'Title', body: 'Source', summary: null, canonicalUrl: null },
    ));

    expect(error.code).toBe(ErrorCode.PLATFORM_RATE_LIMITED);
    expect(error.getStatus()).toBe(HttpStatus.TOO_MANY_REQUESTS);
    expect(error.getResponse()).toMatchObject({
      message: 'Google Gemini rate limit was reached. Try again later',
    });
    expect(JSON.stringify(error.getResponse())).not.toContain(rawUpstreamDetail);
    expect(error.details).toBeUndefined();
  });

  it.each([401, 403])(
    'maps upstream credential status %i to a non-401 safe API error',
    async (status) => {
      const rawUpstreamDetail = 'raw-credential-and-key-detail';
      const create = jest.fn().mockRejectedValue({
        status,
        message: rawUpstreamDetail,
        error: { message: rawUpstreamDetail },
      });
      const configured = createService({} as PrismaService, isolatedConfig());
      installClient(configured, 'openai', { responses: { create } });

      const error = await captureApplicationError(callModel(
        configured,
        'openai',
        'x',
        'Stay grounded.',
        '{{body}}',
        { title: 'Title', body: 'Source', summary: null, canonicalUrl: null },
      ));

      expect(error.code).toBe(ErrorCode.PLATFORM_AUTH_FAILED);
      expect(error.getStatus()).toBe(HttpStatus.BAD_GATEWAY);
      expect(error.getStatus()).not.toBe(HttpStatus.UNAUTHORIZED);
      expect(error.getResponse()).toMatchObject({
        message: 'OpenAI rejected the configured API credentials',
      });
      expect(JSON.stringify(error.getResponse())).not.toContain(rawUpstreamDetail);
    },
  );

  it.each([
    {
      providerError: { name: 'APIConnectionTimeoutError', message: 'raw-timeout-body' },
      expectedStatus: HttpStatus.GATEWAY_TIMEOUT,
      expectedMessage: 'OpenAI request timed out. Try again later',
    },
    {
      providerError: { status: 503, message: 'raw-service-body' },
      expectedStatus: HttpStatus.SERVICE_UNAVAILABLE,
      expectedMessage: 'OpenAI is temporarily unavailable',
    },
  ])('maps timeout and 5xx failures safely', async ({ providerError, expectedStatus, expectedMessage }) => {
    const create = jest.fn().mockRejectedValue(providerError);
    const configured = createService({} as PrismaService, isolatedConfig());
    installClient(configured, 'openai', { responses: { create } });

    const error = await captureApplicationError(callModel(
      configured,
      'openai',
      'x',
      'Stay grounded.',
      '{{body}}',
      { title: 'Title', body: 'Source', summary: null, canonicalUrl: null },
    ));

    expect(error.code).toBe(ErrorCode.INFRASTRUCTURE_UNAVAILABLE);
    expect(error.getStatus()).toBe(expectedStatus);
    expect(error.getResponse()).toMatchObject({ message: expectedMessage });
    expect(JSON.stringify(error.getResponse())).not.toContain(providerError.message);
  });

  it('restores the previous content status when generation fails', async () => {
    const updateMany = jest.fn().mockResolvedValue({ count: 1 });
    const prisma = {
      content: {
        findFirstOrThrow: jest.fn().mockResolvedValue({
          id: 'content-1', title: 'Title', body: 'Body', summary: null, canonicalUrl: null, status: 'APPROVED',
        }),
        updateMany,
      },
      platform: {
        findMany: jest.fn().mockResolvedValue([{
          id: 'platform-1', slug: 'x', prompts: [{ systemPrompt: 'System', userTemplate: '{{body}}' }],
        }]),
      },
      contentVariant: {
        aggregate: jest.fn(),
        create: jest.fn(),
      },
    };
    const configured = createService(prisma as unknown as PrismaService, isolatedConfig());
    const create = jest.fn().mockRejectedValue(new Error('provider down'));
    installClient(configured, 'openai', { responses: { create } });

    await expect(configured.generate('owner-1', 'content-1', ['x'], 'openai'))
      .rejects.toThrow('OpenAI request failed');
    expect(updateMany).toHaveBeenNthCalledWith(1, {
      where: { id: 'content-1', ownerId: 'owner-1', status: 'APPROVED' },
      data: { status: 'AI_GENERATING' },
    });
    expect(updateMany).toHaveBeenNthCalledWith(2, {
      where: { id: 'content-1', ownerId: 'owner-1', status: 'AI_GENERATING' },
      data: { status: 'APPROVED' },
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('does not persist partial variants when one platform generation fails', async () => {
    const transaction = jest.fn();
    const updateMany = jest.fn().mockResolvedValue({ count: 1 });
    const prisma = {
      content: {
        findFirstOrThrow: jest.fn().mockResolvedValue({
          id: 'content-1', title: 'Title', body: 'Body', summary: null, canonicalUrl: null, status: 'DRAFT',
        }),
        updateMany,
      },
      platform: {
        findMany: jest.fn().mockResolvedValue([
          { id: 'platform-1', slug: 'x', prompts: [{ systemPrompt: 'System', userTemplate: '{{body}}' }] },
          { id: 'platform-2', slug: 'devto', prompts: [{ systemPrompt: 'System', userTemplate: '{{body}}' }] },
        ]),
      },
      $transaction: transaction,
    };
    const configured = createService(prisma as unknown as PrismaService, isolatedConfig());
    const valid = JSON.stringify({
      platform: 'x', title: null, body: 'Hello', summary: null, hashtags: [], cta: null,
      recommended: true, reason: 'Concise', media: { type: 'none', altText: '' },
    });
    const create = jest.fn()
      .mockResolvedValueOnce({ output_text: valid })
      .mockRejectedValueOnce(new Error('second platform failed'));
    installClient(configured, 'openai', { responses: { create } });

    await expect(configured.generate('owner-1', 'content-1', ['x', 'devto'], 'openai'))
      .rejects.toThrow('OpenAI request failed');
    expect(transaction).not.toHaveBeenCalled();
    expect(updateMany).toHaveBeenLastCalledWith({
      where: { id: 'content-1', ownerId: 'owner-1', status: 'AI_GENERATING' },
      data: { status: 'DRAFT' },
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('saves each platform as soon as it is generated and keeps the finished ones when another fails', async () => {
    const updateMany = jest.fn().mockResolvedValue({ count: 1 });
    const transaction = jest.fn();
    const prisma = {
      content: {
        findFirstOrThrow: jest.fn().mockResolvedValue({
          id: 'content-1', title: 'Title', body: 'Body', summary: null, canonicalUrl: null, status: 'DRAFT',
        }),
        updateMany,
      },
      platform: {
        findMany: jest.fn().mockResolvedValue([
          { id: 'platform-1', slug: 'x', prompts: [{ systemPrompt: 'System', userTemplate: '{{body}}' }] },
          { id: 'platform-2', slug: 'devto', prompts: [{ systemPrompt: 'System', userTemplate: '{{body}}' }] },
        ]),
      },
      contentVariant: {
        aggregate: jest.fn().mockResolvedValue({ _max: { version: null } }),
        create: jest.fn(({ data }: { data: { platformId: string } }) => Promise.resolve({ id: `variant-${data.platformId}`, ...data })),
      },
      $transaction: transaction,
    };
    const configured = createService(prisma as unknown as PrismaService, isolatedConfig());
    const valid = JSON.stringify({
      platform: 'x', title: null, body: 'Hello', summary: null, hashtags: [], cta: null,
      recommended: true, reason: 'Concise', media: { type: 'none', altText: '' },
    });
    const create = jest.fn()
      .mockResolvedValueOnce({ output_text: valid })
      .mockRejectedValueOnce(new Error('second platform failed'));
    installClient(configured, 'openai', { responses: { create } });
    const seen: string[] = [];

    await expect(configured.generate('owner-1', 'content-1', ['x', 'devto'], 'openai', undefined, undefined, (variant) => { seen.push(variant.id); return Promise.resolve(); }))
      .rejects.toThrow('OpenAI request failed');
    expect(seen).toEqual(['variant-platform-1']);
    expect(prisma.contentVariant.create).toHaveBeenCalledTimes(1);
    expect(transaction).not.toHaveBeenCalled();
    expect(updateMany).toHaveBeenLastCalledWith({
      where: { id: 'content-1', ownerId: 'owner-1', status: 'AI_GENERATING' },
      data: { status: 'DRAFT' },
    });
  });

  it('does not call the model when another request wins the atomic generation claim', async () => {
    const transaction = jest.fn();
    const prisma = {
      content: {
        findFirstOrThrow: jest.fn().mockResolvedValue({
          id: 'content-1', title: 'Title', body: 'Body', summary: null, canonicalUrl: null, status: 'DRAFT',
        }),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      platform: {
        findMany: jest.fn().mockResolvedValue([{
          id: 'platform-1', slug: 'devto', prompts: [{ systemPrompt: 'System', userTemplate: '{{body}}' }],
        }]),
      },
      $transaction: transaction,
    };
    const configured = createService(prisma as unknown as PrismaService, isolatedConfig());
    const create = jest.fn();
    installClient(configured, 'openai', { responses: { create } });

    await expect(configured.generate('owner-1', 'content-1', ['devto'], 'openai'))
      .rejects.toThrow('Content changed while generation was starting');
    expect(create).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('AiContentService quality-checked generation', () => {
  const brief = 'Giới thiệu dịch vụ VPS NVMe cho lập trình viên Việt Nam, nhấn mạnh tốc độ triển khai và hỗ trợ kỹ thuật tiếng Việt.';
  const shortBody = 'Triển khai VPS NVMe trong 60 giây, có người hỗ trợ bằng tiếng Việt khi bạn cần. Bạn đang chạy dự án trên đâu? #vps';
  const passingReview = {
    score: 8, hook: 8, specificity: 7, platformFit: 8, naturalness: 8, languageOk: true, unsupportedClaims: [], issues: [],
  };
  const variant = (body: string, extra: Record<string, unknown> = {}) => ({
    output_text: JSON.stringify({
      platform: 'bluesky', title: null, body, summary: null, hashtags: ['vps'], cta: null,
      recommended: true, reason: 'Hợp người đọc', media: { type: 'none', altText: '' }, ...extra,
    }),
  });
  const reviewed = (review: Record<string, unknown> = passingReview) => ({ output_text: JSON.stringify(review) });
  /** A VPSTTT AI chat reply (the reviewer and the approver run there by default). */
  const chat = (value: Record<string, unknown>) => ({ choices: [{ message: { content: JSON.stringify(value) } }] });
  const verdict = (extra: Record<string, unknown> = {}) => chat({ approved: true, score: 9, risk: 'none', seeding: false, reasons: [], ...extra });

  /**
   * The writer (and, unless `config` says otherwise, the reviewer) answer on
   * the OpenAI mock `create`; the final approver (default vpsttt:claude:opus)
   * answers on `approve`, which approves unless a test says otherwise. With
   * `approve: null` VPSTTT AI has no key.
   */
  interface SetupOptions { slug?: string; canonicalUrl?: string | null; approve?: jest.Mock | null; config?: Record<string, ConfigValue> }
  function setup(create: jest.Mock, { slug = 'bluesky', canonicalUrl = null, approve = jest.fn().mockResolvedValue(verdict()), config = {} }: SetupOptions = {}) {
    const created: Array<Record<string, unknown>> = [];
    const transaction = {
      contentVariant: {
        aggregate: jest.fn().mockResolvedValue({ _max: { version: null } }),
        create: jest.fn(({ data }: { data: Record<string, unknown> }) => {
          created.push(data);
          return Promise.resolve({ id: `variant-${created.length}`, ...data });
        }),
      },
      content: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    };
    const prisma = {
      content: {
        findFirstOrThrow: jest.fn().mockResolvedValue({
          id: 'content-1', title: 'Chiến dịch nội bộ T11', body: brief, summary: brief, canonicalUrl,
          status: 'DRAFT', aiAnalysis: { kind: 'brief' },
        }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      platform: {
        findMany: jest.fn().mockResolvedValue([{
          id: 'platform-1', slug,
          prompts: [{ systemPrompt: 'System', userTemplate: 'Title or brief: {{title}}\nSummary: {{summary}}\n{{body}}' }],
        }]),
        findFirst: jest.fn().mockResolvedValue({
          id: 'platform-1', slug,
          prompts: [{ systemPrompt: 'System', userTemplate: 'Title or brief: {{title}}\nSummary: {{summary}}\n{{body}}' }],
        }),
      },
      campaign: {
        findMany: jest.fn().mockResolvedValue([{
          name: 'Giới thiệu proxy',
          content: { body: 'Giới thiệu proxy, VPS của vpsttt qua chia sẻ kiến thức', variants: [
            { reason: 'Cần xem lại (AI chấm 6/10): Mở bài chung chung', platform: { name: 'Bluesky' } },
            { reason: 'Hợp người đọc (AI chấm 8/10)', platform: { name: 'NGINX Community' } },
          ] },
          targets: [{ publishJobs: [{ publishedPost: { id: 'p1' } }, { publishedPost: null }] }],
        }]),
      },
      $transaction: jest.fn((callback: (client: typeof transaction) => Promise<unknown>) => callback(transaction)),
    };
    // The reviewer and the reviser are pinned to the writer's provider here so each
    // test lists write and review answers in order; the role tests below use the defaults.
    const settings = isolatedConfig({ AI_REVIEWER: 'openai', AI_REVISER: 'openai', VPSTTT_AI_RPM: 60_000, ...config });
    const brand = { load: () => Promise.resolve({ brandName: 'VPSTTT', facts: ['VPS NVMe triển khai trong 60 giây'] }) };
    const service = new AiContentService(
      prisma as unknown as PrismaService,
      settings,
      { configured: () => Promise.resolve(false), run: jest.fn() } as unknown as GeminiKeyPoolService,
      brand as unknown as BrandProfileService,
    );
    installClient(service, 'openai', { responses: { create } });
    if (approve) installClient(service, 'vpsttt', { chat: { completions: { create: approve } } });
    const delay = skipGeminiRetryDelay(service);
    return { service, created, delay, approve, prisma };
  }

  type Request = { instructions: string; input: string; text: { format: { name: string } } };
  const request = (create: jest.Mock, index: number) => (create.mock.calls[index] as [Request])[0];

  it('sends the destination contract and brand facts, hides the campaign name, and stores a passing draft', async () => {
    const create = jest.fn().mockResolvedValueOnce(variant(shortBody)).mockResolvedValueOnce(reviewed());
    const { service, created } = setup(create);

    await service.generate('owner-1', 'content-1', ['bluesky'], 'openai');

    const writer = request(create, 0);
    expect(writer.instructions).toContain('Destination contract for Bluesky');
    expect(writer.instructions).toContain('at most 300 characters');
    expect(writer.instructions).toContain('Write every field in Vietnamese');
    // The writer aims at the editor's rubric from the first draft.
    expect(writer.instructions).toContain('Quality bar: an editor scores this Bluesky draft');
    expect(writer.input).toContain('<brand_facts>');
    expect(writer.input).toContain('Input type: a short marketing brief');
    expect(writer.input).not.toContain('Chiến dịch nội bộ T11');
    expect(request(create, 1).text.format.name).toBe('content_review');
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ body: shortBody, recommended: true, reason: 'Hợp người đọc (AI chấm 8/10)', hashtags: ['vps'] });
  });

  const artBrief = {
    subject: 'a sleek NVMe server node with glowing cyan drive bays, three identical VPS instances spinning up from it',
    scene: 'a dark, minimal data-centre aisle fading into depth',
    composition: 'three-quarter isometric hero view, server centred with safe margins, empty space on the right',
    lighting: 'cool rim light with soft cyan glow from the drive bays',
    palette: 'deep navy, indigo, cyan, violet accents',
    style: 'Premium 3D render.',
    mood: 'fast, reliable, calm',
    details: ['light trails from the server to three instance cubes', 'a stopwatch-like ring of light suggesting 60-second setup'],
    avoid: ['coffee cups', 'cartoon servers'],
    altText: 'Máy chủ NVMe phát sáng tạo ba máy ảo cùng lúc trong phòng dữ liệu tối.',
  };
  const artDirected = (brief: Record<string, unknown> = artBrief) => ({ output_text: JSON.stringify(brief) });

  it('asks for an image description only where the post carries an image, and stores the image request', async () => {
    const create = jest.fn()
      .mockResolvedValueOnce(variant(shortBody, { media: { type: 'none', altText: 'Máy chủ VPS trong phòng dữ liệu', prompt: 'A bright NVMe server rack, soft blue light' } }))
      .mockResolvedValueOnce(reviewed())
      .mockRejectedValueOnce(Object.assign(new Error('bad request'), { status: 400 }));
    const { service, created } = setup(create);
    const plan = new Map([['bluesky', { need: 'optional' as const, size: '1536x1024' as const, style: 'a simple editorial illustration' }]]);

    await service.generate('owner-1', 'content-1', ['bluesky'], 'openai', undefined, plan);

    expect(request(create, 0).instructions).toContain('Image (mandatory): one image generated from your description is attached to this Bluesky post.');
    expect(request(create, 0).instructions).toContain('landscape 3:2');
    // The picture shows what is promoted, in a technology look, not a generic cosy scene.
    expect(request(create, 0).instructions).toContain('depict the product or service the brief promotes');
    expect(request(create, 0).instructions).toContain('Look: modern technology');
    expect(request(create, 0).instructions).toContain('60 to 150 words, written like a brief to a designer');
    expect(request(create, 0).instructions).toMatch(/Do not use lifestyle props \(coffee cups, plants/);
    // The art director failed here, so the writer's own description is kept;
    // the image itself is still to be created, so the post is not ready yet.
    expect(created[0]!.mediaRecommendation).toEqual({ type: 'image', altText: 'Máy chủ VPS trong phòng dữ liệu', prompt: 'A bright NVMe server rack, soft blue light', status: 'pending' });
  });

  it('has an art director design the image from the finished post and stores the assembled prompt', async () => {
    const create = jest.fn()
      .mockResolvedValueOnce(variant(shortBody, { media: { type: 'image', altText: 'Ảnh', prompt: 'A server rack' } }))
      .mockResolvedValueOnce(reviewed())
      .mockResolvedValueOnce(artDirected());
    const { service, created } = setup(create);
    const plan = new Map([['bluesky', { need: 'optional' as const, size: '1536x1024' as const, style: 'a simple editorial technology illustration' }]]);

    await service.generate('owner-1', 'content-1', ['bluesky'], 'openai', undefined, plan);

    expect(create).toHaveBeenCalledTimes(3);
    const director = request(create, 2);
    expect(director.instructions).toContain('art director');
    expect(director.instructions).toContain('landscape 3:2');
    expect(director.instructions).toContain('No clichés');
    expect(director.text.format.name).toBe('image_brief');
    expect(director.input).toContain(shortBody);
    expect(director.input).toContain("The writer's first idea for the image (improve on it, keep what fits):\nA server rack");
    expect(director.input).toContain('<brand_facts>');
    const media = created[0]!.mediaRecommendation as { type: string; prompt: string; altText: string };
    expect(media.type).toBe('image');
    expect(media.altText).toBe(artBrief.altText);
    expect(media.prompt.split('\n')).toEqual([
      'Premium 3D render for a Bluesky post, landscape 3:2 frame.',
      `Subject: ${artBrief.subject}.`,
      `Scene: ${artBrief.scene}.`,
      `Composition: ${artBrief.composition}.`,
      `Lighting: ${artBrief.lighting}.`,
      `Colour palette: ${artBrief.palette}.`,
      `Mood: ${artBrief.mood}.`,
      `Details: ${artBrief.details.join('; ')}.`,
      'Avoid: coffee cups, cartoon servers, any text, letters, numbers, logos or watermarks.',
    ]);
  });

  it('does not ask the art director when the destination carries no image', async () => {
    const create = jest.fn().mockResolvedValueOnce(variant(shortBody)).mockResolvedValueOnce(reviewed());
    const { service } = setup(create);
    await service.generate('owner-1', 'content-1', ['bluesky'], 'openai');
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('tells a text-only destination not to mention an image and drops any image request', async () => {
    const create = jest.fn()
      .mockResolvedValueOnce(variant(shortBody, { media: { type: 'image', altText: 'Ảnh', prompt: 'A picture' } }))
      .mockResolvedValueOnce(reviewed());
    const { service, created } = setup(create);

    await service.generate('owner-1', 'content-1', ['bluesky'], 'openai');

    expect(request(create, 0).instructions).toContain('no image is attached to this Bluesky post');
    expect(created[0]!.mediaRecommendation).toEqual({ type: 'none', altText: '', prompt: null });
  });

  it('stores clean paragraphs for plain-text destinations so API routes never post Markdown', async () => {
    const create = jest.fn()
      .mockResolvedValueOnce(variant('**Triển khai VPS NVMe trong 60 giây.** Có người hỗ trợ bằng tiếng Việt khi bạn cần, kể cả cuối tuần. #vps'))
      .mockResolvedValueOnce(reviewed());
    const { service, created } = setup(create);

    await service.generate('owner-1', 'content-1', ['bluesky'], 'openai');

    expect(created[0]!.body).toBe('Triển khai VPS NVMe trong 60 giây. Có người hỗ trợ bằng tiếng Việt khi bạn cần, kể cả cuối tuần. #vps');
    expect(request(create, 1).input).not.toContain('**');
  });

  it('rewrites up to twice with the editor feedback and keeps the best-scoring draft when none passes', async () => {
    const tooLong = `${shortBody} ${'Thêm chi tiết dài dòng. '.repeat(20)}`;
    const create = jest.fn()
      .mockResolvedValueOnce(variant(tooLong))
      .mockResolvedValueOnce(reviewed({ ...passingReview, score: 5, issues: ['Mở bài chung chung'] }))
      .mockResolvedValueOnce(variant(shortBody))
      .mockResolvedValueOnce(reviewed({ ...passingReview, score: 6, unsupportedClaims: ['Rẻ nhất thị trường'] }))
      .mockResolvedValueOnce(variant('Ngắn nhưng nhạt.'))
      .mockResolvedValueOnce(reviewed({ ...passingReview, score: 4, issues: ['Thiếu chi tiết'] }));
    const { service, created } = setup(create);

    await service.generate('owner-1', 'content-1', ['bluesky'], 'openai');

    expect(create).toHaveBeenCalledTimes(6);
    expect(request(create, 2).input).toContain('Your previous draft was rejected');
    // The length feedback says how much to cut.
    expect(request(create, 2).input).toMatch(/- Dài (\d+)\/300 ký tự, cần bớt ít nhất \d+ ký tự/);
    const [, length, cut] = /Dài (\d+)\/300 ký tự, cần bớt ít nhất (\d+) ký tự/.exec(request(create, 2).input)!;
    expect(Number(cut)).toBe(Number(length) - 300);
    expect(request(create, 2).input).toContain('- Mở bài chung chung');
    expect(request(create, 2).input).toContain('Editor scores (1-10): overall 5');
    expect(request(create, 4).input).toContain('Remove or ground this claim: Rẻ nhất thị trường');
    // The second attempt (6/10) beats the last one (4/10).
    expect(created[0]).toMatchObject({ recommended: false, body: shortBody });
    expect(created[0]!.reason).toBe('Cần xem lại (AI chấm 6/10): Thông tin chưa có căn cứ: Rẻ nhất thị trường');
  });

  it('keeps a draft that fits over a higher-scoring one the destination would refuse as too long', async () => {
    const tooLong = `${shortBody} ${'Thêm chi tiết dài dòng. '.repeat(20)}`;
    const create = jest.fn()
      .mockResolvedValueOnce(variant(tooLong))
      .mockResolvedValueOnce(reviewed({ ...passingReview, score: 9 }))
      .mockResolvedValueOnce(variant(shortBody))
      .mockResolvedValueOnce(reviewed({ ...passingReview, score: 6 }))
      .mockResolvedValueOnce(variant(tooLong))
      .mockResolvedValueOnce(reviewed({ ...passingReview, score: 10 }));
    const { service, created } = setup(create);

    await service.generate('owner-1', 'content-1', ['bluesky'], 'openai');

    // No shortening call: the kept draft already fits.
    expect(create).toHaveBeenCalledTimes(6);
    expect(created[0]).toMatchObject({ body: shortBody, recommended: false });
    expect(created[0]!.reason).toMatch(/^Cần xem lại \(AI chấm 6\/10\)/);
    // The editor knew the limit and the length of the draft it judged.
    expect(request(create, 1).instructions).toMatch(/Hard length limit: the published post has at most 300 characters.*; this draft has \d+\..*it is \d+ characters over/);
    expect(request(create, 3).instructions).not.toContain('characters over');
  });

  it('asks the writer once to only shorten a draft still over the limit, and keeps its review when it then fits', async () => {
    const tooLong = `${shortBody} ${'Thêm chi tiết dài dòng. '.repeat(20)}`;
    const create = jest.fn()
      .mockResolvedValueOnce(variant(tooLong)).mockResolvedValueOnce(reviewed())
      .mockResolvedValueOnce(variant(tooLong)).mockResolvedValueOnce(reviewed())
      .mockResolvedValueOnce(variant(tooLong)).mockResolvedValueOnce(reviewed())
      .mockResolvedValueOnce(variant(shortBody, { reason: 'Bản rút gọn' }));
    const { service, created } = setup(create);

    await service.generate('owner-1', 'content-1', ['bluesky'], 'openai');

    expect(create).toHaveBeenCalledTimes(7);
    const shorten = request(create, 6);
    expect(shorten.text.format.name).toBe('content_variant');
    expect(shorten.input).toMatch(/Shorten your draft for Bluesky\. As published it has (\d+) characters; the limit is 300\. Cut at least \d+ characters/);
    expect(shorten.input).toContain('Only shorten: keep the meaning');
    expect(shorten.input).toContain(JSON.stringify(tooLong.trim()));
    // The writer's own judgement of the post stays; the note says it was shortened.
    expect(created[0]).toMatchObject({ body: shortBody, recommended: true, reason: 'Hợp người đọc (AI chấm 8/10) · đã rút gọn tự động để vừa 300 ký tự' });
  });

  describe('a Mastodon post that stays over 500 characters', () => {
    const source = 'https://vpsttt.vn/blog/vps-nvme-cho-lap-trinh-vien-viet-nam';
    const sentences = [
      'Triển khai VPS NVMe chỉ trong 60 giây, có người hỗ trợ bằng tiếng Việt khi bạn cần.',
      'Ổ NVMe đọc ghi nhanh gấp nhiều lần SSD thường, nên cơ sở dữ liệu và build CI chạy mượt hơn hẳn.',
      'Bạn chọn hệ điều hành, gói cấu hình và vùng đặt máy chủ ngay trên bảng điều khiển.',
      'Sao lưu tự động mỗi ngày giúp bạn yên tâm thử nghiệm mà không sợ mất dữ liệu.',
      'Đội kỹ thuật trực cả cuối tuần, trả lời bằng tiếng Việt trong vài phút qua chat.',
      'Mình đã chuyển ba dự án sang đây.',
    ];
    // With the source line the system adds, 545/500 as published.
    const long = `${[...sentences, 'Bạn đang chạy dự án của mình trên đâu?'].join(' ')}\n\n#vps #nvme #linux`;
    const stillLong = `${[...sentences, 'Bạn chạy dự án ở đâu?'].join(' ')}\n\n#vps #nvme #linux`;
    const mastodonDraft = (body: string) => variant(body, { hashtags: ['vps', 'nvme', 'linux'] });

    it('cuts it to fit when the writer cannot, and leaves it for a person to read', async () => {
      const create = jest.fn()
        .mockResolvedValueOnce(mastodonDraft(long)).mockResolvedValueOnce(reviewed())
        .mockResolvedValueOnce(mastodonDraft(long)).mockResolvedValueOnce(reviewed())
        .mockResolvedValueOnce(mastodonDraft(long)).mockResolvedValueOnce(reviewed())
        .mockResolvedValueOnce(mastodonDraft(stillLong));
      const { service, created } = setup(create, { slug: 'mastodon', canonicalUrl: source });

      await service.generate('owner-1', 'content-1', ['mastodon'], 'openai');

      const writer = request(create, 0);
      expect(writer.instructions).toContain('must be at most 500 characters');
      expect(writer.instructions).toContain(`The system adds the line "Nguồn: ${source}" below the body (32 characters with the blank line before it), so the body with its hashtags gets at most 468 characters`);
      expect(writer.instructions).toContain('On Mastodon every link counts as 23 characters');
      expect(request(create, 1).instructions).toContain('this draft has 545');
      expect(request(create, 2).input).toContain('Dài 545/500 ký tự, cần bớt ít nhất 45 ký tự');
      expect(request(create, 6).input).toContain('As published it has 545 characters; the limit is 500. Cut at least 45 characters');
      expect(request(create, 6).input).toContain('the body with its hashtags must stay within 468 characters');
      expect(create).toHaveBeenCalledTimes(7);

      const stored = created[0] as { title: string | null; body: string; hashtags: string[]; recommended: boolean; reason: string };
      const published = checkPostLength({ ...stored, platformSlug: 'mastodon', canonicalUrl: source });
      expect(published.over).toBe(false);
      expect(published.length).toBeLessThanOrEqual(500);
      // Whole sentences of the writer's shorter draft, one closing hashtag kept.
      expect(stored.body).toMatch(/[.?]\n\n#vps$/);
      expect(stillLong.startsWith(stored.body.replace(/\n\n#vps$/, ''))).toBe(true);
      expect(stored.recommended).toBe(false);
      expect(stored.reason).toMatch(/^Cần xem lại \(AI chấm 8\/10\): Máy đã cắt bớt phần cuối bài, đọc lại trước khi duyệt · đã rút gọn tự động để vừa 500 ký tự$/);
    });

    it('still fits the post when the shortening request fails', async () => {
      const create = jest.fn()
        .mockResolvedValueOnce(mastodonDraft(long)).mockResolvedValueOnce(reviewed())
        .mockResolvedValueOnce(mastodonDraft(long)).mockResolvedValueOnce(reviewed())
        .mockResolvedValueOnce(mastodonDraft(long)).mockResolvedValueOnce(reviewed())
        .mockRejectedValueOnce(Object.assign(new Error('bad request'), { status: 400 }));
      const { service, created } = setup(create, { slug: 'mastodon', canonicalUrl: source });

      await service.generate('owner-1', 'content-1', ['mastodon'], 'openai');

      const stored = created[0] as { title: string | null; body: string; hashtags: string[]; reason: string };
      expect(checkPostLength({ ...stored, platformSlug: 'mastodon', canonicalUrl: source }).over).toBe(false);
      expect(long.startsWith(stored.body.replace(/\n\n#vps$/, ''))).toBe(true);
      expect(stored.reason).toContain('đã rút gọn tự động để vừa 500 ký tự');
    });
  });

  it('judges a new draft on its own, without any earlier review', async () => {
    const create = jest.fn().mockResolvedValueOnce(variant(shortBody)).mockResolvedValueOnce(reviewed());
    const { service } = setup(create);
    await service.generate('owner-1', 'content-1', ['bluesky'], 'openai');
    expect(request(create, 1).instructions).not.toContain('revises an earlier version');
  });

  it('suggests campaigns from the brand, the chosen platforms and past scores, keeping only usable ideas', async () => {
    const idea = (name: string) => ({ name, brief: 'Hướng dẫn tối ưu NGINX trên VPS 2 GB: worker_processes, gzip, cache; gắn VPS NVMe của VPSTTT.', angle: 'Hướng dẫn', whyEffective: 'Giải quyết vấn đề thật.', platformFit: 'Diễn đàn: hỏi kinh nghiệm; Bluesky: một mẹo ngắn.' });
    const create = jest.fn().mockResolvedValueOnce({ output_text: JSON.stringify({ suggestions: [
      idea('Tối ưu NGINX trên VPS nhỏ'), idea('Tối ưu NGINX trên VPS nhỏ'), idea('x'), idea('Checklist IPv6 cho website'),
    ] }) }).mockResolvedValueOnce({ output_text: JSON.stringify({ scores: [
      { index: 0, score: 6, platformFit: 7, readerValue: 8, brandFit: 5, engagement: 6, weakness: 'Hơi chung chung với Bluesky.' },
      { index: 1, score: 9, platformFit: 9, readerValue: 9, brandFit: 8, engagement: 12, weakness: 'Cần lệnh cụ thể.' },
    ] }) });
    const { service } = setup(create);
    const result = await service.suggestCampaigns('owner-1', { platformSlugs: ['bluesky', 'nginx-community', 'unknown-site'], hint: 'proxy dân cư' }, 'openai');

    const sent = request(create, 0);
    expect(sent.text.format.name).toBe('campaign_suggestions');
    expect(sent.instructions).toContain('The company and its product appear as the natural solution or tool, at most once per post; never an advertisement.');
    expect(sent.instructions).toContain('Every idea must work on ALL the chosen platforms at once');
    expect(sent.input).toContain('Chosen platforms (every idea must fit all 2 of them):');
    expect(sent.input).toContain('Brand: VPSTTT');
    expect(sent.input).toMatch(/- Bluesky \(social, at most 300 characters\)/);
    expect(sent.input).toContain('- NGINX Community (');
    expect(sent.input).not.toContain('unknown-site');
    expect(sent.input).toContain('"Giới thiệu proxy": Giới thiệu proxy, VPS của vpsttt qua chia sẻ kiến thức (drafts: 2, average editor score: 7/10, published: 1)');
    expect(sent.input).toContain('- Bluesky: 6/10 over 1 drafts');
    expect(sent.input).toContain('The operator wants ideas about: proxy dân cư');
    // Duplicates and empty ideas are dropped; a second, separate request scores the rest and the best comes first.
    const scoring = request(create, 1);
    expect(scoring.text.format.name).toBe('campaign_suggestion_scores');
    expect(scoring.input).toContain('[0] Tối ưu NGINX trên VPS nhỏ');
    expect(scoring.input).toContain('[1] Checklist IPv6 cho website');
    expect(result.scored).toBe(true);
    expect(result.suggestions.map((item) => [item.name, item.review?.score, item.recommended])).toEqual([
      ['Checklist IPv6 cho website', 9, true], ['Tối ưu NGINX trên VPS nhỏ', 6, undefined],
    ]);
    expect(result.suggestions[0]!.review).toMatchObject({ engagement: 10, weakness: 'Cần lệnh cụ thể.' });
  });

  it('still returns the ideas, unscored, when the scoring request fails', async () => {
    const create = jest.fn()
      .mockResolvedValueOnce({ output_text: JSON.stringify({ suggestions: [{ name: 'Tối ưu NGINX trên VPS nhỏ', brief: 'Hướng dẫn tối ưu NGINX trên VPS 2 GB cho người tự quản trị.', angle: 'Hướng dẫn', whyEffective: 'x', platformFit: 'y' }] }) })
      .mockRejectedValueOnce({ status: 400, message: 'raw-bad' });
    const { service } = setup(create);
    const result = await service.suggestCampaigns('owner-1', { platformSlugs: ['bluesky'] }, 'openai');
    expect(result).toMatchObject({ scored: false, suggestions: [{ name: 'Tối ưu NGINX trên VPS nhỏ' }] });
    expect(result.suggestions[0]!.review).toBeUndefined();
  });

  it('remembers which platform was being written when a run failed', async () => {
    const create = jest.fn().mockRejectedValue({ status: 401, message: 'raw-auth' });
    const { service } = setup(create);
    const error: unknown = await service.generate('owner-1', 'content-1', ['bluesky'], 'openai').catch((caught: unknown) => caught);
    expect(failedPlatformOf(error)).toBe('bluesky');
    expect(failedPlatformOf(new Error('other'))).toBeUndefined();
  });

  it('stops rewriting as soon as a rewrite passes', async () => {
    const create = jest.fn()
      .mockResolvedValueOnce(variant(shortBody))
      .mockResolvedValueOnce(reviewed({ ...passingReview, score: 5 }))
      .mockResolvedValueOnce(variant(shortBody))
      .mockResolvedValueOnce(reviewed());
    const { service, created } = setup(create);
    await service.generate('owner-1', 'content-1', ['bluesky'], 'openai');
    expect(create).toHaveBeenCalledTimes(4);
    expect(created[0]).toMatchObject({ recommended: true, reason: 'Hợp người đọc (AI chấm 8/10)' });
  });

  it('revises a stored draft from the operator instruction and review notes, keeping the instruction through rewrites and the current image', async () => {
    const create = jest.fn()
      .mockResolvedValueOnce(variant(shortBody))
      .mockResolvedValueOnce(reviewed({ ...passingReview, score: 6, issues: ['Thiếu số liệu'] }))
      .mockResolvedValueOnce(variant(shortBody))
      .mockResolvedValueOnce(reviewed());
    const { service, created } = setup(create);
    const result = await service.reviseDraft('owner-1', {
      contentId: 'content-1', platformSlug: 'bluesky', image: { need: 'optional', size: '1536x1024', style: 'a simple illustration' },
      revision: { previous: { title: null, body: 'Bản cũ nhạt', hashtags: ['vps'] }, instruction: 'Mở bài bằng số liệu cụ thể', notes: 'Cần xem lại (AI chấm 5/10): Mở bài chung chung' },
    }, 'openai');

    const writer = request(create, 0);
    expect(writer.input).toContain('Edit your previous draft for this destination so it passes the editor\'s review.');
    expect(writer.input).toContain('Edit, do not rewrite: change only the sentences the notes and the operator\'s instructions point to');
    expect(writer.input).toContain('The operator\'s instructions may ask for a bigger change');
    expect(writer.input).toContain('"body":"Bản cũ nhạt"');
    expect(writer.input).toContain("Operator's instructions (highest priority, within the destination contract):\nMở bài bằng số liệu cụ thể");
    expect(writer.input).toContain("Editor's notes from the last review:\nCần xem lại (AI chấm 5/10): Mở bài chung chung");
    // The follow-up edits the best version so far with the new notes; it never starts again from the brief.
    const followUp = request(create, 2).input;
    expect(followUp).toContain('Your edited draft still fails the editor\'s review. Edit it once more.');
    expect(followUp).toContain(`"body":"${shortBody}"`);
    expect(followUp).toContain('- Thiếu số liệu');
    expect(followUp).toContain("The operator's instructions still apply: Mở bài bằng số liệu cụ thể");
    expect(followUp).not.toContain('Rewrite it from scratch');
    // No art director call: the post keeps its image; nothing is stored here.
    expect(create).toHaveBeenCalledTimes(4);
    expect(created).toHaveLength(0);
    expect(result).toMatchObject({ body: shortBody, recommended: true, reason: 'Hợp người đọc (AI chấm 8/10)' });
    expect(result.media.status).toBeUndefined();
  });

  it('revises a draft from only the review points the operator chose, keeping them through rewrites', async () => {
    const create = jest.fn()
      .mockResolvedValueOnce(variant(shortBody))
      .mockResolvedValueOnce(reviewed({ ...passingReview, score: 6, issues: ['Thiếu số liệu'] }))
      .mockResolvedValueOnce(variant(shortBody))
      .mockResolvedValueOnce(reviewed());
    const { service } = setup(create);
    await service.reviseDraft('owner-1', {
      contentId: 'content-1', platformSlug: 'bluesky',
      revision: { previous: { title: null, body: 'Bản cũ nhạt', hashtags: ['vps'] }, instruction: '', notes: null, chosenNotes: ['Lời mở đầu hơi chung chung', 'Thêm một ví dụ cụ thể'], previousScore: 7 },
    }, 'openai');

    // Both reviews (after the revision and after the rewrite) check the chosen fixes against the old 7/10.
    for (const review of [request(create, 1), request(create, 3)]) {
      expect(review.text.format.name).toBe('content_review');
      expect(review.instructions).toContain('This draft revises an earlier version that you scored 7/10. The operator asked the writer to fix:\n- Lời mở đầu hơi chung chung\n- Thêm một ví dụ cụ thể');
      expect(review.instructions).toContain('the score must be higher than 7');
    }
    const writer = request(create, 0);
    expect(writer.input).toContain("Fix each of these points from the editor's last review, chosen by the operator (other earlier notes do not apply):\n- Lời mở đầu hơi chung chung\n- Thêm một ví dụ cụ thể");
    expect(writer.input).not.toContain("Editor's notes from the last review");
    expect(writer.input).not.toContain("Operator's instructions");
    expect(request(create, 2).input).toContain('The fixes the operator chose still apply: Lời mở đầu hơi chung chung; Thêm một ví dụ cụ thể');
  });

  it('designs an image for an existing post from its text, and reports a failure instead of inventing one', async () => {
    const create = jest.fn().mockResolvedValueOnce(artDirected());
    const { service } = setup(create);
    const plan = { need: 'optional' as const, size: '1536x1024' as const, style: 'a simple editorial technology illustration' };
    const designed = await service.designImage('owner-1', { contentId: 'content-1', platformSlug: 'bluesky', post: { title: null, body: shortBody }, image: plan }, 'openai');
    expect(request(create, 0).text.format.name).toBe('image_brief');
    expect(request(create, 0).input).toContain(shortBody);
    expect(designed.prompt.split('\n')[0]).toBe('Premium 3D render for a Bluesky post, landscape 3:2 frame.');
    expect(designed.altText).toBe(artBrief.altText);
    create.mockRejectedValueOnce(Object.assign(new Error('bad request'), { status: 400 }));
    await expect(service.designImage('owner-1', { contentId: 'content-1', platformSlug: 'bluesky', post: { title: null, body: shortBody }, image: plan }, 'openai')).rejects.toBeDefined();
  });

  it('does not rewrite a draft the writer marks as unsuitable, and never auto-approves it', async () => {
    const create = jest.fn()
      .mockResolvedValueOnce(variant(shortBody, { recommended: false, reason: 'Không phải câu hỏi thật' }))
      .mockResolvedValueOnce(reviewed());
    const { service, created } = setup(create);

    await service.generate('owner-1', 'content-1', ['bluesky'], 'openai');

    expect(create).toHaveBeenCalledTimes(2);
    expect(created[0]).toMatchObject({ recommended: false, reason: 'Cần xem lại (AI chấm 8/10): AI đánh giá không hợp nơi đăng: Không phải câu hỏi thật' });
  });

  it('waits longer and longer for a rate-limited write, and stores but never recommends a draft the reviewer could not score', async () => {
    const create = jest.fn()
      .mockRejectedValueOnce({ status: 429, message: 'raw-limit' })
      .mockRejectedValueOnce({ status: 429, message: 'raw-limit' })
      .mockRejectedValueOnce({ status: 429, message: 'raw-limit' })
      .mockResolvedValueOnce(variant(shortBody))
      .mockRejectedValueOnce(new Error('reviewer down'));
    const { service, created, delay } = setup(create);

    await service.generate('owner-1', 'content-1', ['bluesky'], 'openai');

    // The IDE counts calls over the last minute: a 2-second retry would be refused again.
    expect(delay.mock.calls.map(([ms]) => ms)).toEqual([15_000, 30_000, 60_000]);
    expect(create).toHaveBeenCalledTimes(5);
    // A draft the reviewer could not score is stored but never recommended (3 AI roles).
    expect(created[0]).toMatchObject({
      recommended: false,
      reason: 'Cần xem lại (AI chưa chấm được): Chưa có điểm của AI chấm (OpenAI · openai-test-model), đọc kỹ trước khi duyệt',
    });
  });

  describe('three AI roles: writer, reviewer, final approver', () => {
    type ChatRequest = { model: string; messages: Array<{ role: string; content: string }> };
    const chatRequest = (mock: jest.Mock, index: number) => (mock.mock.calls[index] as [ChatRequest])[0];
    const stored = (row: Record<string, unknown>) => row as { title: string | null; body: string; hashtags: string[]; recommended: boolean; reason: string; aiApproval?: Record<string, unknown> };

    const opusReview = (extra: Record<string, unknown> = {}) => chat({ ...passingReview, seeding: { detected: false, notes: [] }, brandRisk: 'none', riskNotes: [], ...extra });

    it('by default lets Claude Opus score and give the final verdict in one review, with no second call', async () => {
      const create = jest.fn().mockResolvedValueOnce(variant(shortBody));
      const vpsttt = jest.fn().mockResolvedValue(opusReview({ issues: ['Có thể thêm một ví dụ'] }));
      const { service, created } = setup(create, { approve: vpsttt, config: { AI_REVIEWER: '' } });

      await service.generate('owner-1', 'content-1', ['bluesky'], 'openai');

      expect(create).toHaveBeenCalledTimes(1);
      expect(vpsttt.mock.calls.map(([request]) => (request as ChatRequest).model)).toEqual(['claude:opus']);
      const review = chatRequest(vpsttt, 0).messages[0]!.content;
      expect(review).toContain('demanding but fair senior editor for Bluesky');
      expect(review).toContain('Leaked internal text');
      const row = stored(created[0]!);
      expect(row).toMatchObject({ recommended: true, reason: 'Hợp người đọc (AI chấm 8/10)' });
      expect(row.aiApproval).toMatchObject({
        status: 'approved', approver: 'vpsttt:claude:opus', approverLabel: 'Claude Opus', score: 8, risk: 'none', seeding: false,
        reasons: ['Có thể thêm một ví dụ'], error: null,
        textHash: approvalHash({ title: row.title, body: row.body, hashtags: row.hashtags }),
      });
    });

    it('sends Opus\'s notes on leaked brief text back to the writer, and approves the fixed draft', async () => {
      const leaked = 'Nội dung gắn với thương hiệu VPS vpsttt: chưa xác nhận hỗ trợ IPv6. Triển khai VPS NVMe trong 60 giây. #vps';
      const create = jest.fn().mockResolvedValueOnce(variant(leaked)).mockResolvedValueOnce(variant(shortBody));
      const vpsttt = jest.fn()
        .mockResolvedValueOnce(opusReview({ score: 5, issues: ['Câu "Nội dung gắn với thương hiệu…" lộ chỉ dẫn nội bộ: đổi thành "Mình làm ở VPSTTT."'] }))
        .mockResolvedValueOnce(opusReview());
      const { service, created } = setup(create, { approve: vpsttt, config: { AI_REVIEWER: '' } });

      await service.generate('owner-1', 'content-1', ['bluesky'], 'openai');

      // The writer's rules forbid copying the brief and ask for a natural disclosure.
      expect(request(create, 0).instructions).toContain('never quote, copy or paraphrase them into the post');
      expect(request(create, 0).instructions).toContain('Mình làm ở VPSTTT, bên cung cấp VPS và proxy');
      expect(request(create, 1).input).toContain('lộ chỉ dẫn nội bộ: đổi thành "Mình làm ở VPSTTT."');
      expect(vpsttt).toHaveBeenCalledTimes(2);
      expect(stored(created[0]!)).toMatchObject({ body: shortBody, recommended: true, aiApproval: { status: 'approved', score: 8 } });
    });

    it('stores the review\'s refusal as the verdict without repeating it in the reason', async () => {
      const failing = opusReview({ score: 6, issues: ['Mở bài chung chung'] });
      const create = jest.fn().mockResolvedValue(variant(shortBody));
      const vpsttt = jest.fn().mockResolvedValue(failing);
      const { service, created } = setup(create, { approve: vpsttt, config: { AI_REVIEWER: '' } });

      await service.generate('owner-1', 'content-1', ['bluesky'], 'openai');

      // The draft and two rewrites, each read once by Opus; no separate approval call.
      expect(vpsttt).toHaveBeenCalledTimes(3);
      const row = stored(created[0]!);
      expect(row.recommended).toBe(false);
      expect(row.reason).toBe('Cần xem lại (AI chấm 6/10): Mở bài chung chung');
      expect(row.aiApproval).toMatchObject({ status: 'rejected', score: 6, reasons: ['Mở bài chung chung', 'Điểm 6/10, dưới mức đạt 7/10'], textHash: approvalHash(row) });
    });

    it('still asks Opus for the final verdict when its review never saw what is stored: a newly designed image', async () => {
      const create = jest.fn()
        .mockResolvedValueOnce(variant(shortBody, { media: { type: 'image', altText: 'Máy chủ', prompt: 'A server rack' } }))
        .mockResolvedValueOnce(artDirected());
      const vpsttt = jest.fn().mockResolvedValueOnce(opusReview()).mockResolvedValueOnce(verdict({ reasons: [] }));
      const { service, created } = setup(create, { approve: vpsttt, config: { AI_REVIEWER: '' } });
      const plan = new Map([['bluesky', { need: 'optional' as const, size: '1536x1024' as const, style: 'a simple editorial illustration' }]]);

      await service.generate('owner-1', 'content-1', ['bluesky'], 'openai', undefined, plan);

      expect(vpsttt).toHaveBeenCalledTimes(2);
      expect(chatRequest(vpsttt, 1).messages[0]!.content).toContain('final approver for posts published on behalf of VPSTTT');
      expect(chatRequest(vpsttt, 1).messages[1]!.content).toContain('Alt text: Máy chủ NVMe phát sáng');
      expect(stored(created[0]!).aiApproval).toMatchObject({ status: 'approved', score: 9 });
    });

    it('with a separate reviewer (AI_REVIEWER=vpsttt:claude:sonnet), sends the writer, the reviewer and the approver to their own models', async () => {
      const create = jest.fn().mockResolvedValueOnce(variant(shortBody));
      const vpsttt = jest.fn((request: ChatRequest) => Promise.resolve(request.model === 'claude:opus'
        ? verdict({ reasons: ['Có thể thêm một ví dụ'] })
        : opusReview()));
      const { service, created } = setup(create, { approve: vpsttt, config: { AI_REVIEWER: 'vpsttt:claude:sonnet' } });

      await service.generate('owner-1', 'content-1', ['bluesky'], 'openai');

      expect(create).toHaveBeenCalledTimes(1);
      expect(create).toHaveBeenCalledWith(expect.objectContaining({ model: 'openai-test-model' }));
      expect(vpsttt.mock.calls.map(([request]) => request.model)).toEqual(['claude:sonnet', 'claude:opus']);
      const reviewer = chatRequest(vpsttt, 0);
      expect(reviewer.messages[0]!.content).toContain('demanding but fair senior editor for Bluesky');
      expect(reviewer.messages[0]!.content).toContain('clumsy seeding (astroturfing)');
      const approver = chatRequest(vpsttt, 1);
      expect(approver.messages[0]!.content).toContain('final approver for posts published on behalf of VPSTTT');
      expect(approver.messages[1]!.content).toContain(`<body>\n${shortBody}\n</body>`);
      expect(approver.messages[1]!.content).toContain('<brand_facts>');
      expect(approver.messages[1]!.content).toContain('Editor score 8/10');
      expect(approver.messages[1]!.content).toContain('Image: none, the post is text only.');
      const row = stored(created[0]!);
      expect(row).toMatchObject({ recommended: true, reason: 'Hợp người đọc (AI chấm 8/10)' });
      expect(row.aiApproval).toMatchObject({
        status: 'approved', approver: 'vpsttt:claude:opus', approverLabel: 'Claude Opus', score: 9, risk: 'none', seeding: false,
        reasons: ['Có thể thêm một ví dụ'], error: null,
        textHash: approvalHash({ title: row.title, body: row.body, hashtags: row.hashtags }),
      });
      expect(new Date(row.aiApproval!.startedAt as string).toISOString()).toBe(row.aiApproval!.startedAt);
      expect(new Date(row.aiApproval!.finishedAt as string).toISOString()).toBe(row.aiApproval!.finishedAt);
    });

    it('reviews with the writer when the reviewer has no key, and fails the approval clearly when the approver has none', async () => {
      const create = jest.fn().mockResolvedValueOnce(variant(shortBody)).mockResolvedValueOnce(reviewed());
      const { service, created } = setup(create, { approve: null, config: { AI_REVIEWER: '' } });

      await service.generate('owner-1', 'content-1', ['bluesky'], 'openai');

      expect(request(create, 1).text.format.name).toBe('content_review');
      const row = stored(created[0]!);
      expect(row.recommended).toBe(false);
      expect(row.reason).toBe('AI duyệt cuối chưa chạy được: Chưa cấu hình VPSTTT AI (VPSTTT_AI_BASE_URL, VPSTTT_AI_API_KEY) để chạy claude:opus (AI chấm 8/10)');
      expect(row.aiApproval).toMatchObject({ status: 'failed', approver: 'vpsttt:claude:opus', error: expect.stringContaining('Chưa cấu hình VPSTTT AI') as unknown });
    });

    it('fails a 9/10 draft with seeding or a medium/high risk for the company, and sends the notes to the writer and the reason', async () => {
      const create = jest.fn()
        .mockResolvedValueOnce(variant(shortBody))
        .mockResolvedValueOnce(reviewed({ ...passingReview, score: 9, seeding: { detected: true, notes: ['Giả làm khách hàng độc lập'] }, brandRisk: 'none', riskNotes: [] }))
        .mockResolvedValueOnce(variant(shortBody))
        .mockResolvedValueOnce(reviewed({ ...passingReview, score: 9, seeding: { detected: false, notes: [] }, brandRisk: 'high', riskNotes: ['Chỉ cách dùng proxy lách lệnh cấm'] }))
        .mockResolvedValueOnce(variant(shortBody))
        .mockResolvedValueOnce(reviewed({ ...passingReview, score: 9, seeding: { detected: false, notes: [] }, brandRisk: 'medium', riskNotes: ['Hứa "không bao giờ bị chặn"'] }));
      const { service, created, approve } = setup(create);

      await service.generate('owner-1', 'content-1', ['bluesky'], 'openai');

      expect(create).toHaveBeenCalledTimes(6);
      expect(request(create, 1).instructions).toContain('brandRisk: the risk for the company publishing the post');
      expect(request(create, 2).input).toContain('- Clumsy seeding (reads as a disguised advert), fix it: Giả làm khách hàng độc lập');
      expect(request(create, 4).input).toContain('- Risk for the company (high), remove it: Chỉ cách dùng proxy lách lệnh cấm');
      // The approver still reads the final draft once; its yes does not lift a failed review.
      expect(approve!).toHaveBeenCalledTimes(1);
      expect(chatRequest(approve!, 0).messages[1]!.content).toContain('Brand risk: medium (Hứa "không bao giờ bị chặn")');
      expect(stored(created[0]!)).toMatchObject({
        recommended: false, reason: 'Cần xem lại (AI chấm 9/10): Rủi ro cho công ty: Hứa "không bao giờ bị chặn"',
      });
    });

    it('keeps the draft unrecommended when the approver refuses, leading the reason and keeping the score readable', async () => {
      const create = jest.fn().mockResolvedValueOnce(variant(shortBody)).mockResolvedValueOnce(reviewed());
      const approve = jest.fn().mockResolvedValue(verdict({ approved: false, score: 5, risk: 'low', reasons: ['Câu cuối như quảng cáo.', 'Thiếu ví dụ cụ thể'] }));
      const { service, created } = setup(create, { approve });

      await service.generate('owner-1', 'content-1', ['bluesky'], 'openai');

      const row = stored(created[0]!);
      expect(row.recommended).toBe(false);
      expect(row.reason).toBe('AI duyệt cuối (Claude Opus) từ chối: Câu cuối như quảng cáo; Thiếu ví dụ cụ thể (AI chấm 8/10)');
      expect(scoreFromReason(row.reason)).toBe(8);
      expect(row.aiApproval).toMatchObject({ status: 'rejected', score: 5, risk: 'low', textHash: approvalHash(row) });
    });

    it('keeps only whole refusal reasons in the stored reason, so none is cut mid-sentence', async () => {
      const create = jest.fn().mockResolvedValueOnce(variant(shortBody)).mockResolvedValueOnce(reviewed());
      const long = (word: string) => `${word} ${'chi tiết '.repeat(25).trim()}`;
      const approve = jest.fn().mockResolvedValue(verdict({ approved: false, score: 3, risk: 'medium', reasons: [long('Một'), long('Hai'), long('Ba')] }));
      const { service, created } = setup(create, { approve });

      await service.generate('owner-1', 'content-1', ['bluesky'], 'openai');

      const row = stored(created[0]!);
      expect(row.reason).toBe(`AI duyệt cuối (Claude Opus) từ chối: ${long('Một')} (AI chấm 8/10)`);
      // The full list stays with the verdict.
      expect((row.aiApproval!.reasons as string[])).toHaveLength(3);
    });

    it('puts the refusal before the review problems when both fail', async () => {
      const create = jest.fn()
        .mockResolvedValueOnce(variant(shortBody, { recommended: false, reason: 'Không hợp cộng đồng' }))
        .mockResolvedValueOnce(reviewed());
      const approve = jest.fn().mockResolvedValue(verdict({ approved: true, seeding: true, reasons: [] }));
      const { service, created } = setup(create, { approve });

      await service.generate('owner-1', 'content-1', ['bluesky'], 'openai');

      expect(stored(created[0]!).reason).toBe('AI duyệt cuối (Claude Opus) từ chối: Bài có dấu hiệu seeding (quảng cáo trá hình). Cần xem lại (AI chấm 8/10): AI đánh giá không hợp nơi đăng: Không hợp cộng đồng');
    });

    it('never throws when VPSTTT AI refuses the approver model, and says so in Vietnamese', async () => {
      const create = jest.fn().mockResolvedValueOnce(variant(shortBody)).mockResolvedValueOnce(reviewed());
      const approve = jest.fn().mockRejectedValue({ status: 403, message: 'raw-upstream', error: { code: 'model_denied', message: 'raw-upstream' } });
      const { service, created } = setup(create, { approve });

      await expect(service.generate('owner-1', 'content-1', ['bluesky'], 'openai')).resolves.toHaveLength(1);

      expect(approve).toHaveBeenCalledTimes(1);
      const row = stored(created[0]!);
      expect(row.recommended).toBe(false);
      expect(row.reason).toMatch(/^AI duyệt cuối chưa chạy được: VPSTTT AI chưa cho key này dùng claude:opus \(kiểm tra quyền model và IP được phép của key trong mục AI API\) \(AI chấm 8\/10\)$/);
      expect(row.aiApproval).toMatchObject({ status: 'failed', error: expect.stringContaining('VPSTTT AI chưa cho key này dùng claude:opus') as unknown });
      expect(JSON.stringify(row.aiApproval)).not.toContain('raw-upstream');
    });

    it('hashes exactly the stored text, after repairing escaped line breaks and trimming hashtags', async () => {
      const escaped = 'Triển khai VPS NVMe trong 60 giây.\\nCó người hỗ trợ bằng tiếng Việt.\\nBạn chạy dự án ở đâu? #vps';
      const create = jest.fn().mockResolvedValueOnce(variant(escaped, { hashtags: ['#vps', ' vps ', 'nvme'] })).mockResolvedValueOnce(reviewed());
      const { service, created } = setup(create);

      await service.generate('owner-1', 'content-1', ['bluesky'], 'openai');

      const row = stored(created[0]!);
      expect(row.body).toContain('60 giây.\nCó người');
      expect(row.hashtags).toEqual(['vps', 'nvme']);
      expect(row.aiApproval!.textHash).toBe(approvalHash(row));
    });

    it('returns the approval with a revised draft, for the rewrite to store', async () => {
      const create = jest.fn().mockResolvedValueOnce(variant(shortBody)).mockResolvedValueOnce(reviewed());
      const { service } = setup(create);
      const result = await service.reviseDraft('owner-1', {
        contentId: 'content-1', platformSlug: 'bluesky',
        revision: { previous: { title: null, body: 'Bản cũ', hashtags: ['vps'] }, instruction: 'Ngắn hơn' },
      }, 'openai');
      expect(result).toMatchObject({ recommended: true, approval: { status: 'approved', textHash: approvalHash(result) } });
    });

    it('works as before when the final approver is switched off', async () => {
      const create = jest.fn()
        .mockResolvedValueOnce(variant(shortBody)).mockResolvedValueOnce(reviewed())
        .mockResolvedValueOnce(variant(shortBody)).mockResolvedValueOnce(reviewed());
      const { service, created, approve } = setup(create, { config: { AI_APPROVAL_ENABLED: 'false' } });

      await service.generate('owner-1', 'content-1', ['bluesky'], 'openai');
      const revised = await service.reviseDraft('owner-1', {
        contentId: 'content-1', platformSlug: 'bluesky', revision: { previous: { title: null, body: 'Bản cũ', hashtags: [] }, instruction: 'x' },
      }, 'openai');

      expect(approve).not.toHaveBeenCalled();
      expect(created[0]).toMatchObject({ recommended: true, reason: 'Hợp người đọc (AI chấm 8/10)' });
      expect(created[0]).not.toHaveProperty('aiApproval');
      expect(revised).not.toHaveProperty('approval');
      expect(service.approvalEnabled()).toBe(false);
    });

    describe('approveDraft', () => {
      const draft = {
        contentId: 'content-1', platformSlug: 'devto', engine: 'devto' as const,
        title: 'Deploy NVMe VPS in 60 seconds', body: '## Steps\nCreate the server, then **connect** over SSH.', hashtags: ['#VPS', 'linux'],
        image: { prompt: 'Isometric server rack, cyan glow', altText: 'A server rack' }, reviewNotes: 'Hợp người đọc (AI chấm 8/10)',
      };

      it('reads the post as published with its image, brief, brand facts and review, and hashes the given text', async () => {
        const create = jest.fn();
        const { service, approve } = setup(create);

        const approval = await service.approveDraft('owner-1', draft);

        expect(create).not.toHaveBeenCalled();
        const sent = chatRequest(approve!, 0);
        expect(sent.model).toBe('claude:opus');
        expect(sent.messages[0]!.content).toContain('Return only one JSON object');
        const input = sent.messages[1]!.content;
        expect(input).toContain('Destination: dev.to');
        expect(input).toContain('<title>Deploy NVMe VPS in 60 seconds</title>');
        expect(input).toContain('<body>\n## Steps\nCreate the server, then **connect** over SSH.\n</body>');
        expect(input).toContain('<tags>VPS, linux</tags>');
        expect(input).toContain('- Generator prompt: Isometric server rack, cyan glow\n- Alt text: A server rack');
        expect(input).toContain(`Brief or source (short marketing brief):\n${brief}`);
        expect(input).toContain('Brand: VPSTTT');
        expect(input).toContain("The editor's last review:\nHợp người đọc (AI chấm 8/10)");
        expect(approval).toMatchObject({
          status: 'approved', approver: 'vpsttt:claude:opus', approverLabel: 'Claude Opus',
          textHash: approvalHash({ title: draft.title, body: draft.body, hashtags: draft.hashtags }),
        });
      });

      it.each([
        [{ name: 'APIConnectionTimeoutError', message: 'raw' }, 'VPSTTT AI trả lời quá thời gian chờ, thử lại sau', 2],
        [{ status: 429, message: 'raw' }, 'VPSTTT AI đang giới hạn số lượt gọi (429), thử lại sau ít phút', 4],
        [{ status: 400, message: 'raw' }, 'VPSTTT AI từ chối yêu cầu duyệt (model claude:opus không hợp lệ hoặc bài quá dài)', 1],
      ])('turns a provider error into a failed verdict instead of throwing (%o)', async (providerError, message, calls) => {
        const approve = jest.fn().mockRejectedValue(providerError);
        const { service } = setup(jest.fn(), { approve });

        const approval = await service.approveDraft('owner-1', draft);

        expect(approve).toHaveBeenCalledTimes(calls);
        expect(approval).toMatchObject({ status: 'failed', error: message, approver: 'vpsttt:claude:opus' });
        expect(approval.textHash).toBe(approvalHash(draft));
      });

      it('shows a title only where readers see one: above the body on Quora, not at all on Bluesky', async () => {
        const { service, approve } = setup(jest.fn());
        await service.approveDraft('owner-1', { contentId: 'content-1', platformSlug: 'quora', title: 'Which VPS for a small API?', body: 'Short answer first.', hashtags: [] });
        await service.approveDraft('owner-1', { contentId: 'content-1', platformSlug: 'bluesky', title: 'Not shown', body: shortBody, hashtags: ['vps'] });
        const quora = chatRequest(approve!, 0).messages[1]!.content;
        expect(quora).toContain('<post>\n<body>\nWhich VPS for a small API?\n\nShort answer first.\n</body>\n</post>');
        expect(chatRequest(approve!, 1).messages[1]!.content).not.toContain('Not shown');
      });

      it('reports an approver without a key as failed, without calling anything', async () => {
        const create = jest.fn();
        const { service } = setup(create, { approve: null });
        await expect(service.approveDraft('owner-1', draft)).resolves.toMatchObject({ status: 'failed', error: expect.stringContaining('Chưa cấu hình VPSTTT AI') as unknown });
        expect(create).not.toHaveBeenCalled();
      });

      it('uses another provider as approver when configured, with its own model', async () => {
        const create = jest.fn().mockResolvedValueOnce({ output_text: JSON.stringify({ approved: true, score: 8, risk: 'low', seeding: false, reasons: [] }) });
        const { service, approve } = setup(create, { config: { AI_APPROVER: 'openai:gpt-5' } });
        await expect(service.approveDraft('owner-1', draft)).resolves.toMatchObject({ status: 'approved', approver: 'openai:gpt-5', approverLabel: 'OpenAI · gpt-5' });
        expect(create).toHaveBeenCalledWith(expect.objectContaining({ model: 'gpt-5', text: { format: expect.objectContaining({ name: 'content_approval' }) as unknown } }));
        expect(approve).not.toHaveBeenCalled();
      });
    });

    it('lets Claude Opus edit a stored draft by default, whichever writer the campaign used', async () => {
      const create = jest.fn();
      const edited = chat({ platform: 'bluesky', title: null, body: shortBody, summary: null, hashtags: ['vps'], cta: null, recommended: true, reason: 'Đã sửa mở bài', media: { type: 'none', altText: '' } });
      const vpsttt = jest.fn((sent: ChatRequest) => Promise.resolve(sent.messages[0]!.content.includes('senior editor') ? opusReview() : edited));
      const { service } = setup(create, { approve: vpsttt, config: { AI_REVIEWER: '', AI_REVISER: '' } });

      const result = await service.reviseDraft('owner-1', {
        contentId: 'content-1', platformSlug: 'bluesky',
        revision: { previous: { title: null, body: 'Bản cũ nhạt', hashtags: ['vps'] }, instruction: '', chosenNotes: ['Mở bài chung chung'], previousScore: 6 },
      }, 'openai');

      // The campaign's writer (OpenAI) is not called: Opus edits, Opus scores, its review is the verdict.
      expect(create).not.toHaveBeenCalled();
      expect(vpsttt.mock.calls.map(([sent]) => sent.model)).toEqual(['claude:opus', 'claude:opus']);
      expect(chatRequest(vpsttt, 0).messages[1]!.content).toContain('Edit, do not rewrite');
      expect(result).toMatchObject({ body: shortBody, recommended: true, approval: { status: 'approved', approverLabel: 'Claude Opus' } });
      expect(await service.reviserFor('openai')).toEqual({ provider: 'vpsttt', model: 'claude:opus' });
    });

    it('edits with the requested writer when the reviser has no key', async () => {
      const create = jest.fn().mockResolvedValueOnce(variant(shortBody)).mockResolvedValueOnce(reviewed());
      const { service } = setup(create, { approve: null, config: { AI_REVISER: '' } });
      await service.reviseDraft('owner-1', {
        contentId: 'content-1', platformSlug: 'bluesky', revision: { previous: { title: null, body: 'Bản cũ', hashtags: [] }, instruction: 'Ngắn hơn' },
      }, 'openai');
      expect(request(create, 0).input).toContain('Edit your previous draft');
      expect(await service.reviserFor('deepseek')).toEqual({ provider: 'deepseek', model: '' });
    });

    it('describes the reviewer and the approver without keys', async () => {
      const { service } = setup(jest.fn(), { config: { AI_REVIEWER: '', AI_REVISER: '' } });
      expect(await service.roles()).toEqual({
        reviewer: { provider: 'vpsttt', model: 'claude:opus', label: 'Claude Opus', configured: true },
        approver: { provider: 'vpsttt', model: 'claude:opus', label: 'Claude Opus', configured: true },
        reviser: { provider: 'vpsttt', model: 'claude:opus', label: 'Claude Opus', configured: true },
        approvalEnabled: true,
      });
      const { service: withoutKey } = setup(jest.fn(), { approve: null, config: { AI_APPROVER: 'gemini' } });
      expect(await withoutKey.roles()).toEqual({
        reviewer: { provider: 'openai', model: 'openai-test-model', label: 'OpenAI · openai-test-model', configured: true },
        approver: { provider: 'gemini', model: 'gemini-test-model', label: 'Google Gemini · gemini-test-model', configured: false },
        reviser: { provider: 'openai', model: 'openai-test-model', label: 'OpenAI · openai-test-model', configured: true },
        approvalEnabled: true,
      });
    });
  });
});

describe('AiContentService per-call model', () => {
  const output = { approved: true, score: 9, risk: 'none', seeding: false, reasons: [] };
  const spec = { name: 'content_approval', jsonSchema: approvalJsonSchema, zod: ApprovalSchema };
  type Structured = { requestStructured(provider: AiProvider, instructions: string, input: string, s: typeof spec, model?: string): Promise<unknown> };

  it.each([
    ['openai', 'gpt-5', 'openai-test-model'],
    ['deepseek', 'deepseek-reasoner', 'deepseek-test-model'],
    ['vpsttt', 'claude:opus', 'claude:sonnet'],
  ] as const)('sends %s the requested model, or its configured model when none is given', async (provider, model, configured) => {
    const service = createService({} as PrismaService, isolatedConfig({ VPSTTT_AI_RPM: 60_000 }));
    const create = jest.fn().mockResolvedValue(provider === 'openai'
      ? { output_text: JSON.stringify(output) }
      : { choices: [{ message: { content: JSON.stringify(output) } }] });
    installClient(service, provider, provider === 'openai' ? { responses: { create } } : { chat: { completions: { create } } });
    const target = service as unknown as Structured;

    await target.requestStructured(provider, 'Judge.', 'Post', spec, model);
    await target.requestStructured(provider, 'Judge.', 'Post', spec);

    expect(create).toHaveBeenNthCalledWith(1, expect.objectContaining({ model }));
    expect(create).toHaveBeenNthCalledWith(2, expect.objectContaining({ model: configured }));
  });

  it('uses the requested Gemini model first and still falls back after it fails', async () => {
    const parse = jest.fn()
      .mockRejectedValueOnce({ status: 503, message: 'raw' })
      .mockRejectedValueOnce({ status: 503, message: 'raw' })
      .mockResolvedValueOnce({ choices: [{ message: { parsed: output, content: null } }] });
    const service = createService({} as PrismaService, isolatedConfig());
    skipGeminiRetryDelay(service);
    installClient(service, 'gemini', { chat: { completions: { parse } } });

    await (service as unknown as Structured).requestStructured('gemini', 'Judge.', 'Post', spec, 'gemini-3.5-pro');

    expect(parse.mock.calls.map(([request]) => (request as { model: string }).model)).toEqual(['gemini-3.5-pro', 'gemini-3.5-pro', 'gemini-fallback-test-model']);
  });
});

describe('AiContentService VPSTTT AI provider (IDE AI API)', () => {
  const variant = {
    platform: 'devto', title: 'VPSTTT title', body: 'VPSTTT body', summary: null,
    hashtags: ['ai'], cta: null, recommended: true, reason: 'Relevant',
    media: { type: 'none', altText: '' },
  };
  const source = { title: 'Title', body: 'Source', summary: null, canonicalUrl: null };

  function vpstttService(overrides: Record<string, ConfigValue> = {}) {
    return createService({} as PrismaService, isolatedConfig({ VPSTTT_AI_MODEL: 'claude:haiku', VPSTTT_AI_RPM: 600, ...overrides }));
  }

  it('sends only model, messages and stream=false, with the JSON contract in the system message', async () => {
    const create = jest.fn().mockResolvedValue({ choices: [{ message: { content: `\`\`\`json\n${JSON.stringify(variant)}\n\`\`\`` } }] });
    const service = vpstttService();
    installClient(service, 'vpsttt', { chat: { completions: { create } } });

    const result = await callModel(service, 'vpsttt', 'devto', 'Stay grounded.', '{{body}}', source);

    expect(result).toMatchObject({ platform: 'devto', body: 'VPSTTT body' });
    const params = (create.mock.calls[0] as [Record<string, unknown>])[0];
    // The IDE AI API answers HTTP 400 for any other parameter.
    expect(Object.keys(params).sort()).toEqual(['messages', 'model', 'stream']);
    expect(params).toMatchObject({ model: 'claude:haiku', stream: false });
    const messages = params.messages as Array<{ role: string; content: unknown }>;
    expect(messages.map((message) => message.role)).toEqual(['system', 'user']);
    expect(messages.every((message) => Object.keys(message).sort().join() === 'content,role' && typeof message.content === 'string')).toBe(true);
    expect(messages[0]?.content).toEqual(expect.stringContaining('JSON Schema'));
  });

  it('keeps every request within the 100,000 character limit of the IDE AI API', async () => {
    const create = jest.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify(variant) } }] });
    const service = vpstttService();
    installClient(service, 'vpsttt', { chat: { completions: { create } } });

    await callModel(service, 'vpsttt', 'devto', 'Stay grounded.', '{{body}}', { ...source, body: 'x'.repeat(150_000) });

    const messages = ((create.mock.calls[0] as [Record<string, unknown>])[0].messages) as Array<{ content: string }>;
    expect(messages.reduce((total, message) => total + message.content.length, 0)).toBeLessThanOrEqual(100_000);
  });

  it('explains a refused key and a rejected request without exposing the upstream body', async () => {
    const upstream = 'raw-upstream-detail-with-key-id';
    const service = vpstttService();
    const create = jest.fn()
      .mockRejectedValueOnce({ status: 403, message: upstream, error: { code: 'ip_denied', message: upstream } })
      .mockRejectedValueOnce({ status: 400, message: upstream, error: { code: 'invalid_request', message: upstream } });
    installClient(service, 'vpsttt', { chat: { completions: { create } } });

    const refused = await captureApplicationError(callModel(service, 'vpsttt', 'devto', 'S', '{{body}}', source));
    expect(refused.code).toBe(ErrorCode.PLATFORM_AUTH_FAILED);
    expect(refused.getResponse()).toMatchObject({ message: expect.stringContaining('allowed IPs') as unknown });
    const rejected = await captureApplicationError(callModel(service, 'vpsttt', 'devto', 'S', '{{body}}', source));
    expect(rejected.code).toBe(ErrorCode.PLATFORM_API_ERROR);
    expect(rejected.getResponse()).toMatchObject({ message: expect.stringContaining('rejected the request') as unknown });
    expect(JSON.stringify([refused.getResponse(), rejected.getResponse()])).not.toContain(upstream);
  });

  it('needs both the base URL and the key before it counts as configured', async () => {
    const keyOnly = vpstttService({ VPSTTT_AI_API_KEY: 'unit-test-key' });
    expect((await keyOnly.providers()).find((provider) => provider.id === 'vpsttt')?.configured).toBe(false);
    const error = await captureApplicationError(keyOnly.assertReady([], 'vpsttt'));
    expect(error.getResponse()).toMatchObject({ message: 'VPSTTT_AI_BASE_URL is not configured' });

    const ready = vpstttService({ VPSTTT_AI_API_KEY: 'unit-test-key', VPSTTT_AI_BASE_URL: 'https://ide.example.test/ai-api/v1' });
    expect((await ready.providers()).find((provider) => provider.id === 'vpsttt')).toMatchObject({ configured: true, model: 'claude:haiku' });
  });
});

describe('extractJsonObject', () => {
  it('keeps the JSON object from fenced or chatty replies and leaves plain JSON alone', () => {
    expect(extractJsonObject('{"a":1}')).toBe('{"a":1}');
    expect(extractJsonObject('```json\n{"a":1}\n```')).toBe('{"a":1}');
    expect(extractJsonObject('```\n{"a":1}\n```')).toBe('{"a":1}');
    expect(extractJsonObject('Here it is: {"a":{"b":2}} Done.')).toBe('{"a":{"b":2}}');
    expect(extractJsonObject('no json here')).toBe('no json here');
  });
});

describe('contractInstructions tag format', () => {
  it('asks for real Stack Exchange tags and DEV-safe tags, and adds nothing for inline hashtags', () => {
    expect(contractInstructions(platformContract('unix-linux-stackexchange'))).toContain('Tag format: English tags that already exist on this Stack Exchange site');
    expect(contractInstructions(platformContract('devto'))).toContain('Tag format: lowercase letters and digits only');
    expect(contractInstructions(platformContract('bluesky'))).not.toContain('Tag format');
  });

  it('gives the body budget left by the source line and how links count', () => {
    const x = contractInstructions(platformContract('x', { defaultLanguage: 'en' }), 'https://vpsttt.vn/a');
    expect(x).toContain('The system adds the line "Source: https://vpsttt.vn/a" below the body (33 characters with the blank line before it), so the body with its hashtags gets at most 247 characters');
    expect(x).toContain('every link, also a bare domain such as example.com, counts as 23');
    expect(contractInstructions(platformContract('bluesky'))).toMatch(/must be at most 300 characters\. Aim for about 255 characters in the body\.$/m);
  });
});
