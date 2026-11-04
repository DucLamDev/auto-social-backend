import { ConfigService } from '@nestjs/config';
import { AiContentService } from '../../ai/ai-content.service';
import { ApplicationException, ErrorCode } from '../../common/exceptions/application.exception';
import { PrismaService } from '../../database/prisma.service';
import { RedisService } from '../../queue/redis.service';
import { FormFillRequestDto } from './form-fill.dto';
import { ExtensionFormFillService } from './form-fill.service';

const device = { id: 'dev-1', ownerId: 'owner-1', name: 'Chrome A' };
const settings = { delivery: 'extension', extensionEngine: 'lemmy', extensionTargetUrl: 'https://lemmy.world/create_post', extensionAutoSubmit: true, extensionTags: ['Linux'], extensionFlair: '' };
const job = {
  id: 'job-1',
  platformAccount: { settings, platform: { name: 'Lemmy.world', slug: 'lemmy-world' } },
  target: { contentVariant: { title: 'Self-hosting a mail server on a small VPS', body: 'This post explains how to run a small mail server on a cheap VPS, with DNS records and spam checks.', hashtags: ['#selfhosted', 'linux'], content: { canonicalUrl: null } } },
};
const dto: FormFillRequestDto = {
  url: 'https://lemmy.world/create_post',
  controls: [
    { index: 0, kind: 'select', tag: 'select', id: 'post-language', label: 'Language', required: false, invalid: false,
      options: [{ value: '0', label: 'Undetermined' }, { value: '37', label: 'English' }], selector: '#post-language' },
    { index: 1, kind: 'combobox', tag: 'div', label: 'Community', required: true, invalid: true,
      options: [{ value: 'selfhosted@lemmy.world', label: 'selfhosted@lemmy.world' }, { value: 'memes@lemmy.world', label: 'memes@lemmy.world' }], selector: 'div.community' },
    { index: 2, kind: 'text', tag: 'textarea', id: 'post-title', label: 'Title', required: true, invalid: false, selector: '#post-title' },
  ],
};

function setup(options: { enabled?: boolean; aiAnswer?: unknown; aiError?: unknown; formFills?: number; rateAllowed?: boolean } = {}) {
  const rows = new Map<string, Record<string, unknown>>();
  const prisma = {
    publishJob: { findFirst: jest.fn().mockResolvedValue(job) },
    extensionUiHint: {
      count: jest.fn().mockResolvedValue(options.formFills ?? 0),
      create: jest.fn((args: { data: Record<string, unknown> }) => { rows.set('hint-1', { id: 'hint-1', ...args.data, createdAt: new Date() }); return Promise.resolve({ id: 'hint-1' }); }),
      update: jest.fn((args: { where: { id: string }; data: Record<string, unknown> }) => { rows.set(args.where.id, { ...rows.get(args.where.id), ...args.data }); return Promise.resolve({}); }),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      findFirst: jest.fn((args: { where: { id: string } }) => Promise.resolve(rows.get(args.where.id) ?? null)),
    },
  };
  const ai = { generateStructured: options.aiError ? jest.fn().mockRejectedValue(options.aiError) : jest.fn().mockResolvedValue(options.aiAnswer ?? {
    actions: [{ index: 0, action: 'select', value: 'English' }, { index: 1, action: 'select', value: 'selfhosted@lemmy.world' }, { index: 2, action: 'type', value: 'New title' }],
    confidence: 0.85, reason: 'Language and community',
  }) };
  const config = { get: jest.fn((key: string, fallback?: unknown) => ({ EXTENSION_AI_FORM_FILL_ENABLED: options.enabled ?? true, EXTENSION_UI_HINT_MIN_CONFIDENCE: 0.6, EXTENSION_UI_HINT_PROVIDER: 'vpsttt' } as Record<string, unknown>)[key] ?? fallback) };
  const redis = { consumeRateLimit: jest.fn().mockResolvedValue({ allowed: options.rateAllowed ?? true, remaining: 10 }) };
  const service = new ExtensionFormFillService(prisma as unknown as PrismaService, config as unknown as ConfigService, ai as unknown as AiContentService, redis as unknown as RedisService);
  return { service, prisma, ai, redis, rows };
}

describe('ExtensionFormFillService', () => {
  it('is unavailable (404) while the feature flag is off', async () => {
    const { service, prisma } = setup({ enabled: false });
    await expect(service.request(device, 'job-1', dto)).rejects.toMatchObject({ status: 404 });
    await expect(service.get(device, 'job-1', 'hint-1')).rejects.toMatchObject({ status: 404 });
    expect(prisma.publishJob.findFirst).not.toHaveBeenCalled();
  });

  it('answers with checked actions for the controls the post needs, never the title', async () => {
    const { service, prisma, ai } = setup();
    await expect(service.request(device, 'job-1', dto)).resolves.toEqual({
      hintId: 'hint-1', status: 'READY', confidence: 0.85,
      actions: [
        { index: 0, selector: '#post-language', action: 'select', value: '37' },
        { index: 1, selector: 'div.community', action: 'select', value: 'selfhosted@lemmy.world' },
      ],
    });
    expect(prisma.publishJob.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ id: 'job-1', extensionClaimDeviceId: 'dev-1', lastErrorCode: null, lockedAt: { not: null } }) as unknown }));
    expect(prisma.extensionUiHint.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ missing: ['form'], engine: 'lemmy', origin: 'https://lemmy.world', path: '/create_post' }) as unknown }));
    const [, , input, provider] = ai.generateStructured.mock.calls[0] as [unknown, string, string, string];
    expect(provider).toBe('vpsttt');
    const sent = JSON.parse(input) as { engine: string; path: string; post: Record<string, unknown>; controls: Array<Record<string, unknown>> };
    // Post facts come from the job; the body and the selectors never leave the server.
    expect(sent).toMatchObject({ engine: 'lemmy', path: '/create_post', post: { platform: 'Lemmy.world', language: 'English', title: job.target.contentVariant.title, tags: ['Linux', 'selfhosted'], community: null, flair: null } });
    expect(input).not.toContain('#post-language');
    expect(input).not.toContain('mail server on a cheap VPS');
    expect(sent.controls[2]).toMatchObject({ protected: true });
  });

  it('only accepts a page on the task destination and a task this device holds', async () => {
    const { service, prisma } = setup();
    await expect(service.request(device, 'job-1', { ...dto, url: 'https://evil.example/create_post' })).rejects.toThrow('destination');
    prisma.publishJob.findFirst.mockResolvedValueOnce(null);
    await expect(service.request(device, 'job-1', dto)).rejects.toThrow('not found');
  });

  it('limits a task to two form fills, counted apart from UI hints, and shares the hourly device budget', async () => {
    const { service, prisma } = setup({ formFills: 2 });
    await expect(service.request(device, 'job-1', dto)).rejects.toMatchObject({ status: 429 });
    expect(prisma.extensionUiHint.count).toHaveBeenCalledWith({ where: { publishJobId: 'job-1', missing: { has: 'form' } } });
    const limited = setup({ rateAllowed: false });
    await expect(limited.service.request(device, 'job-1', dto)).rejects.toMatchObject({ status: 429 });
    expect(limited.redis.consumeRateLimit).toHaveBeenCalledWith('rate_limit:ui-hint:dev-1', 20, 3_600);
  });

  it('returns no action, with LOW_CONFIDENCE, when the AI is unsure', async () => {
    const { service } = setup({ aiAnswer: { actions: [{ index: 0, action: 'select', value: '37' }], confidence: 0.3, reason: 'unsure' } });
    await expect(service.request(device, 'job-1', dto)).resolves.toEqual({ hintId: 'hint-1', status: 'READY', actions: [], confidence: 0.3, errorCode: 'LOW_CONFIDENCE' });
  });

  it('records an AI failure on the row instead of failing the extension request', async () => {
    const { service } = setup({ aiError: new ApplicationException(ErrorCode.PLATFORM_RATE_LIMITED, 'VPSTTT AI rate limit was reached') });
    await expect(service.request(device, 'job-1', dto)).resolves.toEqual({ hintId: 'hint-1', status: 'FAILED', errorCode: ErrorCode.PLATFORM_RATE_LIMITED });
  });

  it('reads only form-fill rows of this device and expires one that never finished', async () => {
    const { service, rows, prisma } = setup();
    rows.set('old', { id: 'old', status: 'RUNNING', createdAt: new Date(Date.now() - 300_000) });
    await expect(service.get(device, 'job-1', 'old')).resolves.toEqual({ hintId: 'old', status: 'FAILED', errorCode: 'TIMEOUT' });
    expect(prisma.extensionUiHint.updateMany).toHaveBeenCalledWith({ where: { id: 'old', status: 'RUNNING' }, data: expect.objectContaining({ status: 'FAILED', errorCode: 'TIMEOUT' }) as unknown });
    expect(prisma.extensionUiHint.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'old', publishJobId: 'job-1', deviceId: 'dev-1', ownerId: 'owner-1', missing: { has: 'form' } } }));
    rows.set('busy', { id: 'busy', status: 'RUNNING', createdAt: new Date() });
    await expect(service.get(device, 'job-1', 'busy')).resolves.toEqual({ hintId: 'busy', status: 'RUNNING' });
    await expect(service.get(device, 'job-1', 'missing')).rejects.toThrow('not found');
  });
});
