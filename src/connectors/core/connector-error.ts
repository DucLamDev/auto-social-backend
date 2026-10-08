import { ErrorCode } from '../../common/exceptions/application.exception';

export class ConnectorError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly retryable: boolean,
    public readonly retryAfterSeconds?: number,
    public readonly safeDetails?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ConnectorError';
  }
}

export function mapHttpError(status: number, body?: unknown, retryAfter?: string | null): ConnectorError {
  const safeDetails = {
    httpStatus: status,
    ...(typeof body === 'object' && body !== null ? { platformResponse: body } : {}),
  };
  if (status === 401) return new ConnectorError(ErrorCode.PLATFORM_TOKEN_EXPIRED, 'Platform token is invalid or expired', false, undefined, safeDetails);
  if (status === 403) return new ConnectorError(ErrorCode.PLATFORM_PERMISSION_DENIED, 'Platform permission was denied', false, undefined, safeDetails);
  if (status === 429) {
    const seconds = retryAfter ? Number.parseInt(retryAfter, 10) : undefined;
    return new ConnectorError(ErrorCode.PLATFORM_RATE_LIMITED, 'Platform rate limit reached', true, Number.isFinite(seconds) ? seconds : undefined, safeDetails);
  }
  if (status >= 500) return new ConnectorError(ErrorCode.PLATFORM_API_ERROR, 'Platform API is temporarily unavailable', true, undefined, safeDetails);
  return new ConnectorError(ErrorCode.PLATFORM_CONTENT_REJECTED, 'Platform rejected the request', false, undefined, safeDetails);
}
