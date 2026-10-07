import {
  CallHandler,
  ExecutionContext,
  HttpStatus,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable, finalize } from 'rxjs';
import { AuthenticatedUser } from '../auth/auth.types';
import { ApplicationException, ErrorCode } from '../common/exceptions/application.exception';
import { RedisService } from '../queue/redis.service';

const UPLOAD_LOCK_TTL_MS = 5 * 60_000;

@Injectable()
export class MediaUploadConcurrencyInterceptor implements NestInterceptor {
  constructor(private readonly redis: RedisService) {}

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    const request = context.switchToHttp().getRequest<{ user?: AuthenticatedUser }>();
    const userId = request.user?.id;
    if (!userId) {
      throw new ApplicationException(ErrorCode.AUTH_TOKEN_INVALID, 'Authentication is required', HttpStatus.UNAUTHORIZED);
    }
    const key = `lock:media-upload:${userId}`;
    const token = await this.redis.acquireLock(key, UPLOAD_LOCK_TTL_MS);
    if (!token) {
      throw new ApplicationException(
        ErrorCode.MEDIA_UPLOAD_RATE_LIMITED,
        'Another media upload is already in progress for this user',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    try {
      return next.handle().pipe(finalize(() => { void this.redis.releaseLock(key, token).catch(() => undefined); }));
    } catch (error) {
      await this.redis.releaseLock(key, token);
      throw error;
    }
  }
}
