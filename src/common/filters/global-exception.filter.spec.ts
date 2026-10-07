import { ArgumentsHost, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ConnectorError } from '../../connectors/core/connector-error';
import { ErrorCode } from '../exceptions/application.exception';
import { GlobalExceptionFilter } from './global-exception.filter';

describe('GlobalExceptionFilter', () => {
  function invoke(exception: unknown, originalUrl = '/api/v1/items/missing') {
    const json = jest.fn();
    const status = jest.fn().mockReturnValue({ json });
    const host = {
      switchToHttp: () => ({
        getRequest: () => ({ requestId: 'request-1', method: 'GET', originalUrl }),
        getResponse: () => ({ status }),
      }),
    } as unknown as ArgumentsHost;
    new GlobalExceptionFilter().catch(exception, host);
    return { status, json };
  }

  it('maps Prisma not-found errors to a redacted 404', () => {
    const error = new Prisma.PrismaClientKnownRequestError('sensitive database message', {
      code: 'P2025',
      clientVersion: '6.17.1',
      meta: { cause: 'sensitive metadata' },
    });
    const { status, json } = invoke(error);
    expect(status).toHaveBeenCalledWith(404);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({
      success: false,
      error: { code: ErrorCode.RESOURCE_NOT_FOUND, message: 'Resource was not found' },
    }));
  });

  it('maps Prisma uniqueness errors to conflict without returning metadata', () => {
    const error = new Prisma.PrismaClientKnownRequestError('unique constraint details', {
      code: 'P2002',
      clientVersion: '6.17.1',
      meta: { target: ['secret_field'] },
    });
    const { status, json } = invoke(error);
    expect(status).toHaveBeenCalledWith(409);
    expect(JSON.stringify(json.mock.calls)).not.toContain('secret_field');
  });

  it('maps connector errors to stable HTTP statuses and omits platform response details', () => {
    const error = new ConnectorError(
      ErrorCode.PLATFORM_RATE_LIMITED,
      'Platform rate limit reached',
      true,
      30,
      { platformResponse: { access_token: 'secret' } },
    );
    const { status, json } = invoke(error);
    expect(status).toHaveBeenCalledWith(429);
    expect(JSON.stringify(json.mock.calls)).not.toContain('access_token');
  });

  it('preserves the safe message for a known connector gateway error', () => {
    const { status, json } = invoke(new ConnectorError(
      ErrorCode.PUBLISH_TIMEOUT,
      'Platform request timed out',
      true,
    ));
    expect(status).toHaveBeenCalledWith(504);
    expect(JSON.stringify(json.mock.calls)).toContain('Platform request timed out');
  });

  it('never writes OAuth query secrets or exception messages to 5xx logs', () => {
    const log = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    invoke(
      new Error('exchange failed for code=message-secret'),
      '/api/v1/oauth/google/callback?code=query-secret&state=state-secret',
    );

    const output = JSON.stringify(log.mock.calls);
    expect(output).toContain('/api/v1/oauth/google/callback');
    expect(output).not.toContain('query-secret');
    expect(output).not.toContain('state-secret');
    expect(output).not.toContain('message-secret');
    log.mockRestore();
  });
});
