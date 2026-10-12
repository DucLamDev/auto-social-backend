import { PlatformMode } from '@prisma/client';
import { ErrorCode } from '../../common/exceptions/application.exception';
import { ConnectorCapability } from '../core/connector-capability';
import { ConnectorError } from '../core/connector-error';
import { ConnectionTestResult, ConnectorAccount, PostPayload, PublishResult } from '../core/connector.types';
import { SocialPublisher } from '../core/social-publisher.interface';

export class ManualConnector implements SocialPublisher {
  readonly mode = PlatformMode.MANUAL;
  readonly capability: ConnectorCapability = {
    text: true,
    image: false,
    video: false,
    article: false,
    delete: false,
    schedule: false,
    analytics: false,
  };

  constructor(public readonly platform: string) {}

  validate(post: PostPayload): Promise<void> {
    if (!post.body.trim()) throw new ConnectorError(ErrorCode.PLATFORM_CONTENT_REJECTED, 'Post body is required', false);
    return Promise.resolve();
  }

  publish(account: ConnectorAccount, post: PostPayload): Promise<PublishResult> {
    void account;
    void post;
    return Promise.resolve({
      externalId: `manual:${crypto.randomUUID()}`,
      status: 'NEEDS_ACTION',
      metadata: { reason: 'This platform requires a user-confirmed/manual publishing action.' },
    });
  }

  testConnection(account: ConnectorAccount): Promise<ConnectionTestResult> {
    void account;
    return Promise.resolve({
      ok: true,
      manual: true,
      ready: true,
      message: 'Content preparation is ready; final submission must be confirmed on the platform.',
      details: {
        manual: true,
        ready: true,
        message: 'Content can be prepared automatically and must be confirmed on the platform manually.',
      },
    });
  }
}
