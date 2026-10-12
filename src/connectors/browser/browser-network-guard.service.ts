import { Injectable } from '@nestjs/common';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { connect, type Socket } from 'node:net';
import type { BrowserContext, Route } from 'playwright';
import {
  assertPublicBrowserUrl,
  normalizeBrowserHostname,
  resolvePublicBrowserHost,
  type BrowserHostResolver,
  type BrowserResolvedAddress,
} from './browser-navigation-safety';

const PROXY_CONNECT_TIMEOUT_MS = 10_000;

export interface BrowserNetworkProxy {
  readonly server: string;
  /** Chromium defenses against proxy bypass through loopback, QUIC, or WebRTC. */
  readonly chromiumArgs: readonly string[];
  close(): Promise<void>;
}

type BrowserSocketConnector = (options: {
  host: string;
  port: number;
  family: number;
}) => Socket;

export interface BrowserNetworkProxyOptions {
  resolver?: BrowserHostResolver;
  connect?: BrowserSocketConnector;
  connectTimeoutMs?: number;
}

interface ConnectTarget {
  hostname: string;
  port: number;
}

function parseConnectTarget(authority: string | undefined): ConnectTarget {
  if (!authority || /[/?#]/.test(authority)) throw new Error('Invalid browser proxy target');
  let parsed: URL;
  try {
    parsed = new URL(`https://${authority}`);
  } catch {
    throw new Error('Invalid browser proxy target');
  }
  if (parsed.username || parsed.password) throw new Error('Invalid browser proxy target');
  const port = parsed.port ? Number(parsed.port) : 443;
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error('Invalid browser proxy port');
  }
  return { hostname: normalizeBrowserHostname(parsed.hostname), port };
}

function waitForConnection(socket: Socket, timeoutMs: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    let connected = false;
    const cleanup = () => {
      socket.off('connect', onConnect);
      socket.off('error', onError);
      socket.off('timeout', onTimeout);
      socket.off('close', onClose);
    };
    const onConnect = () => {
      connected = true;
      cleanup();
      socket.setTimeout(0);
      resolve(socket);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onTimeout = () => {
      cleanup();
      socket.destroy();
      reject(new Error('Browser proxy upstream connection timed out'));
    };
    const onClose = () => {
      if (connected) return;
      cleanup();
      reject(new Error('Browser proxy upstream connection closed'));
    };
    socket.once('connect', onConnect);
    socket.once('error', onError);
    socket.once('timeout', onTimeout);
    socket.once('close', onClose);
    socket.setTimeout(timeoutMs);
  });
}

async function connectToValidatedAddress(
  addresses: readonly BrowserResolvedAddress[],
  port: number,
  connector: BrowserSocketConnector,
  timeoutMs: number,
): Promise<Socket> {
  const sockets = addresses.map(({ address, family }) => connector({
    host: address,
    port,
    family,
  }));
  try {
    const connected = await Promise.any(sockets.map((socket) => waitForConnection(socket, timeoutMs)));
    for (const socket of sockets) {
      if (socket !== connected) socket.destroy();
    }
    return connected;
  } catch {
    for (const socket of sockets) socket.destroy();
    throw new Error('Browser proxy could not connect to a validated public address');
  }
}

function rejectProxySocket(socket: Socket, status = '403 Forbidden'): void {
  if (!socket.destroyed) socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
}

/**
 * Start a loopback-only CONNECT proxy. It resolves each destination once,
 * validates every answer, and opens the upstream socket by IP literal. The
 * browser therefore cannot perform a second, attacker-controlled DNS lookup.
 * TLS remains end-to-end between Chromium and the destination, preserving SNI,
 * certificate validation, cookies, streaming, and arbitrary public CDN hosts.
 */
export async function startPinnedBrowserProxy(
  options: BrowserNetworkProxyOptions = {},
): Promise<BrowserNetworkProxy> {
  const resolver = options.resolver;
  const connector = options.connect ?? ((input) => connect(input));
  const timeoutMs = options.connectTimeoutMs ?? PROXY_CONNECT_TIMEOUT_MS;
  const sockets = new Set<Socket>();
  const server = createServer((_request, response) => {
    response.writeHead(403, { connection: 'close' });
    response.end();
  });

  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  server.on('connect', (request: IncomingMessage, client: Socket, head: Buffer) => {
    void (async () => {
      let upstream: Socket | undefined;
      try {
        const target = parseConnectTarget(request.url);
        const addresses = await resolvePublicBrowserHost(target.hostname, resolver);
        upstream = await connectToValidatedAddress(addresses, target.port, connector, timeoutMs);
        sockets.add(upstream);
        upstream.once('close', () => sockets.delete(upstream!));
        upstream.once('error', () => client.destroy());
        client.once('error', () => upstream?.destroy());
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length) upstream.write(head);
        client.pipe(upstream).pipe(client);
      } catch {
        upstream?.destroy();
        rejectProxySocket(client);
      }
    })();
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(0, '127.0.0.1');
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    await closeProxyServer(server, sockets);
    throw new Error('Browser network proxy did not bind to a TCP port');
  }
  let closed = false;
  return {
    server: `http://127.0.0.1:${address.port}`,
    chromiumArgs: [
      '--proxy-bypass-list=<-loopback>',
      '--disable-quic',
      '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
      '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1',
    ],
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      await closeProxyServer(server, sockets);
    },
  };
}

async function closeProxyServer(server: Server, sockets: Set<Socket>): Promise<void> {
  for (const socket of sockets) socket.destroy();
  sockets.clear();
  if (!server.listening) return;
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

@Injectable()
export class BrowserNetworkGuard {
  startProxy(): Promise<BrowserNetworkProxy> {
    return startPinnedBrowserProxy();
  }

  async install(context: BrowserContext, allowedHosts: readonly string[]): Promise<void> {
    await context.route('**/*', async (route) => {
      const request = route.request();
      const input = request.url();
      if (/^(about:|blob:|data:)/i.test(input)) {
        await route.continue();
        return;
      }
      try {
        const mainDocument = request.isNavigationRequest() && request.frame().parentFrame() === null;
        await assertPublicBrowserUrl(input, mainDocument ? allowedHosts : undefined);
        await route.continue();
      } catch {
        await this.abort(route);
      }
    });
    await context.routeWebSocket('**/*', async (route) => {
      const input = route.url();
      try {
        if (!input.startsWith('wss://')) throw new Error('Only secure WebSockets are allowed');
        await assertPublicBrowserUrl(`https://${input.slice('wss://'.length)}`);
        route.connectToServer();
      } catch {
        await route.close({ code: 1008, reason: 'Blocked by browser automation network policy' })
          .catch(() => undefined);
      }
    });
  }

  private async abort(route: Route): Promise<void> {
    await route.abort('blockedbyclient').catch(() => undefined);
  }
}
