export interface PublishJobMessage {
  type: 'publish.job';
  jobId: string;
  platform: string;
  enqueuedAt: string;
}

export type QueueMessage = PublishJobMessage;

export class DeadLetterDeliveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DeadLetterDeliveryError';
  }
}
