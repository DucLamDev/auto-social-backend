import {
  CallHandler,
  ExecutionContext,
  Injectable,
  Logger,
  NestInterceptor,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Observable, finalize } from 'rxjs';
import { requestPathForLog } from '../utils/request-path.utils';

@Injectable()
export class RequestContextInterceptor implements NestInterceptor {
  private readonly logger = new Logger('HTTP');

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<{
      headers: Record<string, string | string[] | undefined>;
      requestId?: string;
      method: string;
      path?: string;
      originalUrl: string;
    }>();
    const response = context.switchToHttp().getResponse<{ statusCode: number }>();
    const requestedId = request.headers['x-request-id'];
    request.requestId = typeof requestedId === 'string' ? requestedId.slice(0, 128) : randomUUID();
    const started = Date.now();
    return next.handle().pipe(
      finalize(() => {
        this.logger.log(
          JSON.stringify({
            requestId: request.requestId,
            method: request.method,
            path: requestPathForLog(request),
            status: response.statusCode,
            durationMs: Date.now() - started,
          }),
        );
      }),
    );
  }
}
