import { Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { connect, type Socket } from 'node:net';
import type { BrowserContext, Route } from 'playwright';
import { BROWSER_PROXY_NAME_PATTERN } from './browser-context-profile';
import {
  assertPublicBrowserUrl,
  normalizeBrowserHostname,
  resolvePublicBrowserHost,
  type BrowserHostResolver,
  type BrowserResolvedAddress,
} from './browser-navigation-safety';

const PROXY_CONNECT_TIMEOUT_MS = 10_000;
const MAX_UPSTREAM_RESPONSE_BYTES = 16 * 1024;

/**
 * Admin-configured HTTP CONNECT proxy used as an account's egress, so the
 * publish runs leave from the same IP the account owner logged in through.
 */
export interface BrowserUpstreamProxy {
  readonly name: string;
  readonly host: string;
  readonly port: number;
  /** Pre-encoded `Basic …` header value. Never logged or returned to clients. */
  readonly authorization?: string;
}

/** Proxy misconfiguration; messages carry only the proxy name, never its URL. */
export class BrowserProxyConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BrowserProxyConfigurationError';
  }
}

export function parseBrowserUpstreamProxy(name: string, value: unknown): BrowserUpstreamProxy {
  if (!BROWSER_PROXY_NAME_PATTERN.test(name)) {
    throw new BrowserProxyConfigurationError(`BROWSER_PROXIES contains an invalid proxy name '${name}'`);
  }
  const invalid = () => new BrowserProxyConfigurationError(
    `Browser proxy '${name}' must be an http://[user:password@]host:port URL`,
  );
  if (typeof value !== 'string') throw invalid();
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw invalid();
  }
  if (
    parsed.protocol !== 'http:'
    || !parsed.hostname
    || (parsed.pathname !== '' && parsed.pathname !== '/')
    || parsed.search
    || parsed.hash
  ) {
    throw invalid();
  }
  const port = parsed.port ? Number(parsed.port) : 80;
  let username: string;
  let password: string;
  try {
    username = decodeURIComponent(parsed.username);
    password = decodeURIComponent(parsed.password);
  } catch {
    throw invalid();
  }
  return {
    name: name.toLowerCase(),
    host: parsed.hostname.replace(/^\[|\]$/g, ''),
    port,
    ...(username || password
      ? { authorization: `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}` }
      : {}),
  };
}

/** Parses BROWSER_PROXIES: a JSON object of proxy name → http:// proxy URL. */
export function parseBrowserProxyMap(raw: unknown): ReadonlyMap<string, BrowserUpstreamProxy> {
  const proxies = new Map<string, BrowserUpstreamProxy>();
  if (raw === undefined || raw === null || raw === '') return proxies;
  let parsed: unknown = raw;
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      parsed = undefined;
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new BrowserProxyConfigurationError(
      'BROWSER_PROXIES must be a JSON object mapping proxy names to http:// proxy URLs',
    );
  }
  for (const [name, value] of Object.entries(parsed as Record<string, unknown>)) {
    const proxy = parseBrowserUpstreamProxy(name, value);
    if (proxies.has(proxy.name)) {
      throw new BrowserProxyConfigurationError(`BROWSER_PROXIES defines '${proxy.name}' more than once`);
    }
    proxies.set(proxy.name, proxy);
  }
  return proxies;
}

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
  /** Chain every validated tunnel through this admin-configured CONNECT proxy. */
  upstream?: BrowserUpstreamProxy;
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

/** Reads the upstream proxy's CONNECT reply; resolves with any bytes after the header. */
function readUpstreamConnectResponse(socket: Socket, timeoutMs: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let buffered = Buffer.alloc(0);
    const cleanup = () => {
      clearTimeout(timer);
      socket.off('data', onData);
      socket.off('error', onError);
      socket.off('close', onClose);
    };
    const fail = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onData = (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      const headerEnd = buffered.indexOf('\r\n\r\n');
      if (headerEnd === -1) {
        if (buffered.length > MAX_UPSTREAM_RESPONSE_BYTES) {
          fail(new Error('Browser upstream proxy response header is too large'));
        }
        return;
      }
      cleanup();
      // Hold further bytes until the caller pipes the tunnel to the browser.
      socket.pause();
      const statusLine = buffered.subarray(0, buffered.indexOf('\r\n')).toString('latin1');
      if (!/^HTTP\/1\.[01] 200(?: |$)/.test(statusLine)) {
        reject(new Error('Browser upstream proxy refused the tunnel'));
        return;
      }
      resolve(buffered.subarray(headerEnd + 4));
    };
    const onError = (error: Error) => fail(error);
    const onClose = () => fail(new Error('Browser upstream proxy closed the connection'));
    const timer = setTimeout(
      () => fail(new Error('Browser upstream proxy tunnel timed out')),
      timeoutMs,
    );
    socket.on('data', onData);
    socket.once('error', onError);
    socket.once('close', onClose);
  });
}

/**
 * Opens a CONNECT tunnel through the upstream proxy to an already-validated IP
 * literal. Sending the IP (not the hostname) keeps DNS pinning intact: the
 * upstream proxy cannot be steered to a different, unvalidated address.
 */
async function tunnelThroughUpstream(
  upstreamProxy: BrowserUpstreamProxy,
  addresses: readonly BrowserResolvedAddress[],
  port: number,
  connector: BrowserSocketConnector,
  timeoutMs: number,
): Promise<{ socket: Socket; leftover: Buffer }> {
  for (const { address, family } of addresses) {
    const socket = connector({ host: upstreamProxy.host, port: upstreamProxy.port, family: 0 });
    try {
      await waitForConnection(socket, timeoutMs);
      const authority = family === 6 ? `[${address}]:${port}` : `${address}:${port}`;
      const response = readUpstreamConnectResponse(socket, timeoutMs);
      socket.write(
        `CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n`
          + (upstreamProxy.authorization
            ? `Proxy-Authorization: ${upstreamProxy.authorization}\r\n`
            : '')
          + '\r\n',
      );
      return { socket, leftover: await response };
    } catch {
      socket.destroy();
    }
  }
  throw new Error('Browser upstream proxy could not open a tunnel to a validated public address');
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
  const upstreamProxy = options.upstream;
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
        let leftover: Buffer = Buffer.alloc(0);
        if (upstreamProxy) {
          const tunnel = await tunnelThroughUpstream(
            upstreamProxy,
            addresses,
            target.port,
            connector,
            timeoutMs,
          );
          upstream = tunnel.socket;
          leftover = tunnel.leftover;
        } else {
          upstream = await connectToValidatedAddress(addresses, target.port, connector, timeoutMs);
        }
        sockets.add(upstream);
        upstream.once('close', () => sockets.delete(upstream!));
        upstream.once('error', () => client.destroy());
        client.once('error', () => upstream?.destroy());
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (leftover.length) client.write(leftover);
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
  private readonly proxies: ReadonlyMap<string, BrowserUpstreamProxy>;

  constructor(@Optional() config?: ConfigService) {
    // Fail fast at boot on a malformed BROWSER_PROXIES secret.
    this.proxies = parseBrowserProxyMap(config?.get<unknown>('BROWSER_PROXIES'));
  }

  /**
   * Starts the pinned proxy. With `proxyName`, every tunnel is chained through
   * that admin-configured egress proxy; an unknown name is a configuration
   * error, never a silent fallback to the server's own IP.
   */
  startProxy(proxyName?: string): Promise<BrowserNetworkProxy> {
    if (!proxyName) return startPinnedBrowserProxy();
    const upstream = this.proxies.get(proxyName.toLowerCase());
    if (!upstream) {
      return Promise.reject(new BrowserProxyConfigurationError(
        `Browser proxy '${proxyName}' is not configured on this server; `
          + 'an administrator must add it to BROWSER_PROXIES',
      ));
    }
    return startPinnedBrowserProxy({ upstream });
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
