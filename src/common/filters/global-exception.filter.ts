import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ConnectorError } from '../../connectors/core/connector-error';
import { ErrorCode } from '../exceptions/application.exception';
import { requestPathForLog } from '../utils/request-path.utils';

interface HttpErrorBody {
  code?: string;
  message?: string | string[];
  details?: unknown;
}

@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(GlobalExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const context = host.switchToHttp();
    const request = context.getRequest<{
      requestId?: string;
      method: string;
      path?: string;
      originalUrl: string;
    }>();
    const response = context.getResponse<{ status: (status: number) => { json: (body: unknown) => void } }>();
    const normalized = this.normalize(exception);
    const { status } = normalized;
    const body = normalized.body;
    const objectBody: HttpErrorBody = typeof body === 'object' && body !== null ? body : {};
    const rawMessage = objectBody.message ?? (typeof body === 'string' ? body : undefined);
    const message = Array.isArray(rawMessage) ? rawMessage.join('; ') : rawMessage;
    const publicMessage = normalized.safeMessage || status < 500
      ? (message ?? 'Request could not be processed')
      : 'An internal error occurred';
    const code =
      objectBody.code ??
      (status === Number(HttpStatus.BAD_REQUEST) ? ErrorCode.VALIDATION_FAILED : ErrorCode.INTERNAL_ERROR);

    if (status >= 500) {
      this.logger.error(
        JSON.stringify({
          requestId: request.requestId,
          method: request.method,
          path: requestPathForLog(request),
          errorType: exception instanceof Error ? exception.name : 'UnknownError',
        }),
      );
    }

    response.status(status).json({
      success: false,
      error: { code, message: publicMessage, details: status < 500 ? objectBody.details : undefined },
      meta: { requestId: request.requestId ?? 'unknown', timestamp: new Date().toISOString() },
    });
  }

  private normalize(exception: unknown): { status: number; body: unknown; safeMessage: boolean } {
    if (exception instanceof HttpException) {
      return { status: exception.getStatus(), body: exception.getResponse(), safeMessage: true };
    }
    if (exception instanceof ConnectorError) {
      const statusByCode: Partial<Record<ErrorCode, number>> = {
        [ErrorCode.PLATFORM_AUTH_FAILED]: HttpStatus.UNAUTHORIZED,
        [ErrorCode.PLATFORM_TOKEN_EXPIRED]: HttpStatus.UNAUTHORIZED,
        [ErrorCode.PLATFORM_PERMISSION_DENIED]: HttpStatus.FORBIDDEN,
        [ErrorCode.PLATFORM_RATE_LIMITED]: HttpStatus.TOO_MANY_REQUESTS,
        [ErrorCode.PLATFORM_MEDIA_INVALID]: HttpStatus.UNPROCESSABLE_ENTITY,
        [ErrorCode.PLATFORM_CONTENT_REJECTED]: HttpStatus.UNPROCESSABLE_ENTITY,
        [ErrorCode.PUBLISH_TIMEOUT]: HttpStatus.GATEWAY_TIMEOUT,
        [ErrorCode.PLATFORM_API_ERROR]: HttpStatus.BAD_GATEWAY,
        [ErrorCode.CONNECTOR_NEEDS_ACTION]: HttpStatus.CONFLICT,
      };
      return {
        status: statusByCode[exception.code] ?? HttpStatus.BAD_GATEWAY,
        body: { code: exception.code, message: exception.message },
        safeMessage: true,
      };
    }
    if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      if (exception.code === 'P2025') {
        return { status: HttpStatus.NOT_FOUND, body: { code: ErrorCode.RESOURCE_NOT_FOUND, message: 'Resource was not found' }, safeMessage: true };
      }
      if (exception.code === 'P2002' || exception.code === 'P2003') {
        return { status: HttpStatus.CONFLICT, body: { code: ErrorCode.CONFLICT, message: 'The request conflicts with existing data' }, safeMessage: true };
      }
    }
    return { status: HttpStatus.INTERNAL_SERVER_ERROR, body: undefined, safeMessage: false };
  }
}
