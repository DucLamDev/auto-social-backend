import { Response } from 'undici';
import {
  ConnectorFetch,
  ConnectorHostResolver,
  ConnectorOutboundHttpClient,
} from './connector-outbound-http.client';

function resolver(...addresses: string[]): jest.MockedFunction<ConnectorHostResolver> {
  return jest.fn().mockResolvedValue(
    addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 })),
  );
}

function fetcher(...responses: Response[]): jest.MockedFunction<ConnectorFetch> {
  return jest.fn().mockImplementation(() => {
    const response = responses.shift();
    if (!response) throw new Error('Unexpected fetch');
    return Promise.resolve(response);
  }) as jest.MockedFunction<ConnectorFetch>;
}

describe('ConnectorOutboundHttpClient', () => {
  it.each([
    'https://127.0.0.1/admin',
    'https://10.0.0.1/',
    'https://169.254.169.254/latest/meta-data/',
    'https://[::1]/',
    'https://[::ffff:127.0.0.1]/',
    'http://8.8.8.8/insecure',
  ])('blocks unsafe connector URL %s before transport', async (url) => {
    const transport = fetcher(new Response('{}'));
    const client = new ConnectorOutboundHttpClient({ fetch: transport });

    await expect(client.request(url, {}, 1_000)).rejects.toMatchObject({
      code: 'PLATFORM_AUTH_FAILED',
      retryable: false,
    });
    expect(transport).not.toHaveBeenCalled();
  });

  it('blocks a hostname when DNS includes a private address', async () => {
    const resolve = resolver('93.184.216.34', '10.0.0.8');
    const transport = fetcher(new Response('{}'));
    const client = new ConnectorOutboundHttpClient({ resolve, fetch: transport });

    await expect(client.request('https://social.example.org/api', {}, 1_000)).rejects.toMatchObject({
      code: 'PLATFORM_AUTH_FAILED',
    });
    expect(transport).not.toHaveBeenCalled();
  });

  it('pins a validated public resolution and allows the request', async () => {
    const resolve = resolver('93.184.216.34');
    const transport = fetcher(new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    const client = new ConnectorOutboundHttpClient({ resolve, fetch: transport });

    await expect(client.request('https://social.example.org/api', {}, 1_000)).resolves.toMatchObject({
      ok: true,
      status: 200,
      text: '{"ok":true}',
    });
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(transport).toHaveBeenCalledTimes(1);
    expect(transport.mock.calls[0]?.[0]).toEqual(new URL('https://social.example.org/api'));
    expect(transport.mock.calls[0]?.[1]).toMatchObject({ redirect: 'manual' });
    expect(transport.mock.calls[0]?.[1]?.dispatcher).toBeDefined();
  });

  it('rejects a redirect to a private IP before sending the redirected request', async () => {
    const resolve = resolver('93.184.216.34');
    const transport = fetcher(new Response(null, {
      status: 302,
      headers: { location: 'https://127.0.0.1/admin' },
    }));
    const client = new ConnectorOutboundHttpClient({ resolve, fetch: transport });

    await expect(client.request('https://social.example.org/start', {}, 1_000)).rejects.toMatchObject({
      code: 'PLATFORM_AUTH_FAILED',
    });
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it('detects DNS rebinding on a same-origin redirect', async () => {
    const resolve = jest.fn()
      .mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }])
      .mockResolvedValueOnce([{ address: '127.0.0.1', family: 4 }]) as jest.MockedFunction<ConnectorHostResolver>;
    const transport = fetcher(new Response(null, {
      status: 307,
      headers: { location: '/next' },
    }));
    const client = new ConnectorOutboundHttpClient({ resolve, fetch: transport });

    await expect(client.request('https://social.example.org/start', {}, 1_000)).rejects.toMatchObject({
      code: 'PLATFORM_AUTH_FAILED',
    });
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it('does not forward credentials through a cross-origin redirect', async () => {
    const resolve = resolver('93.184.216.34');
    const transport = fetcher(new Response(null, {
      status: 307,
      headers: { location: 'https://other.example.org/api' },
    }));
    const client = new ConnectorOutboundHttpClient({ resolve, fetch: transport });

    await expect(client.request('https://social.example.org/start', {
      headers: { authorization: 'Bearer secret' },
    }, 1_000)).rejects.toMatchObject({ code: 'PLATFORM_AUTH_FAILED' });
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it('stops reading a connector response after 5 MiB', async () => {
    const resolve = resolver('93.184.216.34');
    const transport = fetcher(new Response(Buffer.alloc(5 * 1024 * 1024 + 1, 0x61), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    const client = new ConnectorOutboundHttpClient({ resolve, fetch: transport });

    await expect(client.request('https://social.example.org/api', {}, 1_000)).rejects.toMatchObject({
      code: 'PLATFORM_API_ERROR',
      retryable: false,
      message: 'Connector response exceeds 5 MiB',
    });
  });
});
