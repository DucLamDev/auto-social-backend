import { RabbitMqService } from './rabbitmq.service';
import { PublishQueueService } from './publish-queue.service';

describe('PublishQueueService', () => {
  it('uses a platform routing key and durable job-shaped message', async () => {
    const publishMock: jest.MockedFunction<RabbitMqService['publish']> = jest.fn();
    publishMock.mockResolvedValue(undefined);
    const rabbit = { publish: publishMock } as unknown as RabbitMqService;
    const service = new PublishQueueService(rabbit);
    await service.enqueue('job-1', 'instagram');
    expect(publishMock).toHaveBeenCalledWith(
      'publish.instagram',
      expect.objectContaining({ type: 'publish.job', jobId: 'job-1', platform: 'instagram' }),
    );
  });
});
