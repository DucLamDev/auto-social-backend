import { ConfigService } from '@nestjs/config';
import { AiContentService } from '../../ai/ai-content.service';
import { ApplicationException, ErrorCode } from '../../common/exceptions/application.exception';
import { PrismaService } from '../../database/prisma.service';
import { RedisService } from '../../queue/redis.service';
import { UiHintRequestDto } from './ui-hint.dto';
import { ExtensionUiRecoveryService } from './ui-recovery.service';

const device = { id: 'dev-1', ownerId: 'owner-1', name: 'Chrome A' };
const settings = { delivery: 'extension', extensionEngine: 'discourse', extensionTargetUrl: 'https://community.nginx.org/new-topic', extensionAutoSubmit: true };
const dto: UiHintRequestDto = {
  missing: ['body', 'submit'],
  url: 'https://community.nginx.org/new-topic?category=x',
  candidates: [
    { index: 0, kind: 'contenteditable', tag: 'div', label: 'Nội dung, liên hệ an@example.com', inDialog: true, inForm: true, disabled: false, selector: 'div.editor' },
    { index: 1, kind: 'button', tag: 'button', text: 'Create Topic', inDialog: true, inForm: true, disabled: false, selector: 'button.create' },
  ],
};

function setup(options: { enabled?: boolean; aiAnswer?: unknown; aiError?: unknown; hints?: number; suggestionStatus?: string } = {}) {
  const hintRows = new Map<string, Record<string, unknown>>();
  const prisma = {
    publishJob: { findFirst: jest.fn().mockResolvedValue({ id: 'job-1', platformAccount: { settings } }) },
    extensionUiHint: {
      count: jest.fn().mockResolvedValue(options.hints ?? 0),
      create: jest.fn((args: { data: Record<string, unknown> }) => { hintRows.set('hint-1', { id: 'hint-1', ...args.data, createdAt: new Date() }); return Promise.resolve({ id: 'hint-1' }); }),
      update: jest.fn((args: { where: { id: string }; data: Record<string, unknown> }) => { hintRows.set(args.where.id, { ...hintRows.get(args.where.id), ...args.data }); return Promise.resolve({}); }),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      findFirst: jest.fn((args: { where: { id: string } }) => Promise.resolve(hintRows.get(args.where.id) ?? null)),
    },
    extensionSelectorSuggestion: { upsert: jest.fn((args: { create: { field: string } }) => Promise.resolve({ id: `s-${args.create.field}`, status: options.suggestionStatus ?? 'PENDING' })) },
  };
  const ai = { generateStructured: options.aiError ? jest.fn().mockRejectedValue(options.aiError) : jest.fn().mockResolvedValue(options.aiAnswer ?? { title: null, body: 0, submit: 1, opener: null, confidence: 0.92, reason: 'Composer dialog' }) };
  const config = { get: jest.fn((key: string, fallback?: unknown) => ({ EXTENSION_UI_RECOVERY_ENABLED: options.enabled ?? true, EXTENSION_UI_HINT_MIN_CONFIDENCE: 0.6 } as Record<string, unknown>)[key] ?? fallback) };
  const redis = { consumeRateLimit: jest.fn().mockResolvedValue({ allowed: true, remaining: 10 }) };
  const service = new ExtensionUiRecoveryService(prisma as unknown as PrismaService, config as unknown as ConfigService, ai as unknown as AiContentService, redis as unknown as RedisService);
  return { service, prisma, ai, redis, hintRows };
}

describe('ExtensionUiRecoveryService', () => {
  it('is unavailable while the feature flag is off', async () => {
    const { service, prisma } = setup({ enabled: false });
    await expect(service.request(device, 'job-1', dto)).rejects.toThrow('disabled');
    expect(prisma.publishJob.findFirst).not.toHaveBeenCalled();
  });

  it('answers with the selectors of the AI picks, as unapproved suggestions', async () => {
    const { service, prisma, ai } = setup();
    const view = await service.request(device, 'job-1', dto);
    expect(view).toEqual({
      hintId: 'hint-1', status: 'READY', confidence: 0.92,
      selectors: { body: { selector: 'div.editor', approved: false, suggestionId: 's-body' }, submit: { selector: 'button.create', approved: false, suggestionId: 's-submit' } },
    });
    expect(prisma.publishJob.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ id: 'job-1', extensionClaimDeviceId: 'dev-1', lastErrorCode: null }) as unknown }));
    const [, , input] = (ai.generateStructured.mock.calls[0] as [unknown, string, string]);
    // Only sanitized descriptions reach the AI: no selectors, no emails, no post text.
    expect(input).not.toContain('div.editor');
    expect(input).not.toContain('an@example.com');
    expect(input).toContain('[email]');
  });

  it('only accepts pages on the task destination', async () => {
    const { service } = setup();
    await expect(service.request(device, 'job-1', { ...dto, url: 'https://evil.example/new-topic' })).rejects.toThrow('destination');
  });

  it('limits a task to two hints, not counting AI form fills', async () => {
    const { service, prisma } = setup({ hints: 2 });
    await expect(service.request(device, 'job-1', dto)).rejects.toThrow('already used');
    expect(prisma.extensionUiHint.count).toHaveBeenCalledWith({ where: { publishJobId: 'job-1', NOT: { missing: { hasSome: ['form', 'auth'] } } } });
  });

  it('refuses a task that this device does not hold', async () => {
    const { service, prisma } = setup();
    prisma.publishJob.findFirst.mockResolvedValueOnce(null);
    await expect(service.request(device, 'job-1', dto)).rejects.toThrow('not found');
  });

  it('never offers a selector an operator rejected, and marks approved ones', async () => {
    const rejected = await setup({ suggestionStatus: 'REJECTED' }).service.request(device, 'job-1', dto);
    expect(rejected.selectors).toEqual({});
    const approved = await setup({ suggestionStatus: 'APPROVED' }).service.request(device, 'job-1', dto);
    expect(approved.selectors?.submit?.approved).toBe(true);
  });

  it('drops a pick of the wrong kind and an answer below the confidence threshold', async () => {
    const wrongKind = await setup({ aiAnswer: { title: null, body: 1, submit: 0, opener: null, confidence: 0.9, reason: 'x' } }).service.request(device, 'job-1', dto);
    expect(wrongKind.selectors).toEqual({});
    const unsure = await setup({ aiAnswer: { title: null, body: 0, submit: 1, opener: null, confidence: 0.2, reason: 'x' } }).service.request(device, 'job-1', dto);
    expect(unsure.selectors).toEqual({});
  });

  it('records an AI failure on the hint instead of failing the extension request', async () => {
    const { service } = setup({ aiError: new ApplicationException(ErrorCode.PLATFORM_RATE_LIMITED, 'VPSTTT AI rate limit was reached') });
    await expect(service.request(device, 'job-1', dto)).resolves.toEqual({ hintId: 'hint-1', status: 'FAILED', errorCode: ErrorCode.PLATFORM_RATE_LIMITED });
  });

  it('expires a hint that never finished', async () => {
    const { service, hintRows, prisma } = setup();
    hintRows.set('old', { id: 'old', status: 'RUNNING', createdAt: new Date(Date.now() - 300_000) });
    await expect(service.get(device, 'job-1', 'old')).resolves.toEqual({ hintId: 'old', status: 'FAILED', errorCode: 'TIMEOUT' });
    expect(prisma.extensionUiHint.updateMany).toHaveBeenCalled();
  });
});
