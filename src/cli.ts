import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ConnectorAccountsService } from './connectors/connector-accounts.service';
import { WorkerModule } from './workers/worker.module';
import { PrismaService } from './database/prisma.service';
import { createInterface } from 'node:readline';
import { stdin, stdout } from 'node:process';
import { BrowserLoginCaptureService } from './connectors/browser/browser-login-capture.service';

function waitForEnter(signal: AbortSignal): Promise<void> {
  const terminal = createInterface({ input: stdin, output: stdout });
  console.log('Đăng nhập trong cửa sổ Chromium. Không nhập mật khẩu vào terminal này.');
  console.log('Khi trình soạn thảo đã mở, nhấn Enter tại đây (hệ thống cũng tự nhận biết editor).');
  return new Promise((resolve) => {
    const finish = () => {
      terminal.close();
      resolve();
    };
    signal.addEventListener('abort', finish, { once: true });
    terminal.once('line', () => {
      signal.removeEventListener('abort', finish);
      finish();
    });
  });
}

async function main(): Promise<void> {
  // The CLI needs Redis for the same distributed per-account lock as workers,
  // but it must not start the RabbitMQ publish consumer.
  process.env.SKIP_RABBITMQ_CONNECT = 'true';
  const app = await NestFactory.createApplicationContext(WorkerModule, { logger: false });
  try {
    const [command, argument] = process.argv.slice(2);
    if (command === 'platform:list') {
      const rows = await app.get(PrismaService).platform.findMany({ select: { slug: true, name: true, mode: true, availability: true, enabled: true }, orderBy: { name: 'asc' } });
      console.table(rows);
    } else if (command === 'account:test' && argument) {
      console.log(await app.get(ConnectorAccountsService).test(argument));
    } else if (command === 'browser:login' && argument) {
      console.log(await app.get(BrowserLoginCaptureService).capture(argument, waitForEnter));
    } else {
      console.log('Usage: pnpm cli platform:list | pnpm cli account:test <uuid> | pnpm browser:login <uuid>');
      process.exitCode = 1;
    }
  } finally {
    await app.close();
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'CLI command failed');
  process.exitCode = 1;
});
