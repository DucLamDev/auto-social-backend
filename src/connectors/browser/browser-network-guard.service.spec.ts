import { connect as connectClient, Socket } from 'node:net';
import type { BrowserHostResolver } from './browser-navigation-safety';
import { startPinnedBrowserProxy } from './browser-network-guard.service';

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
