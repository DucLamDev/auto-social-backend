import type { PostPayload } from '../core/connector.types';
import { ErrorCode } from '../../common/exceptions/application.exception';
import { ThreadsConnector } from './threads.connector';

/** validate() throws synchronously; run it as the publisher does, inside a promise. */
const validated = (connector: { validate(post: PostPayload): Promise<void> }, post: PostPayload) => Promise.resolve().then(() => connector.validate(post));


describe('ThreadsConnector length check', () => {
  it('allows 500 characters counted as people see them, not UTF-16 units', async () => {
    const connector = new ThreadsConnector();
    await expect(validated(connector, { body: '🚀'.repeat(500), idempotencyKey: 'k' })).resolves.toBeUndefined();
    await expect(validated(connector, { body: 'ệ'.repeat(501), idempotencyKey: 'k' })).rejects.toMatchObject({
      code: ErrorCode.PLATFORM_CONTENT_REJECTED,
      message: 'Bài Threads dài 501/500 ký tự, vượt giới hạn của nền tảng. Rút gọn trước khi duyệt hoặc đăng.',
    });
  });
});
