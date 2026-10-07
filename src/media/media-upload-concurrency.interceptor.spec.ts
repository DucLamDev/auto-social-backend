import { CallHandler, ExecutionContext } from '@nestjs/common';
import { lastValueFrom, of } from 'rxjs';
import { RedisService } from '../queue/redis.service';
import { MediaUploadConcurrencyInterceptor } from './media-upload-concurrency.interceptor';

function context(userId = 'user-1'): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ user: { id: userId } }) }),
  } as unknown as ExecutionContext;
}

describe('MediaUploadConcurrencyInterceptor', () => {
  it('holds one Redis lock around multipart parsing and releases it safely', async () => {
    const acquireLock = jest.fn().mockResolvedValue('token-1');
    const releaseLock = jest.fn().mockResolvedValue(true);
    const interceptor = new MediaUploadConcurrencyInterceptor({ acquireLock, releaseLock } as unknown as RedisService);
    const observable = await interceptor.intercept(context(), { handle: () => of('ok') } as CallHandler);

    await expect(lastValueFrom(observable)).resolves.toBe('ok');
    expect(acquireLock).toHaveBeenCalledWith('lock:media-upload:user-1', 300_000);
    expect(releaseLock).toHaveBeenCalledWith('lock:media-upload:user-1', 'token-1');
  });

  it('rejects a concurrent upload before the file interceptor buffers it', async () => {
    const interceptor = new MediaUploadConcurrencyInterceptor({
      acquireLock: jest.fn().mockResolvedValue(null),
    } as unknown as RedisService);

    await expect(interceptor.intercept(context(), { handle: jest.fn() }))
      .rejects.toThrow('Another media upload is already in progress');
  });
});
