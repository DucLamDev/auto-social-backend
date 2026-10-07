import { CallHandler, ExecutionContext } from '@nestjs/common';
import { firstValueFrom, of } from 'rxjs';
import { ApiResponseInterceptor, paginatedData } from './api-response.interceptor';

describe('ApiResponseInterceptor pagination', () => {
  it('moves pagination metadata beside the standard request metadata', async () => {
    const context = {
      switchToHttp: () => ({ getRequest: () => ({ requestId: 'request-1' }) }),
    } as unknown as ExecutionContext;
    const next = {
      handle: () => of(paginatedData([{ id: 'content-1' }], {
        page: 2,
        limit: 20,
        total: 41,
        totalPages: 3,
      })),
    } as CallHandler;

    const result = await firstValueFrom(new ApiResponseInterceptor().intercept(context, next));

    expect(result.data).toEqual([{ id: 'content-1' }]);
    expect(result.meta).toMatchObject({
      requestId: 'request-1',
      page: 2,
      limit: 20,
      total: 41,
      totalPages: 3,
    });
  });
});
