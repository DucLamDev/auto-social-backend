import { ErrorCode } from '../../common/exceptions/application.exception';
import { mapHttpError } from './connector-error';

describe('connector retry classification', () => {
  it('retries 429, 5xx, and honors Retry-After', () => {
    expect(mapHttpError(429, {}, '45')).toMatchObject({ code: ErrorCode.PLATFORM_RATE_LIMITED, retryable: true, retryAfterSeconds: 45 });
    expect(mapHttpError(503)).toMatchObject({ code: ErrorCode.PLATFORM_API_ERROR, retryable: true });
  });

  it('does not retry invalid credentials or permissions', () => {
    expect(mapHttpError(401)).toMatchObject({ code: ErrorCode.PLATFORM_TOKEN_EXPIRED, retryable: false });
    expect(mapHttpError(403)).toMatchObject({ code: ErrorCode.PLATFORM_PERMISSION_DENIED, retryable: false });
  });
});
