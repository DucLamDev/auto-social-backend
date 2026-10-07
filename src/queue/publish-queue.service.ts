import { Injectable } from '@nestjs/common';
import { RabbitMqService } from './rabbitmq.service';

@Injectable()
export class PublishQueueService {
  constructor(private readonly rabbit: RabbitMqService) {}

  enqueue(jobId: string, platform: string): Promise<void> {
    return this.rabbit.publish(`publish.${platform}`, {
      type: 'publish.job',
      jobId,
      platform,
      enqueuedAt: new Date().toISOString(),
    });
  }
}
