import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ConnectorAccountsService } from './connectors/connector-accounts.service';
import { WorkerModule } from './workers/worker.module';
import { PrismaService } from './database/prisma.service';

async function main(): Promise<void> {
  process.env.SKIP_INFRA_CONNECT = 'true';
  const app = await NestFactory.createApplicationContext(WorkerModule, { logger: false });
  const [command, argument] = process.argv.slice(2);
  if (command === 'platform:list') {
    const rows = await app.get(PrismaService).platform.findMany({ select: { slug: true, name: true, mode: true, availability: true, enabled: true }, orderBy: { name: 'asc' } });
    console.table(rows);
  } else if (command === 'account:test' && argument) {
    console.log(await app.get(ConnectorAccountsService).test(argument));
  } else {
    console.log('Usage: pnpm cli platform:list | pnpm cli account:test <uuid>');
    process.exitCode = 1;
  }
  await app.close();
}

void main();
