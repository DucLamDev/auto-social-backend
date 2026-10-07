import { SsrfSafeHttpService } from './ssrf-safe-http.service';
import { Agent, Response } from 'undici';

describe('SsrfSafeHttpService', () => {
  const service = new SsrfSafeHttpService();

  it.each([
    'http://127.0.0.1/admin',
    'http://10.0.0.1/',
    'http://169.254.169.254/latest/meta-data/',
    'http://[::1]/',
    'file:///etc/passwd',
  ])('blocks unsafe URL %s', async (url) => {
    await expect(service.assertSafe(new URL(url))).rejects.toMatchObject({ code: 'CRAWLER_URL_BLOCKED' });
  });

  it('allows a public literal IP without making a network request', async () => {
    await expect(service.assertSafe(new URL('https://8.8.8.8/'))).resolves.toBeUndefined();
  });

  it('stops streaming a response once it exceeds the byte limit without Content-Length', async () => {
    const close = jest.fn().mockResolvedValue(undefined);
    const dispatcher = { close } as unknown as Agent;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let index = 0; index < 6; index += 1) controller.enqueue(new Uint8Array(1024 * 1024));
        controller.close();
      },
    });
    const response = new Response(body, { headers: { 'content-type': 'text/html' } });
    const target = service as unknown as {
      safeFetch(url: URL): Promise<{ response: Response; dispatcher: Agent }>;
    };
    jest.spyOn(target, 'safeFetch').mockResolvedValue({ response, dispatcher });

    await expect(service.getText('https://8.8.8.8/source')).rejects.toMatchObject({ code: 'CRAWLER_URL_BLOCKED' });
    expect(close).toHaveBeenCalledTimes(1);
  });
});
