import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Server } from 'node:http';
import request from 'supertest';
import { ApiResponseInterceptor } from '../src/common/interceptors/api-response.interceptor';
import { PrismaService } from '../src/database/prisma.service';
import { HealthController } from '../src/health/health.controller';
import { RabbitMqService } from '../src/queue/rabbitmq.service';
import { RedisService } from '../src/queue/redis.service';

describe('Health endpoints (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [
        { provide: PrismaService, useValue: { $queryRaw: jest.fn().mockResolvedValue([{ value: 1 }]) } },
        { provide: RedisService, useValue: { ping: jest.fn().mockResolvedValue(true) } },
        { provide: RabbitMqService, useValue: { ping: jest.fn().mockResolvedValue(true) } },
      ],
    }).compile();
    app = module.createNestApplication();
    app.useGlobalInterceptors(new ApiResponseInterceptor());
    await app.init();
  });

  afterAll(async () => app.close());

  it('serves liveness without infrastructure access', async () => {
    const response = await request(app.getHttpServer() as Server).get('/health').expect(200);
    expect(response.body as unknown).toMatchObject({
      success: true,
      data: { status: 'ok', service: 'social-publisher-api' },
    });
  });

  it('reports all readiness dependencies', async () => {
    const response = await request(app.getHttpServer() as Server).get('/ready').expect(200);
    expect(response.body as unknown).toMatchObject({
      success: true,
      data: { status: 'ready', database: 'up', redis: 'up', rabbitmq: 'up' },
    });
  });
});
