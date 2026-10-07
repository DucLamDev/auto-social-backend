import { Global, Module } from '@nestjs/common';
import { PublishQueueService } from './publish-queue.service';
import { RabbitMqService } from './rabbitmq.service';
import { RedisService } from './redis.service';

@Global()
@Module({ providers: [RabbitMqService, RedisService, PublishQueueService], exports: [RabbitMqService, RedisService, PublishQueueService] })
export class QueueModule {}
