import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable, map } from 'rxjs';

export interface ApiEnvelope<T> {
  success: true;
  data: T;
  meta: { requestId: string; timestamp: string } & Record<string, unknown>;
}

export interface PaginationMeta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export interface PaginatedData<T> {
  items: T[];
  pagination: PaginationMeta;
}

export function paginatedData<T>(items: T[], pagination: PaginationMeta): PaginatedData<T> {
  return { items, pagination };
}

function isPaginatedData(value: unknown): value is PaginatedData<unknown> {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<PaginatedData<unknown>>;
  return Array.isArray(candidate.items)
    && Boolean(candidate.pagination)
    && typeof candidate.pagination?.page === 'number'
    && typeof candidate.pagination.limit === 'number'
    && typeof candidate.pagination.total === 'number'
    && typeof candidate.pagination.totalPages === 'number';
}

function jsonSafe(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map((item) => jsonSafe(item));
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, jsonSafe(item)]),
    );
  }
  return value;
}

@Injectable()
export class ApiResponseInterceptor<T> implements NestInterceptor<T, ApiEnvelope<T>> {
  intercept(context: ExecutionContext, next: CallHandler<T>): Observable<ApiEnvelope<T>> {
    const request = context.switchToHttp().getRequest<{ requestId?: string }>();
    return next.handle().pipe(
      map((data) => {
        const paginated = isPaginatedData(data) ? data : undefined;
        return {
          success: true as const,
          data: jsonSafe(paginated ? paginated.items : data) as T,
          meta: {
            requestId: request.requestId ?? 'unknown',
            timestamp: new Date().toISOString(),
            ...(paginated?.pagination ?? {}),
          },
        };
      }),
    );
  }
}
