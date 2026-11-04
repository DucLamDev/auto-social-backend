import { HttpStatus } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApplicationException, ErrorCode } from '../common/exceptions/application.exception';
import { PrismaService } from '../database/prisma.service';
import { AiProvider } from './ai-provider';
import { AiContentService, contractInstructions, extractJsonObject } from './ai-content.service';
import { platformContract } from '../platforms/platform-contract';
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

  function setup(create: jest.Mock) {
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
          id: 'content-1', title: 'Chiến dịch nội bộ T11', body: brief, summary: brief, canonicalUrl: null,
          status: 'DRAFT', aiAnalysis: { kind: 'brief' },
        }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      platform: {
        findMany: jest.fn().mockResolvedValue([{
          id: 'platform-1', slug: 'bluesky',
          prompts: [{ systemPrompt: 'System', userTemplate: 'Title or brief: {{title}}\nSummary: {{summary}}\n{{body}}' }],
        }]),
        findFirst: jest.fn().mockResolvedValue({
          id: 'platform-1', slug: 'bluesky',
          prompts: [{ systemPrompt: 'System', userTemplate: 'Title or brief: {{title}}\nSummary: {{summary}}\n{{body}}' }],
        }),
      },
      $transaction: jest.fn((callback: (client: typeof transaction) => Promise<unknown>) => callback(transaction)),
    };
    const config = isolatedConfig();
    const brand = { load: () => Promise.resolve({ brandName: 'VPSTTT', facts: ['VPS NVMe triển khai trong 60 giây'] }) };
    const service = new AiContentService(
      prisma as unknown as PrismaService,
      config,
      { configured: () => Promise.resolve(false), run: jest.fn() } as unknown as GeminiKeyPoolService,
      brand as unknown as BrandProfileService,
    );
    installClient(service, 'openai', { responses: { create } });
    const delay = skipGeminiRetryDelay(service);
    return { service, created, delay };
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
      .mockResolvedValueOnce(variant(tooLong))
      .mockResolvedValueOnce(reviewed({ ...passingReview, score: 6, unsupportedClaims: ['Rẻ nhất thị trường'] }))
      .mockResolvedValueOnce(variant('Ngắn nhưng nhạt.'))
      .mockResolvedValueOnce(reviewed({ ...passingReview, score: 4, issues: ['Thiếu chi tiết'] }));
    const { service, created } = setup(create);

    await service.generate('owner-1', 'content-1', ['bluesky'], 'openai');

    expect(create).toHaveBeenCalledTimes(6);
    expect(request(create, 2).input).toContain('Your previous draft was rejected');
    expect(request(create, 2).input).toMatch(/- Dài \d+\/300 ký tự/);
    expect(request(create, 2).input).toContain('- Mở bài chung chung');
    expect(request(create, 2).input).toContain('Editor scores (1-10): overall 5');
    expect(request(create, 4).input).toContain('Remove or ground this claim: Rẻ nhất thị trường');
    // The second attempt (6/10) beats the last one (4/10).
    expect(created[0]).toMatchObject({ recommended: false, body: tooLong.trim() });
    expect(created[0]!.reason).toMatch(/^Cần xem lại \(AI chấm 6\/10\): Dài \d+\/300 ký tự/);
    expect(created[0]!.reason).toContain('Thông tin chưa có căn cứ: Rẻ nhất thị trường');
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
    expect(writer.input).toContain('Revise your previous draft');
    expect(writer.input).toContain('"body":"Bản cũ nhạt"');
    expect(writer.input).toContain("Operator's instructions (highest priority, within the destination contract):\nMở bài bằng số liệu cụ thể");
    expect(writer.input).toContain("Editor's notes from the last review:\nCần xem lại (AI chấm 5/10): Mở bài chung chung");
    expect(request(create, 2).input).toContain("The operator's instructions still apply: Mở bài bằng số liệu cụ thể");
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
      revision: { previous: { title: null, body: 'Bản cũ nhạt', hashtags: ['vps'] }, instruction: '', notes: null, chosenNotes: ['Lời mở đầu hơi chung chung', 'Thêm một ví dụ cụ thể'] },
    }, 'openai');

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

  it('retries a rate-limited write once and still stores the draft when the reviewer is unavailable', async () => {
    const create = jest.fn()
      .mockRejectedValueOnce({ status: 429, message: 'raw-limit' })
      .mockResolvedValueOnce(variant(shortBody))
      .mockRejectedValueOnce(new Error('reviewer down'));
    const { service, created, delay } = setup(create);

    await service.generate('owner-1', 'content-1', ['bluesky'], 'openai');

    expect(delay).toHaveBeenCalledWith(2_000);
    expect(create).toHaveBeenCalledTimes(3);
    expect(created[0]).toMatchObject({ recommended: true, reason: 'Hợp người đọc (AI chưa chấm được)' });
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
});
