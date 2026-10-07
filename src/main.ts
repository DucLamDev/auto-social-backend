import 'reflect-metadata';
import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { loggerLevels } from './config/logger';
import { GlobalExceptionFilter } from './common/filters/global-exception.filter';
import { ApiResponseInterceptor } from './common/interceptors/api-response.interceptor';
import { RequestContextInterceptor } from './common/interceptors/request-context.interceptor';
import { setupSwagger } from './swagger';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bufferLogs: true,
    logger: loggerLevels(),
  });
  app.setGlobalPrefix('api/v1', { exclude: ['health', 'ready'] });
  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(cookieParser());
  app.enableCors({
    origin: (process.env.FRONTEND_URL ?? 'http://localhost:3000').split(',').map((value) => value.trim()),
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['authorization', 'content-type', 'x-request-id'],
  });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  app.useGlobalInterceptors(new RequestContextInterceptor(), new ApiResponseInterceptor());
  app.useGlobalFilters(new GlobalExceptionFilter());
  setupSwagger(app);
  app.enableShutdownHooks();
  if (process.env.TRUST_PROXY === 'true') app.set('trust proxy', 1);
  const port = Number(process.env.PORT ?? 3001);
  await app.listen(port, '0.0.0.0');
  Logger.log(`Social Publisher API listening on ${port}`, 'Bootstrap');
}

void bootstrap();
