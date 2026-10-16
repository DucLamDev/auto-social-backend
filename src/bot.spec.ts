import { NestFactory } from '@nestjs/core';
import { runBot } from './bot';
import { PrismaService } from './database/prisma.service';
import { ConnectorAccountsService } from './connectors/connector-accounts.service';
import { BrowserAutomationService } from './connectors/browser/browser-automation.service';
import { BrowserRecipeRegistry } from './connectors/browser/browser-recipe.registry';

let mockBootstrapRecovery: string | undefined;
jest.mock('./workers/worker.module', () => {
  mockBootstrapRecovery = process.env.BROWSER_AUTH_RECOVERY_ENABLED;
  return { WorkerModule: class WorkerModule {} };
});
jest.mock('@nestjs/core', () => ({ NestFactory: { createApplicationContext: jest.fn() } }));
jest.mock('node:fs/promises', () => ({
  readFile: jest.fn().mockResolvedValue('{"body":"Test post","title":"Title","idempotencyKey":"test-job"}'),
  mkdir: jest.fn().mockResolvedValue(undefined), writeFile: jest.fn().mockResolvedValue(undefined),
  open: jest.fn().mockResolvedValue({ writeFile: jest.fn().mockResolvedValue(undefined),
    sync: jest.fn().mockResolvedValue(undefined), close: jest.fn().mockResolvedValue(undefined) }),
}));

describe('Bot sequential runner (mock integration)', () => {
  const row = (id: string) => ({ id, name: id, username: id, enabled: true, status: 'CONNECTED', platform: { slug: 'voz-forums' } });
  const close = jest.fn().mockResolvedValue(undefined);
  const findMany = jest.fn().mockResolvedValue([row('a01'), row('a02')]);
  const load = jest.fn((id: string) => Promise.resolve({ enabled: true, platformEnabled: true,
    account: { id, settings: { browserRecipe: 'voz-xenforo' }, credentials: {} } }));
  const inspect = jest.fn();
  const publish = jest.fn().mockResolvedValue({ status: 'PUBLISHED', externalId: 'post-1' });
  beforeEach(() => {
    process.exitCode = 0;
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    jest.spyOn(console, 'table').mockImplementation(() => undefined);
    (NestFactory.createApplicationContext as jest.Mock).mockResolvedValue({ close,
      get: (token: unknown) => token === PrismaService ? { platformAccount: { findMany } }
        : token === ConnectorAccountsService ? { load }
        : token === BrowserAutomationService ? { inspect, publish, authManager: { accounts: new Map() } }
        : token === BrowserRecipeRegistry ? { get: () => ({ key: 'voz-xenforo' }) } : undefined,
    });
  });
  afterEach(() => { jest.restoreAllMocks(); jest.clearAllMocks(); process.exitCode = 0; });
  it('sets CLI recovery before the application config module is evaluated', async () => {
    process.env.BROWSER_AUTH_RECOVERY_ENABLED = 'false';
    await runBot(['accounts']);
    expect(mockBootstrapRecovery).toBe('true');
    expect(close).toHaveBeenCalled();
  });
  it('skips the blocked account and publishes the next account sequentially', async () => {
    inspect.mockResolvedValueOnce({ ready: false, challenge: { kind: 'CAPTCHA_REQUIRED' } })
      .mockResolvedValueOnce({ ready: true });
    await runBot(['publish-all', './post.json', '--skip-auth-blocked']);
    expect(load.mock.calls).toEqual([['a01'], ['a02'], ['a02']]);
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({ id: 'a02' }),
      expect.objectContaining({ body: 'Test post' }), expect.any(Object), expect.objectContaining({ skipAuthBlocked: true }));
    expect(close).toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });
  it('awaits each recovery before moving to the next account', async () => {
    let finish: ((value: { ready: boolean }) => void) | undefined;
    inspect.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; })).mockResolvedValueOnce({ ready: true });
    const run = runBot(['publish-all', './post.json']);
    for (let index = 0; index < 20 && !finish; index++) await Promise.resolve();
    expect(load).toHaveBeenCalledTimes(1);
    expect(publish).not.toHaveBeenCalled();
    finish!({ ready: true });
    await run;
    expect(load).toHaveBeenCalledTimes(4);
    expect(publish).toHaveBeenCalledTimes(2);
  });
  it('auth-check never prompts or publishes', async () => {
    inspect.mockResolvedValueOnce({ ready: false, challenge: { kind: 'TWO_FACTOR_REQUIRED' } });
    await runBot(['auth-check', 'voz-forums', 'a01']);
    expect(inspect).toHaveBeenCalledWith(expect.any(Object), expect.any(Object), expect.objectContaining({ skipAuthBlocked: true }));
    expect(publish).not.toHaveBeenCalled();
  });
});
