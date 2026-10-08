import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import type { Request } from 'express';
import { Observable, mergeMap } from 'rxjs';
import { AuthenticatedUser } from '../auth/auth.types';
import { AuditService } from './audit.service';

type AuditRequest = Request & { requestId?: string; user?: AuthenticatedUser };

@Injectable()
export class AuditInterceptor implements NestInterceptor {
  private static readonly mutationMethods = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

  constructor(private readonly audit: AuditService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<AuditRequest>();
    if (!AuditInterceptor.mutationMethods.has(request.method.toUpperCase())) return next.handle();
    const segments = request.path.split('/').filter(Boolean);
    const apiIndex = segments.findIndex((segment) => segment === 'v1');
    const entityIndex = apiIndex >= 0 ? apiIndex + 1 : 0;
    const entityType = segments[entityIndex] ?? 'unknown';
    const rawEntityId = request.params.id ?? request.params.slug;
    const entityId = Array.isArray(rawEntityId) ? rawEntityId[0] : rawEntityId;
    const operation = entityId ? segments[entityIndex + 2] : undefined;
    const operationSuffix = operation ? `_${operation.toUpperCase()}` : '';
    return next.handle().pipe(
      mergeMap(async (value: unknown) => {
        await this.audit.recordBestEffort({
          actorId: request.user?.id,
          action: `HTTP_${request.method.toUpperCase()}_${entityType.toUpperCase()}${operationSuffix}`,
          entityType,
          entityId,
          requestId: request.requestId,
          ipAddress: request.ip || request.socket.remoteAddress,
        });
        return value;
      }),
    );
  }
}
