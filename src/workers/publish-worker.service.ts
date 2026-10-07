import { Injectable, OnApplicationBootstrap } from '@nestjs/common';
import { PublishingService } from '../publishing/publishing.service';
import { RabbitMqService } from '../queue/rabbitmq.service';

@Injectable()
export class PublishWorkerService implements OnApplicationBootstrap {
  constructor(private readonly rabbit: RabbitMqService, private readonly publishing: PublishingService) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.rabbit.consume(async (message) => {
      if (message.type === 'publish.job') await this.publishing.process(message.jobId);
    });
  }
}
