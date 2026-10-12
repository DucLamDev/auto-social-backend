import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import amqp, { ChannelModel, ConfirmChannel, ConsumeMessage } from 'amqplib';
import { DeadLetterDeliveryError, QueueMessage } from './queue.types';

@Injectable()
export class RabbitMqService implements OnModuleDestroy {
  private readonly logger = new Logger(RabbitMqService.name);
  private connection?: ChannelModel;
  private channel?: ConfirmChannel;
  private connecting?: Promise<ConfirmChannel>;
  private closing = false;
  private consumerHandler?: (message: QueueMessage) => Promise<void>;
  private consumerActive = false;
  private reconnectTimer?: NodeJS.Timeout;
  private readonly exchange: string;

  constructor(private readonly config: ConfigService) {
    this.exchange = config.get<string>('RABBITMQ_EXCHANGE', 'social.publisher');
  }

  async publish(routingKey: string, message: QueueMessage): Promise<void> {
    if (this.skipConnection()) return;
    const channel = await this.ensureChannel();
    channel.publish(this.exchange, routingKey, Buffer.from(JSON.stringify(message)), {
      persistent: true,
      contentType: 'application/json',
      messageId: message.jobId,
      timestamp: Date.now(),
    });
    await channel.waitForConfirms();
  }

  async ping(): Promise<boolean> {
    if (this.skipConnection()) return true;
    const channel = await this.ensureChannel();
    return Boolean(channel);
  }

  async consume(handler: (message: QueueMessage) => Promise<void>): Promise<void> {
    if (this.skipConnection()) return;
    this.consumerHandler = handler;
    await this.startConsumer();
  }

  private async startConsumer(): Promise<void> {
    if (!this.consumerHandler || this.consumerActive || this.closing) return;
    try {
      const channel = await this.ensureChannel();
      await channel.consume('publish.jobs', (raw) => {
        if (raw) void this.handleDelivery(channel, raw);
      });
      this.consumerActive = true;
      this.logger.log('Consuming RabbitMQ queue publish.jobs');
    } catch (error) {
      this.logger.error(`RabbitMQ consumer start failed: ${error instanceof Error ? error.message : 'unknown error'}`);
      this.scheduleConsumerReconnect();
    }
  }

  private async handleDelivery(channel: ConfirmChannel, raw: ConsumeMessage): Promise<void> {
    let message: QueueMessage;
    try {
      message = this.parse(raw);
    } catch (error) {
      this.logger.error(`Invalid queue message: ${error instanceof Error ? error.message : 'unknown error'}`);
      channel.nack(raw, false, false);
      return;
    }
    try {
      await this.consumerHandler!(message);
      channel.ack(raw);
    } catch (error) {
      this.logger.error(`Queue message failed: ${error instanceof Error ? error.message : 'unknown error'}`);
      const permanent = error instanceof DeadLetterDeliveryError;
      const requeue = !permanent && !raw.fields.redelivered;
      channel.nack(raw, false, requeue);
    }
  }

  async onModuleDestroy(): Promise<void> {
    this.closing = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    await this.channel?.close().catch(() => undefined);
    await this.connection?.close().catch(() => undefined);
  }

  private ensureChannel(): Promise<ConfirmChannel> {
    if (this.channel) return Promise.resolve(this.channel);
    if (!this.connecting) this.connecting = this.connect();
    return this.connecting;
  }

  private skipConnection(): boolean {
    return process.env.SKIP_INFRA_CONNECT === 'true'
      || process.env.SKIP_RABBITMQ_CONNECT === 'true';
  }

  private async connect(): Promise<ConfirmChannel> {
    try {
      const url = this.config.get<string>('RABBITMQ_URL', 'amqp://localhost:5672');
      const connection = await amqp.connect(url);
      const channel = await connection.createConfirmChannel();
      await channel.assertExchange(this.exchange, 'topic', { durable: true });
      await channel.assertExchange(`${this.exchange}.dead`, 'fanout', { durable: true });
      await channel.assertQueue('publish.dead-letter', { durable: true });
      await channel.bindQueue('publish.dead-letter', `${this.exchange}.dead`, '');
      await channel.assertQueue('publish.jobs', {
        durable: true,
        arguments: { 'x-dead-letter-exchange': `${this.exchange}.dead` },
      });
      await channel.bindQueue('publish.jobs', this.exchange, 'publish.*');
      await channel.prefetch(this.config.get<number>('RABBITMQ_PREFETCH', 10));
      connection.on('error', (error: Error) => this.logger.error(`RabbitMQ error: ${error.message}`));
      connection.on('close', () => {
        this.channel = undefined;
        this.connection = undefined;
        this.connecting = undefined;
        this.consumerActive = false;
        if (!this.closing) {
          this.logger.warn('RabbitMQ connection closed; reconnecting consumer');
          this.scheduleConsumerReconnect();
        }
      });
      this.connection = connection;
      this.channel = channel;
      this.logger.log('RabbitMQ connected');
      return channel;
    } finally {
      this.connecting = undefined;
    }
  }

  private scheduleConsumerReconnect(): void {
    if (this.closing || !this.consumerHandler || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.startConsumer();
    }, 2_000);
    this.reconnectTimer.unref();
  }

  private parse(raw: ConsumeMessage): QueueMessage {
    const value: unknown = JSON.parse(raw.content.toString('utf8'));
    if (!value || typeof value !== 'object') throw new Error('Invalid queue message');
    const record = value as Record<string, unknown>;
    if (record.type !== 'publish.job' || typeof record.jobId !== 'string' || typeof record.platform !== 'string' || typeof record.enqueuedAt !== 'string') {
      throw new Error('Invalid publish job message schema');
    }
    return value as QueueMessage;
  }
}
