import type { ConfigService } from '@nestjs/config';
import { connect as connectClient, createServer as createTcpServer, Socket } from 'node:net';
import type { AddressInfo } from 'node:net';
import type { BrowserHostResolver } from './browser-navigation-safety';
import {
  BrowserNetworkGuard,
  BrowserProxyConfigurationError,
  parseBrowserProxyMap,
  startPinnedBrowserProxy,
} from './browser-network-guard.service';

/** A local TCP server standing in for an admin-configured CONNECT proxy. */
async function startFakeUpstreamProxy(reply: string): Promise<{
  port: number;
  requests: string[];
  close(): Promise<void>;
}> {
  const requests: string[] = [];
  const sockets = new Set<Socket>();
  const server = createTcpServer((socket) => {
    sockets.add(socket);
    socket.on('error', () => undefined);
    let data = '';
    socket.on('data', (chunk: Buffer) => {
      data += chunk.toString('latin1');
      if (!data.includes('\r\n\r\n') || requests.length > 0) return;
      requests.push(data);
      socket.write(reply);
      if (!reply.startsWith('HTTP/1.1 200')) socket.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: (server.address() as AddressInfo).port,
    requests,
    close: () => new Promise<void>((resolve) => {
      for (const socket of sockets) socket.destroy();
      server.close(() => resolve());
    }),
  };
}

function fakeConnectedSocket(): Socket {
  const socket = new Socket();
  setImmediate(() => socket.emit('connect'));
  return socket;
}

async function sendProxyRequest(server: string, request: string): Promise<string> {
  const proxy = new URL(server);
  return new Promise((resolve, reject) => {
    const socket = connectClient({ host: proxy.hostname, port: Number(proxy.port) });
    let response = '';
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('Timed out waiting for proxy response'));
    }, 2_000);
    socket.once('error', reject);
    socket.once('connect', () => socket.write(request));
    socket.on('data', (chunk: Buffer) => {
      response += chunk.toString('utf8');
      if (!response.includes('\r\n\r\n')) return;
      clearTimeout(timer);
      socket.destroy();
      resolve(response);
    });
  });
}

describe('pinned browser network proxy', () => {
  it('connects to the already-validated IP instead of resolving the hostname again', async () => {
    const resolver = jest.fn<ReturnType<BrowserHostResolver>, Parameters<BrowserHostResolver>>()
      .mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
    const connector = jest.fn().mockImplementation(() => fakeConnectedSocket());
    const proxy = await startPinnedBrowserProxy({ resolver, connect: connector });
    try {
      const response = await sendProxyRequest(
        proxy.server,
        'CONNECT cdn.example.net:443 HTTP/1.1\r\nHost: cdn.example.net:443\r\n\r\n',
      );

      expect(response).toContain('200 Connection Established');
      expect(resolver).toHaveBeenCalledTimes(1);
      expect(resolver).toHaveBeenCalledWith('cdn.example.net');
      expect(connector).toHaveBeenCalledWith({
        host: '93.184.216.34',
        port: 443,
        family: 4,
      });
      expect(proxy.chromiumArgs).toEqual(expect.arrayContaining([
        '--proxy-bypass-list=<-loopback>',
        '--disable-quic',
        '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
      ]));
    } finally {
      await proxy.close();
    }
  });

  it('rejects a DNS answer containing a private address before opening a socket', async () => {
    const resolver = jest.fn<ReturnType<BrowserHostResolver>, Parameters<BrowserHostResolver>>()
      .mockResolvedValue([
        { address: '93.184.216.34', family: 4 },
        { address: '127.0.0.1', family: 4 },
      ]);
    const connector = jest.fn().mockImplementation(() => fakeConnectedSocket());
    const proxy = await startPinnedBrowserProxy({ resolver, connect: connector });
    try {
      const response = await sendProxyRequest(
        proxy.server,
        'CONNECT rebinding.example.net:443 HTTP/1.1\r\nHost: rebinding.example.net:443\r\n\r\n',
      );

      expect(response).toContain('403 Forbidden');
      expect(connector).not.toHaveBeenCalled();
    } finally {
      await proxy.close();
    }
  });

  it('rejects plaintext proxy requests so browser egress remains HTTPS-only', async () => {
    const resolver = jest.fn<ReturnType<BrowserHostResolver>, Parameters<BrowserHostResolver>>();
    const proxy = await startPinnedBrowserProxy({ resolver });
    try {
      const response = await sendProxyRequest(
        proxy.server,
        'GET http://example.com/ HTTP/1.1\r\nHost: example.com\r\nConnection: close\r\n\r\n',
      );

      expect(response).toContain('403 Forbidden');
      expect(resolver).not.toHaveBeenCalled();
    } finally {
      await proxy.close();
    }
  });
});

describe('pinned browser network proxy through an upstream egress proxy', () => {
  it('tunnels to the validated IP literal, never the hostname, with proxy credentials', async () => {
    const resolver = jest.fn<ReturnType<BrowserHostResolver>, Parameters<BrowserHostResolver>>()
      .mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
    const upstream = await startFakeUpstreamProxy('HTTP/1.1 200 Connection established\r\n\r\n');
    const proxy = await startPinnedBrowserProxy({
      resolver,
      upstream: {
        name: 'vn-1',
        host: '127.0.0.1',
        port: upstream.port,
        authorization: 'Basic dXNlcjpwYXNz',
      },
    });
    try {
      const response = await sendProxyRequest(
        proxy.server,
        'CONNECT cdn.example.net:443 HTTP/1.1\r\nHost: cdn.example.net:443\r\n\r\n',
      );

      expect(response).toContain('200 Connection Established');
      expect(upstream.requests).toHaveLength(1);
      expect(upstream.requests[0]).toMatch(/^CONNECT 93\.184\.216\.34:443 HTTP\/1\.1\r\n/);
      expect(upstream.requests[0]).toContain('Proxy-Authorization: Basic dXNlcjpwYXNz');
      expect(upstream.requests[0]).not.toContain('cdn.example.net');
    } finally {
      await proxy.close();
      await upstream.close();
    }
  });

  it('refuses the browser tunnel when the upstream proxy rejects it', async () => {
    const resolver = jest.fn<ReturnType<BrowserHostResolver>, Parameters<BrowserHostResolver>>()
      .mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
    const upstream = await startFakeUpstreamProxy(
      'HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\n\r\n',
    );
    const proxy = await startPinnedBrowserProxy({
      resolver,
      upstream: { name: 'vn-1', host: '127.0.0.1', port: upstream.port },
    });
    try {
      const response = await sendProxyRequest(
        proxy.server,
        'CONNECT cdn.example.net:443 HTTP/1.1\r\nHost: cdn.example.net:443\r\n\r\n',
      );
      expect(response).toContain('403 Forbidden');
    } finally {
      await proxy.close();
      await upstream.close();
    }
  });

  it('still rejects a private DNS answer before contacting the upstream proxy', async () => {
    const resolver = jest.fn<ReturnType<BrowserHostResolver>, Parameters<BrowserHostResolver>>()
      .mockResolvedValue([{ address: '10.0.0.5', family: 4 }]);
    const upstream = await startFakeUpstreamProxy('HTTP/1.1 200 Connection established\r\n\r\n');
    const proxy = await startPinnedBrowserProxy({
      resolver,
      upstream: { name: 'vn-1', host: '127.0.0.1', port: upstream.port },
    });
    try {
      const response = await sendProxyRequest(
        proxy.server,
        'CONNECT internal.example.net:443 HTTP/1.1\r\nHost: internal.example.net:443\r\n\r\n',
      );
      expect(response).toContain('403 Forbidden');
      expect(upstream.requests).toHaveLength(0);
    } finally {
      await proxy.close();
      await upstream.close();
    }
  });
});

describe('BROWSER_PROXIES configuration', () => {
  it('parses named http proxies and pre-encodes credentials', () => {
    const proxies = parseBrowserProxyMap(JSON.stringify({
      'VN-1': 'http://user:p%40ss@proxy.example.com:3128',
      office: 'http://10.1.2.3:8080',
    }));
    expect(proxies.get('vn-1')).toEqual({
      name: 'vn-1',
      host: 'proxy.example.com',
      port: 3128,
      authorization: `Basic ${Buffer.from('user:p@ss').toString('base64')}`,
    });
    expect(proxies.get('office')).toEqual({ name: 'office', host: '10.1.2.3', port: 8080 });
  });

  it('treats an empty value as "no proxies"', () => {
    expect(parseBrowserProxyMap(undefined).size).toBe(0);
    expect(parseBrowserProxyMap('').size).toBe(0);
  });

  it.each([
    'not json',
    JSON.stringify(['http://proxy:3128']),
    JSON.stringify({ 'bad name!': 'http://proxy:3128' }),
    JSON.stringify({ vn: 'https://user:secret@proxy:3128' }),
    JSON.stringify({ vn: 'socks5://user:secret@proxy:1080' }),
    JSON.stringify({ vn: 'http://user:secret@proxy:3128/path' }),
  ])('rejects invalid BROWSER_PROXIES %s without leaking credentials', (raw) => {
    let caught: unknown;
    try {
      parseBrowserProxyMap(raw);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(BrowserProxyConfigurationError);
    expect((caught as Error).message).not.toContain('secret');
  });

  it('refuses an unknown proxy name instead of silently using the server IP', async () => {
    const guard = new BrowserNetworkGuard({
      get: () => JSON.stringify({ 'vn-1': 'http://127.0.0.1:3128' }),
    } as unknown as ConfigService);

    await expect(guard.startProxy('missing')).rejects.toBeInstanceOf(BrowserProxyConfigurationError);
    const proxy = await guard.startProxy('VN-1');
    await proxy.close();
  });
});
