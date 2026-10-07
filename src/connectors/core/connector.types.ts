import { PlatformMode } from '@prisma/client';

export interface ConnectorAccount {
  id: string;
  externalId?: string;
  username?: string;
  settings: Record<string, unknown>;
  credentials: Record<string, unknown>;
}

export interface PostMedia {
  type: 'image' | 'video' | 'document';
  url: string;
  altText?: string;
  mimeType?: string;
}

export interface PostPayload {
  title?: string;
  body: string;
  summary?: string;
  hashtags?: string[];
  canonicalUrl?: string;
  media?: PostMedia[];
  idempotencyKey: string;
}

export interface PublishResult {
  externalId: string;
  url?: string;
  status: 'PUBLISHED' | 'PROCESSING' | 'NEEDS_ACTION';
  metadata?: Record<string, unknown>;
}

export interface PublishStatus {
  status: 'PUBLISHED' | 'PROCESSING' | 'FAILED' | 'UNKNOWN';
  url?: string;
}

export interface ConnectionTestResult {
  ok: boolean;
  accountName?: string;
  details?: Record<string, unknown>;
}

export interface ConnectorDescriptor {
  platform: string;
  mode: PlatformMode;
  capability: import('./connector-capability').ConnectorCapability;
}
