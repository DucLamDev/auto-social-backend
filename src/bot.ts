import 'reflect-metadata';
import { readFile, mkdir, open, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { NestFactory } from '@nestjs/core';
import { AccountStatus } from '@prisma/client';
import { z } from 'zod';
import { PrismaService } from './database/prisma.service';
import { ConnectorAccountsService } from './connectors/connector-accounts.service';
import { BrowserAutomationService } from './connectors/browser/browser-automation.service';
import { BrowserRecipeRegistry } from './connectors/browser/browser-recipe.registry';
import type { ConnectorAccount } from './connectors/core/connector.types';
import { BrowserRecipePolicyError } from './connectors/browser/browser-recipe.registry';

const postSchema = z.object({
  title: z.string().min(1).optional(), body: z.string().min(1),
  summary: z.string().optional(), hashtags: z.array(z.string()).optional(),
  canonicalUrl: z.url().optional(), idempotencyKey: z.string().min(1).max(256),
  media: z.array(z.object({ type: z.enum(['image', 'video', 'document']), url: z.url(), altText: z.string().optional() })).optional(),
}).strict();

export async function runBot(args: string[]): Promise<void> {
  const [command, platform, accountName, file] = args.filter((arg) => arg !== '--skip-auth-blocked');
  const skipAuthBlocked = args.includes('--skip-auth-blocked');
  if (!command || !['login', 'auth-check', 'post', 'publish-all', 'accounts'].includes(command)
    || (['login', 'auth-check', 'post'].includes(command) && (!platform || !accountName))
    || (command === 'post' && !file) || (command === 'publish-all' && !platform)) {
    throw new Error('Dùng: pnpm bot login|auth-check <platform> <account>; post <platform> <account> <post.json>; publish-all <post.json> [--skip-auth-blocked]; accounts');
  }
  const postPath = command === 'post' ? file : command === 'publish-all' ? platform : undefined;
  const parsedPost = postPath ? postSchema.safeParse(JSON.parse(await readFile(resolve(postPath), 'utf8')) as unknown) : undefined;
  if (parsedPost && !parsedPost.success) throw new Error('post.json không hợp lệ; cần body và idempotencyKey, cùng các trường PostPayload được hỗ trợ');
  process.env.SKIP_RABBITMQ_CONNECT = 'true';
  // The interactive CLI uses dedicated persistent profiles; unattended workers opt in separately.
  process.env.BROWSER_AUTH_RECOVERY_ENABLED = 'true';
  // Load ConfigModule only after CLI overrides are set; validated env takes
  // precedence over later process.env mutations in Nest ConfigService.
  const { WorkerModule } = await import('./workers/worker.module');
  const app = await NestFactory.createApplicationContext(WorkerModule, { logger: false });
  const abort = new AbortController();
  const cancel = () => abort.abort();
  process.once('SIGINT', cancel);
  process.once('SIGTERM', cancel);
  let failed = false;
  try {
    const prisma = app.get(PrismaService);
    const loader = app.get(ConnectorAccountsService);
    const browser = app.get(BrowserAutomationService);
    const registry = app.get(BrowserRecipeRegistry);
    const rows = await prisma.platformAccount.findMany({
      where: { platform: { connectorKey: 'browser-assisted' },
        ...(command === 'publish-all' ? { enabled: true, platform: { connectorKey: 'browser-assisted', enabled: true } } : {}),
      },
      select: { id: true, name: true, username: true, enabled: true, status: true,
        platform: { select: { slug: true } } }, orderBy: { name: 'asc' },
    });
    if (command === 'accounts') {
      console.table(rows.map((row) => ({ platform: row.platform.slug, account: row.name,
        id: row.id, enabled: row.enabled, savedState: row.status })));
      return;
    }
    const selected = command === 'publish-all' ? rows
      : rows.filter((row) => row.platform.slug === platform
        && [row.id, row.name, row.username].includes(accountName ?? ''));
    if (command !== 'publish-all' && selected.length !== 1) throw new Error('Account không có hoặc tên bị trùng; dùng UUID từ pnpm bot accounts');
    if (selected.length === 0) throw new Error('Không có account browser-assisted được bật');
    for (const row of selected) {
      if (abort.signal.aborted) break;
      const identity = `${row.platform.slug}/${row.name}`;
      try {
        const loaded = command === 'login' ? await loader.loadForBrowserLoginCapture(row.id) : await loader.load(row.id);
        if (!loaded.enabled || !loaded.platformEnabled) throw new Error('Account hoặc platform đã bị tắt');
        const account: ConnectorAccount = loaded.account;
        const recipeKey = account.settings.browserRecipe;
        if (typeof recipeKey !== 'string') throw new Error('Account chưa cấu hình browserRecipe');
        const recipe = registry.get(recipeKey);
        const options = { skipAuthBlocked, signal: abort.signal };
        if (command === 'login') {
          console.log(`[${identity}] Mở Chromium persistent. Đăng nhập thủ công trong trình duyệt.`);
          const result = await browser.login(account, recipe, options);
          if (result.ready) {
            const connected = await prisma.platformAccount.updateMany({ where: { id: row.id, enabled: true, platform: { enabled: true } },
              data: { status: AccountStatus.CONNECTED, lastTestedAt: new Date() } });
            if (connected.count !== 1) throw new Error('Account đã bị tắt trong khi xác thực');
            console.log(`[${identity}] ✓ Xác thực thành công; session đã lưu.`);
          } else { failed = true; console.log(`[${identity}] AUTH_REQUIRED: ${result.message}`); }
        } else if (command === 'auth-check') {
          const result = await browser.inspect(account, recipe, { ...options, skipAuthBlocked: true });
          console.log(`[${identity}] ${result.ready ? 'READY' : result.challenge?.kind ?? 'AUTH_REQUIRED'}`);
          if (!result.ready) failed = true;
        } else if (parsedPost?.success) {
          const auth = await browser.inspect(account, recipe, { ...options, requireSessionSave: true });
          if (!auth.ready) {
            failed = true;
            console.log(`[${identity}] AUTH_REQUIRED: ${auth.challenge?.kind ?? 'UNKNOWN_AUTH_CHALLENGE'}`);
            continue;
          }
          const refreshed = await loader.load(row.id);
          if (!refreshed.enabled || !refreshed.platformEnabled) throw new Error('Account hoặc platform đã bị tắt');
          // Local durable claim also protects CLI reruns after a lost publish response.
          // No credentials, content or session data are written into this journal.
          const directory = resolve('logs/bot-publish');
          await mkdir(directory, { recursive: true, mode: 0o700 });
          const key = createHash('sha256').update(`${row.id}\0${parsedPost.data.idempotencyKey}`).digest('hex');
          const journal = join(directory, `${key}.json`);
          const claim = await open(journal, 'wx', 0o600).catch(() => undefined);
          if (!claim) throw new Error('Idempotency key đã được dùng hoặc journal không ghi được; kiểm tra kết quả trước khi thử lại');
          try {
            await claim.writeFile(JSON.stringify({ status: 'STARTED', at: new Date().toISOString() }));
            await claim.sync();
          } finally { await claim.close(); }
          const result = await browser.publish(refreshed.account, parsedPost.data, recipe, options);
          await writeFile(journal, JSON.stringify({ status: result.status,
            ...(result.status === 'NEEDS_ACTION' ? { reason: result.reason } : {}), at: new Date().toISOString() }), { mode: 0o600 });
          console.log(`[${identity}] ${result.status === 'PUBLISHED' ? 'PUBLISHED' : `NEEDS_ACTION: ${result.reason}`}`);
          if (result.status !== 'PUBLISHED') failed = true;
        }
      } catch (error) {
        failed = true;
        // Never print raw Playwright/Prisma errors, since they can contain a fill() value or credentials.
        console.log(`[${identity}] FAILED${error instanceof BrowserRecipePolicyError ? ': recipe chưa được phép sử dụng' : ''}`);
      }
      console.table([...browser.authManager.accounts].map(([account, state]) => ({ account, state })));
    }
    if (failed || abort.signal.aborted) process.exitCode = abort.signal.aborted ? 130 : 1;
  } finally {
    process.removeListener('SIGINT', cancel);
    process.removeListener('SIGTERM', cancel);
    await app.close();
  }
}

if (require.main === module) {
  void runBot(process.argv.slice(2)).catch(() => {
    console.error('Bot dừng an toàn. Kiểm tra cú pháp lệnh, post.json, runtime và cấu hình dịch vụ trong README.');
    process.exitCode = 1;
  });
}
