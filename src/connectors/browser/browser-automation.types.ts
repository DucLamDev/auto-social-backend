import type { Page } from 'playwright';
import type { ConnectorAccount, PostPayload } from '../core/connector.types';

export interface BrowserStorageCookie extends Record<string, unknown> {
  name: string;
  value: string;
  domain: string;
  path: string;
}

export interface BrowserStorageOrigin extends Record<string, unknown> {
  origin: string;
  localStorage: Array<{ name: string; value: string }>;
}

export interface BrowserStorageState {
  cookies: BrowserStorageCookie[];
  origins: BrowserStorageOrigin[];
}

export type BrowserChallengeKind =
  'CAPTCHA_REQUIRED' | 'LOGIN_REQUIRED' | 'SECURITY_CHECK_REQUIRED' | 'TWO_FACTOR_REQUIRED';

export interface BrowserChallenge {
  kind: BrowserChallengeKind;
  message: string;
}

export interface BrowserRecipeContext {
  account: ConnectorAccount;
  page: Page;
  post: PostPayload;
  /** Local, mode-0600 files staged only for the lifetime of this operation. */
  mediaFiles: readonly BrowserPreparedImage[];
}

export type BrowserImageMimeType = 'image/jpeg' | 'image/png' | 'image/webp';

export interface BrowserRecipeMediaPolicy {
  /** Explicit opt-in. Omit this policy when a reviewed recipe has no upload flow. */
  readonly images: {
    readonly maxCount: number;
    readonly maxBytesPerImage: number;
    readonly mimeTypes: readonly BrowserImageMimeType[];
  };
}

export interface BrowserPreparedImage {
  readonly path: string;
  readonly mimeType: BrowserImageMimeType;
  readonly sizeBytes: number;
  readonly altText?: string;
}

export interface BrowserRecipePublishResult {
  externalId: string;
  url?: string;
  metadata?: Record<string, unknown>;
}

/**
 * A recipe is compiled, reviewed application code. Account settings select a
 * recipe by key; they can never inject JavaScript or arbitrary browser steps.
 */
export interface BrowserPublishRecipe {
  readonly key: string;
  readonly allowedHosts: readonly string[];
  readonly finalSubmitPolicy: 'AUTOMATED' | 'HUMAN_REQUIRED';
  readonly requiresAutomationPermissionAttestation?: boolean;
  readonly mediaPolicy?: BrowserRecipeMediaPolicy;
  startUrl(account: ConnectorAccount): string;
  isEditorReady(page: Page): Promise<boolean>;
  prepare(context: BrowserRecipeContext): Promise<void>;
  submit(context: BrowserRecipeContext): Promise<BrowserRecipePublishResult>;
}

export interface BrowserAutomationNeedsAction {
  status: 'NEEDS_ACTION';
  reason:
    | BrowserChallengeKind
    | 'AUTOMATION_BUSY'
    | 'AUTOMATION_DISABLED'
    | 'AUTOMATION_FAILED'
    | 'EDITOR_NOT_FOUND'
    | 'SUBMISSION_CONFIRMATION_REQUIRED'
    | 'SUBMISSION_UNCERTAIN';
  message: string;
  actionUrl?: string;
  accountReconnectRequired?: boolean;
  challengeKind?: BrowserChallengeKind;
  reconciliationRequired?: boolean;
  submissionUncertain?: boolean;
}

export interface BrowserAutomationPublished {
  status: 'PUBLISHED';
  externalId: string;
  url?: string;
  metadata?: Record<string, unknown>;
}

export type BrowserAutomationResult = BrowserAutomationNeedsAction | BrowserAutomationPublished;

export interface BrowserConnectionInspection {
  ready: boolean;
  challenge?: BrowserChallenge;
  actionUrl?: string;
  message: string;
}
