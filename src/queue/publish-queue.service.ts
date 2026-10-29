import { Injectable, Logger } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { RabbitMqService } from './rabbitmq.service';

/** Anything with the worker's entry point; resolved lazily to avoid a module cycle. */
interface InlinePublisher { process(jobId: string): Promise<void> }

/**
 * INLINE_PUBLISH_WORKER=true (development only) runs the publish worker inside
 * the API process instead of going through RabbitMQ, so a demo needs only
 * PostgreSQL. Production always uses the queue and a separate worker.
 */
export function inlinePublishWorkerEnabled(): boolean {
  return process.env.INLINE_PUBLISH_WORKER === 'true' && process.env.NODE_ENV !== 'production';
}

@Injectable()
export class PublishQueueService {
  private readonly logger = new Logger(PublishQueueService.name);

  constructor(private readonly rabbit: RabbitMqService, private readonly moduleRef: ModuleRef) {}

  async enqueue(jobId: string, platform: string): Promise<void> {
    if (inlinePublishWorkerEnabled()) {
      const { PublishingService } = await import('../publishing/publishing.service');
      const publisher = this.moduleRef.get<InlinePublisher>(PublishingService, { strict: false });
      setImmediate(() => {
        publisher.process(jobId).catch((error: unknown) => {
          this.logger.error(`Inline publish of ${jobId} failed: ${error instanceof Error ? error.message : 'unknown error'}`);
        });
      });
      return;
    }
    return this.rabbit.publish(`publish.${platform}`, {
      type: 'publish.job',
      jobId,
      platform,
      enqueuedAt: new Date().toISOString(),
    });
  }
}
