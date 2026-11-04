import type { PostPayload } from '../core/connector.types';
import { ErrorCode } from '../../common/exceptions/application.exception';
import { MastodonConnector } from './mastodon.connector';

/** validate() throws synchronously; run it as the publisher does, inside a promise. */
const validated = (connector: { validate(post: PostPayload): Promise<void> }, post: PostPayload) => Promise.resolve().then(() => connector.validate(post));


describe('MastodonConnector length check', () => {
  const connector = new MastodonConnector();

  it('refuses a status over 500 characters before calling the server', async () => {
    const request = jest.spyOn(connector as unknown as { requestDynamic: () => Promise<unknown> }, 'requestDynamic');
    const account = { id: 'a', settings: { instanceUrl: 'https://mastodon.social' }, credentials: { accessToken: 'token' } };
    await expect(connector.publish(account, { body: 'ạ'.repeat(545), idempotencyKey: 'k' })).rejects.toMatchObject({
      code: ErrorCode.PLATFORM_CONTENT_REJECTED,
      message: 'Bài Mastodon dài 545/500 ký tự, vượt giới hạn của nền tảng. Rút gọn trước khi duyệt hoặc đăng.',
    });
    expect(request).not.toHaveBeenCalled();
  });

  it('counts every link as 23 characters, as Mastodon does', async () => {
    const link = `https://vpsttt.vn/blog/${'huong-dan-'.repeat(20)}`;
    await expect(validated(connector, { body: `${'a'.repeat(470)} ${link}`, idempotencyKey: 'k' })).resolves.toBeUndefined();
    await expect(validated(connector, { body: `${'a'.repeat(477)} ${link}`, idempotencyKey: 'k' })).rejects.toMatchObject({ code: ErrorCode.PLATFORM_CONTENT_REJECTED });
  });
});
