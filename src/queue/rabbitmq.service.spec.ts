import { ConfigService } from '@nestjs/config';
import { ConfirmChannel, ConsumeMessage } from 'amqplib';
import { DeadLetterDeliveryError, QueueMessage } from './queue.types';
import { RabbitMqService } from './rabbitmq.service';

describe('RabbitMqService delivery outcomes', () => {
  function setup(redelivered: boolean, failure: Error) {
    const service = new RabbitMqService(new ConfigService({}));
    const target = service as unknown as {
      consumerHandler: (message: QueueMessage) => Promise<void>;
      handleDelivery(channel: ConfirmChannel, raw: ConsumeMessage): Promise<void>;
    };
    target.consumerHandler = jest.fn().mockRejectedValue(failure);
    const ack = jest.fn();
    const nack = jest.fn();
    const channel = { ack, nack } as unknown as ConfirmChannel;
    const raw = {
      content: Buffer.from(JSON.stringify({
        type: 'publish.job', jobId: 'job-1', platform: 'x', enqueuedAt: new Date(0).toISOString(),
      })),
      fields: { redelivered },
    } as unknown as ConsumeMessage;
    return { target, channel, raw, ack, nack };
  }

  it('dead-letters a publish failure already persisted as permanent', async () => {
    const { target, channel, raw, nack } = setup(false, new DeadLetterDeliveryError('permanent'));
    await target.handleDelivery(channel, raw);
    expect(nack).toHaveBeenCalledWith(raw, false, false);
  });

  it('requeues an unexpected infrastructure failure once, then dead-letters a redelivery', async () => {
    const first = setup(false, new Error('temporary database outage'));
    await first.target.handleDelivery(first.channel, first.raw);
    expect(first.nack).toHaveBeenCalledWith(first.raw, false, true);

    const second = setup(true, new Error('temporary database outage'));
    await second.target.handleDelivery(second.channel, second.raw);
    expect(second.nack).toHaveBeenCalledWith(second.raw, false, false);
  });
});
