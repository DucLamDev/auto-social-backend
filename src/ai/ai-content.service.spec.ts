import { HttpStatus } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApplicationException, ErrorCode } from '../common/exceptions/application.exception';
import { PrismaService } from '../database/prisma.service';
import { AiProvider } from './ai-provider';
import { AiContentService } from './ai-content.service';
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
