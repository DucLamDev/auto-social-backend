import { RoleName } from '@prisma/client';

export enum AuthState {
  AUTHENTICATED = 'AUTHENTICATED',
  LOGIN_REQUIRED = 'LOGIN_REQUIRED',
  CAPTCHA_REQUIRED = 'CAPTCHA_REQUIRED',
  TWO_FACTOR_REQUIRED = 'TWO_FACTOR_REQUIRED',
  EMAIL_VERIFICATION_REQUIRED = 'EMAIL_VERIFICATION_REQUIRED',
  DEVICE_CONFIRMATION_REQUIRED = 'DEVICE_CONFIRMATION_REQUIRED',
  SESSION_EXPIRED = 'SESSION_EXPIRED',
  UNKNOWN_AUTH_CHALLENGE = 'UNKNOWN_AUTH_CHALLENGE',
}

export enum AccountRuntimeState {
  READY = 'READY',
  AUTH_REQUIRED = 'AUTH_REQUIRED',
  WAITING_CAPTCHA = 'WAITING_CAPTCHA',
  WAITING_2FA = 'WAITING_2FA',
  SESSION_EXPIRED = 'SESSION_EXPIRED',
  LOCKED = 'LOCKED',
  FAILED = 'FAILED',
}

/** Reviewed application code supplies selectors; account JSON cannot inject them. */
export interface PlatformAuthAdapter {
  readonly allowedHosts: readonly string[];
  readonly selectors: {
    readonly loggedIn?: readonly string[];
    readonly loginForm?: readonly string[];
    readonly captcha?: readonly string[];
    readonly otpInput?: string;
    readonly otpSubmit?: string;
    readonly emailVerification?: readonly string[];
    readonly deviceConfirmation?: readonly string[];
    readonly sessionExpired?: readonly string[];
    readonly locked?: readonly string[];
    readonly rejected?: readonly string[];
    readonly sensitive?: readonly string[];
  };
  isAuthenticated?: (page: import('playwright').Page) => Promise<boolean>;
  /** Optional sanctioned login flow. Called once; never automatically retried. */
  login?: (page: import('playwright').Page, signal: AbortSignal) => Promise<void>;
}

export interface AuthIdentity {
  platform: string;
  account: string;
}

export interface AuthDetection {
  state: AuthState;
  failure?: 'LOCKED' | 'REJECTED';
}

export interface AuthRecoveryResult {
  authenticated: boolean;
  state: AuthState;
  runtimeState: AccountRuntimeState;
  reason?: 'SKIPPED' | 'NON_INTERACTIVE' | 'TIMEOUT' | 'CANCELLED' | 'LOCKED' | 'REJECTED' | 'UNKNOWN' | 'FAILED';
  screenshot?: string;
}

export interface JwtPayload {
  sub: string;
  email: string;
  roles: RoleName[];
  type: 'access';
}

export interface RefreshPayload {
  sub: string;
  sid: string;
  type: 'refresh';
}

export interface AuthenticatedUser {
  id: string;
  email: string;
  displayName: string;
  roles: RoleName[];
}
