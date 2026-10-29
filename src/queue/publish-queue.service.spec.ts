import { ModuleRef } from '@nestjs/core';
import { RabbitMqService } from './rabbitmq.service';
import { inlinePublishWorkerEnabled, PublishQueueService } from './publish-queue.service';

describe('PublishQueueService', () => {
  const originalInline = process.env.INLINE_PUBLISH_WORKER;
  const originalEnv = process.env.NODE_ENV;
  afterEach(() => {
    process.env.INLINE_PUBLISH_WORKER = originalInline;
    process.env.NODE_ENV = originalEnv;
  });

  it('uses a platform routing key and durable job-shaped message', async () => {
    const publishMock: jest.MockedFunction<RabbitMqService['publish']> = jest.fn();
    publishMock.mockResolvedValue(undefined);
    const rabbit = { publish: publishMock } as unknown as RabbitMqService;
    const service = new PublishQueueService(rabbit, {} as ModuleRef);
    await service.enqueue('job-1', 'instagram');
    expect(publishMock).toHaveBeenCalledWith(
      'publish.instagram',
      expect.objectContaining({ type: 'publish.job', jobId: 'job-1', platform: 'instagram' }),
    );
  });

  it('runs the worker in-process only when the demo mode is on outside production', async () => {
    process.env.INLINE_PUBLISH_WORKER = 'true';
    process.env.NODE_ENV = 'development';
    const processJob = jest.fn().mockResolvedValue(undefined);
    const publish = jest.fn();
    const service = new PublishQueueService({ publish } as unknown as RabbitMqService, { get: () => ({ process: processJob }) } as unknown as ModuleRef);
    await service.enqueue('job-2', 'voz-forums');
    await new Promise((resolve) => setImmediate(resolve));
    expect(processJob).toHaveBeenCalledWith('job-2');
    expect(publish).not.toHaveBeenCalled();

    process.env.NODE_ENV = 'production';
    expect(inlinePublishWorkerEnabled()).toBe(false);
  });
});
