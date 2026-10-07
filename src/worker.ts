import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { WorkerModule } from './workers/worker.module';
import { loggerLevels } from './config/logger';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(WorkerModule, {
    bufferLogs: true,
    logger: loggerLevels(),
  });
  app.enableShutdownHooks();
  Logger.log('Social Publisher worker started', 'Bootstrap');
}

void bootstrap();
