import { PlatformMode } from '@prisma/client';

export interface ConnectorAccount {
  id: string;
  externalId?: string;
  username?: string;
  settings: Record<string, unknown>;
  credentials: Record<string, unknown>;
}

/**
 * Internal provenance attached by the publishing service after loading a
 * MediaAsset owned by the campaign content. Symbol keys are omitted from API
 * JSON and cannot be supplied through ordinary JSON request payloads.
 */
export const POST_MEDIA_MANAGED_STORAGE = Symbol('POST_MEDIA_MANAGED_STORAGE');

export interface PostMediaManagedStorage {
  storageKey: string;
  checksum: string;
  sizeBytes: number;
}

export interface PostMedia {
  type: 'image' | 'video' | 'document';
  url: string;
  altText?: string;
  mimeType?: string;
  [POST_MEDIA_MANAGED_STORAGE]?: PostMediaManagedStorage;
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
  manual?: boolean;
  ready?: boolean;
  message?: string;
  details?: Record<string, unknown>;
}

export interface ConnectorDescriptor {
  platform: string;
  mode: PlatformMode;
  capability: import('./connector-capability').ConnectorCapability;
}
