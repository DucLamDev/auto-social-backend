import { ConnectorCapability } from './connector-capability';
import {
  ConnectionTestResult,
  ConnectorAccount,
  PostPayload,
  PublishResult,
  PublishStatus,
} from './connector.types';
import { PlatformMode } from '@prisma/client';

export interface SocialPublisher {
  readonly platform: string;
  readonly mode: PlatformMode;
  readonly capability: ConnectorCapability;
  validate(post: PostPayload): Promise<void>;
  publish(account: ConnectorAccount, post: PostPayload): Promise<PublishResult>;
  getStatus?(account: ConnectorAccount, publishId: string): Promise<PublishStatus>;
  delete?(account: ConnectorAccount, publishId: string): Promise<void>;
  refreshToken?(account: ConnectorAccount): Promise<void>;
  testConnection?(account: ConnectorAccount): Promise<ConnectionTestResult>;
}
