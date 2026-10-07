import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { createOpenApiDocument } from '../src/swagger';

async function exportSchema(): Promise<void> {
  process.env.SKIP_DATABASE_CONNECT = 'true';
  process.env.SKIP_INFRA_CONNECT = 'true';
  process.env.NODE_ENV ??= 'test';
  const app = await NestFactory.create(AppModule, { logger: ['error'], abortOnError: false });
  app.setGlobalPrefix('api/v1', { exclude: ['health', 'ready'] });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  const document = createOpenApiDocument(app);
  await writeFile(join(process.cwd(), 'openapi.json'), `${JSON.stringify(document, null, 2)}\n`, 'utf8');
  await app.close();
}

void exportSchema().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
