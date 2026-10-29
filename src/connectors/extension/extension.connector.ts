import { PlatformMode } from '@prisma/client';
import { ErrorCode } from '../../common/exceptions/application.exception';
import { ConnectorCapability } from '../core/connector-capability';
import { ConnectorError } from '../core/connector-error';
import { ConnectionTestResult, ConnectorAccount, PostPayload, PublishResult } from '../core/connector.types';
import { SocialPublisher } from '../core/social-publisher.interface';
import { EXTENSION_CONNECTOR_KEY, parseExtensionDeliverySettings } from './extension-delivery';

/**
 * Hands the job to the Chrome extension. The worker never touches the forum:
 * it parks the job at NEEDS_ACTION with `extensionQueued`, the extension
 * claims it (ExtensionAgentService), posts from the operator's signed-in
 * Chrome and reports the thread URL, which completes the job.
 */
export class ExtensionConnector implements SocialPublisher {
  readonly platform = EXTENSION_CONNECTOR_KEY;
  readonly mode = PlatformMode.BROWSER_ASSISTED;
  readonly capability: ConnectorCapability = {
    text: true,
    image: false,
    video: false,
    article: true,
    delete: false,
    schedule: false,
    analytics: false,
  };

  validate(post: PostPayload): Promise<void> {
    if (!post.body.trim()) throw new ConnectorError(ErrorCode.PLATFORM_CONTENT_REJECTED, 'Post body is required', false);
    return Promise.resolve();
  }

  publish(account: ConnectorAccount, post: PostPayload): Promise<PublishResult> {
    const settings = this.settings(account);
    return Promise.resolve({
      externalId: `extension:${post.idempotencyKey}`,
      status: 'NEEDS_ACTION',
      metadata: { extensionQueued: true, engine: settings.engine, targetHost: new URL(settings.targetUrl).hostname },
    });
  }

  testConnection(account: ConnectorAccount): Promise<ConnectionTestResult> {
    const settings = this.settings(account);
    return Promise.resolve({
      ok: true,
      message: `Tiện ích Chrome sẽ đăng lên ${new URL(settings.targetUrl).hostname} khi Chrome đang mở và đã đăng nhập.`,
      details: { engine: settings.engine, autoSubmit: settings.autoSubmit },
    });
  }

  private settings(account: ConnectorAccount) {
    try {
      return parseExtensionDeliverySettings(account.settings);
    } catch (error) {
      throw new ConnectorError(
        ErrorCode.CONNECTOR_NEEDS_ACTION,
        error instanceof Error ? `Chrome extension delivery is misconfigured: ${error.message}` : 'Chrome extension delivery is misconfigured',
        false,
      );
    }
  }
}
