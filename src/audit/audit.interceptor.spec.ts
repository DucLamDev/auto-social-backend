import { CallHandler, ExecutionContext } from '@nestjs/common';
import { lastValueFrom, of } from 'rxjs';
import { AuditInterceptor } from './audit.interceptor';
import { AuditService } from './audit.service';

describe('AuditInterceptor', () => {
  it('records only safe mutation metadata and does not include response or request bodies', async () => {
    const recordBestEffort = jest.fn().mockResolvedValue(undefined);
    const interceptor = new AuditInterceptor({ recordBestEffort } as unknown as AuditService);
    const request = {
      method: 'PATCH',
      path: '/api/v1/platform-accounts/account-1',
      params: { id: 'account-1' },
      requestId: 'request-1',
      user: { id: 'user-1' },
      ip: '203.0.113.10',
      socket: {},
      body: { credential: 'must-never-be-audited' },
    };
    const context = {
      switchToHttp: () => ({ getRequest: () => request }),
    } as unknown as ExecutionContext;
    const handler = { handle: () => of({ secret: 'must-never-be-audited' }) } as CallHandler;

    await expect(lastValueFrom(interceptor.intercept(context, handler))).resolves.toEqual({
      secret: 'must-never-be-audited',
    });
    expect(recordBestEffort).toHaveBeenCalledWith({
      actorId: 'user-1',
      action: 'HTTP_PATCH_PLATFORM-ACCOUNTS',
      entityType: 'platform-accounts',
      entityId: 'account-1',
      requestId: 'request-1',
      ipAddress: '203.0.113.10',
    });
  });

  it.each([
    ['retry', 'HTTP_POST_PUBLISH-JOBS_RETRY'],
    ['reconcile-not-found', 'HTTP_POST_PUBLISH-JOBS_RECONCILE-NOT-FOUND'],
    ['mark-published', 'HTTP_POST_PUBLISH-JOBS_MARK-PUBLISHED'],
  ])('records the publish-job %s decision as a distinct action', async (operation, action) => {
    const recordBestEffort = jest.fn().mockResolvedValue(undefined);
    const interceptor = new AuditInterceptor({ recordBestEffort } as unknown as AuditService);
    const request = {
      method: 'POST',
      path: `/api/v1/publish-jobs/job-1/${operation}`,
      params: { id: 'job-1' },
      requestId: 'request-1',
      user: { id: 'user-1' },
      ip: '203.0.113.10',
      socket: {},
    };
    const context = {
      switchToHttp: () => ({ getRequest: () => request }),
    } as unknown as ExecutionContext;

    await lastValueFrom(interceptor.intercept(context, { handle: () => of({ ok: true }) } as CallHandler));

    expect(recordBestEffort).toHaveBeenCalledWith(expect.objectContaining({
      actorId: 'user-1',
      action,
      entityType: 'publish-jobs',
      entityId: 'job-1',
      requestId: 'request-1',
    }));
  });
});
