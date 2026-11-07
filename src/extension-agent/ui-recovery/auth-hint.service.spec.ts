import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AiContentService } from '../../ai/ai-content.service';
import { PrismaService } from '../../database/prisma.service';
import { RedisService } from '../../queue/redis.service';
import { ExtensionAuthHintService } from './auth-hint.service';
import { AuthHintRequestDto } from './ui-hint.dto';

const device = { id: 'dev-1', ownerId: 'owner-1', name: 'Chrome VPS' };
const session = { deviceId: 'dev-1', expectedUsername: 'vpsttt_group', profileUrl: 'https://mewe.com/vpsttt_group/posts', identitySelector: '', origin: 'https://mewe.com',
  provider: 'google', autoLogin: true, autoTotp: false, loginUrl: 'https://mewe.com', loginUsername: '' };
const dto: AuthHintRequestDto = {
  url: 'https://mewe.com/myworld',
  candidates: [
    { index: 0, kind: 'image', tag: 'img', label: 'VPSTTT Group', region: 'aside', inDialog: false, inForm: false, disabled: false, selector: 'aside img.avatar' },
    { index: 1, kind: 'link', tag: 'a', text: 'Following', region: 'main', inDialog: false, inForm: false, disabled: false, selector: 'main a.tab' },
  ],
};

function setup(options: { check?: boolean; identitySelector?: string; source?: 'ai' } = {}) {
  const rows = new Map<string, Record<string, unknown>>();
  let accountSettings: Record<string, unknown> = { extensionLoginTarget: { url: 'https://mewe.com' }, extensionEngine: 'mewe',
    extensionSession: { ...session, identitySelector: options.identitySelector ?? '', ...(options.source ? { identitySelectorSource: options.source } : {}) } };
  const prisma = {
    extensionLoginCheck: { findFirst: jest.fn(() => Promise.resolve(options.check === false ? null
      : { id: 'check-1', platformAccountId: 'acc-1', method: 'configured', account: { settings: accountSettings } })) },
    extensionUiHint: {
      count: jest.fn().mockResolvedValue(0),
      create: jest.fn((args: { data: Record<string, unknown> }) => { rows.set('hint-1', { id: 'hint-1', ...args.data, createdAt: new Date() }); return Promise.resolve({ id: 'hint-1' }); }),
      update: jest.fn((args: { where: { id: string }; data: Record<string, unknown> }) => { rows.set(args.where.id, { ...rows.get(args.where.id), ...args.data }); return Promise.resolve({}); }),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      findFirst: jest.fn((args: { where: { id: string } }) => Promise.resolve(rows.get(args.where.id) ?? null)),
    },
    platformAccount: {
      findUnique: jest.fn(() => Promise.resolve({ settings: accountSettings })),
      update: jest.fn((args: { data: { settings: Record<string, unknown> } }) => { accountSettings = args.data.settings; return Promise.resolve({}); }),
    },
  };
  const db = { ...prisma, $transaction: jest.fn((work: (tx: typeof prisma) => unknown) => work(prisma)) };
  const ai = { generateStructured: jest.fn().mockResolvedValue({ signedIn: 'yes', account: 0, accountMenu: null, login: null, confidence: 0.9, reason: 'Profile card' }) };
  const config = { get: jest.fn((key: string, fallback?: unknown) => ({ EXTENSION_UI_RECOVERY_ENABLED: true, EXTENSION_UI_HINT_MIN_CONFIDENCE: 0.6 } as Record<string, unknown>)[key] ?? fallback) };
  const redis = { consumeRateLimit: jest.fn().mockResolvedValue({ allowed: true, remaining: 10 }) };
  const service = new ExtensionAuthHintService(db as unknown as PrismaService, config as unknown as ConfigService, ai as unknown as AiContentService, redis as unknown as RedisService);
  return { service, prisma: db, ai, settings: () => accountSettings };
}
const scope = { kind: 'login-check' as const, id: 'check-1' };

describe('ExtensionAuthHintService', () => {
  it('points a running "Test" check at the account element, then keeps the confirmed element as the identity selector', async () => {
    const { service, ai, settings } = setup();
    const view = await service.request(device, scope, dto);
    expect(view).toMatchObject({ status: 'READY', signedIn: 'yes', selectors: { account: 'aside img.avatar' } });
    // The AI sees the elements and the expected handle, never selectors.
    const input = String((ai.generateStructured.mock.calls[0] as unknown[])[2]);
    expect(input).toContain('vpsttt_group');
    expect(input).not.toContain('aside img.avatar');
    await expect(service.confirm(device, scope, 'hint-1', 'main a.tab')).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.confirm(device, scope, 'hint-1', 'aside img.avatar')).resolves.toEqual({ saved: true });
    expect(settings().extensionSession).toMatchObject({ identitySelector: 'aside img.avatar', identitySelectorSource: 'ai' });
  });

  it('never overwrites a selector the operator set, and refuses another Chrome\'s check or another site', async () => {
    const operator = setup({ identitySelector: '.my-name' });
    await operator.service.request(device, scope, dto);
    await expect(operator.service.confirm(device, scope, 'hint-1', 'aside img.avatar')).resolves.toEqual({ saved: false });
    expect(operator.settings().extensionSession).toMatchObject({ identitySelector: '.my-name' });
    await expect(setup({ check: false }).service.request(device, scope, dto)).rejects.toBeInstanceOf(NotFoundException);
    await expect(setup().service.request(device, scope, { ...dto, url: 'https://evil.example/myworld' })).rejects.toBeInstanceOf(BadRequestException);
  });
});
