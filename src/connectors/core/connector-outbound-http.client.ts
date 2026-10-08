import { lookup as systemLookup } from 'node:dns/promises';
import { BlockList, isIP, type LookupFunction } from 'node:net';
import { Agent, Response, fetch as undiciFetch } from 'undici';
import { ErrorCode } from '../../common/exceptions/application.exception';
import { ConnectorError } from './connector-error';

const MAX_REDIRECTS = 5;
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;

const BLOCKED_HOSTS = new Set([
  'localhost',
  'localhost.localdomain',
  'metadata.google.internal',
  'instance-data.ec2.internal',
]);

const BLOCKED_HOST_SUFFIXES = [
  '.localhost',
  '.local',
  '.internal',
  '.lan',
  '.home',
  '.test',
  '.invalid',
  '.example',
];

// Keep the families in separate lists. Node's BlockList intentionally treats an
// IPv4 address as its IPv4-mapped IPv6 equivalent when both share one list.
const BLOCKED_IPV4_NETWORKS = new BlockList();
const BLOCKED_IPV6_NETWORKS = new BlockList();

for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  BLOCKED_IPV4_NETWORKS.addSubnet(network, prefix, 'ipv4');
}

for (const [network, prefix] of [
  ['::', 128],
  ['::1', 128],
  // IPv4-mapped IPv6 literals must not bypass the IPv4 private/reserved ranges.
  ['::ffff:0:0', 96],
  ['64:ff9b::', 96],
  ['64:ff9b:1::', 48],
  ['100::', 64],
  ['2001::', 32],
  ['2001:10::', 28],
  ['2001:20::', 28],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['fc00::', 7],
  ['fe80::', 10],
  ['fec0::', 10],
  ['ff00::', 8],
] as const) {
  BLOCKED_IPV6_NETWORKS.addSubnet(network, prefix, 'ipv6');
}

export interface ConnectorResolvedAddress {
  address: string;
  family: number;
}

export type ConnectorHostResolver = (
  hostname: string,
) => Promise<readonly ConnectorResolvedAddress[]>;

export type ConnectorFetch = typeof undiciFetch;

export interface ConnectorOutboundHttpResponse {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  text: string;
}

interface ConnectorOutboundHttpOptions {
  resolve?: ConnectorHostResolver;
  fetch?: ConnectorFetch;
}

const defaultResolver: ConnectorHostResolver = (hostname) =>
  systemLookup(hostname, { all: true, verbatim: true });

const normalizeHostname = (value: string): string =>
  value.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');

/**
 * Return only the DNS results that were validated before opening the socket.
 *
 * Node may request all addresses so it can race IPv4/IPv6 connections. Its
 * lookup callback contract changes in that mode: it expects LookupAddress[]
 * instead of a single address string. Returning the scalar form for an
 * `all: true` lookup makes Node reject the connection with
 * ERR_INVALID_IP_ADDRESS before any HTTP request reaches the platform.
 */
export function createPinnedLookup(
  expectedHostname: string,
  addresses: readonly ConnectorResolvedAddress[],
): LookupFunction {
  const normalizedExpected = normalizeHostname(expectedHostname);

  return (hostname, options, callback) => {
    const fail = (message: string): void => {
      const error = new Error(message);
      if (options.all) callback(error, []);
      else callback(error, '');
    };

    if (normalizeHostname(hostname) !== normalizedExpected) {
      fail('Unexpected connector DNS hostname');
      return;
    }

    const requestedFamily = options.family === 4 || options.family === 'IPv4'
      ? 4
      : options.family === 6 || options.family === 'IPv6'
        ? 6
        : undefined;
    const candidates = addresses.filter(
      (candidate) => requestedFamily === undefined || candidate.family === requestedFamily,
    );

    if (!candidates.length) {
      fail('No validated connector address for requested family');
      return;
    }

    if (options.all) {
      callback(
        null,
        candidates.map(({ address, family }) => ({ address, family })),
      );
      return;
    }

    const address = candidates[0]!;
    callback(null, address.address, address.family);
  };
}

/**
 * HTTP transport for connector endpoints supplied by an administrator.
 *
 * Every hop is HTTPS-only, resolves exclusively to public addresses, and uses
 * a one-shot Undici dispatcher pinned to the addresses that were validated.
 * Redirects are handled manually so they cannot bypass validation or forward
 * connector credentials to another origin.
 */
export class ConnectorOutboundHttpClient {
  private readonly resolve: ConnectorHostResolver;
  private readonly fetchImplementation: ConnectorFetch;

  constructor(options: ConnectorOutboundHttpOptions = {}) {
    this.resolve = options.resolve ?? defaultResolver;
    this.fetchImplementation = options.fetch ?? undiciFetch;
  }

  async request(
    input: string,
    init: RequestInit,
    timeoutMs: number,
  ): Promise<ConnectorOutboundHttpResponse> {
    let current = this.parseUrl(input);
    let requestInit = { ...init };
    const signal = AbortSignal.timeout(timeoutMs);

    for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
      const addresses = await this.resolvePublicAddresses(current);
      const dispatcher = this.createPinnedDispatcher(current.hostname, addresses);
      try {
        const response = await this.fetchImplementation(
          current,
          {
            ...(requestInit as Parameters<ConnectorFetch>[1]),
            redirect: 'manual',
            signal,
            dispatcher,
          },
        );

        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get('location');
          await response.body?.cancel();
          if (!location || redirect === MAX_REDIRECTS) {
            this.block('Connector redirect limit exceeded or Location is missing');
          }
          const next = this.parseUrl(new URL(location, current).toString());
          if (next.origin !== current.origin) {
            this.block('Connector redirects must remain on the configured origin');
          }
          requestInit = this.redirectedRequestInit(requestInit, response.status);
          current = next;
          continue;
        }

        const declaredLength = Number(response.headers.get('content-length') ?? 0);
        if (declaredLength > MAX_RESPONSE_BYTES) {
          await response.body?.cancel();
          this.responseTooLarge();
        }
        return {
          ok: response.ok,
          status: response.status,
          headers: response.headers,
          text: await this.readLimitedText(response),
        };
      } finally {
        await dispatcher.close().catch(() => undefined);
      }
    }

    this.block('Connector redirect limit exceeded');
  }

  private parseUrl(value: string): URL {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      this.block('Connector endpoint must be an absolute HTTPS URL');
    }
    if (url.protocol !== 'https:') this.block('Connector endpoint must use HTTPS');
    if (url.username || url.password) this.block('Connector endpoint must not contain URL credentials');
    return url;
  }

  private async resolvePublicAddresses(url: URL): Promise<readonly ConnectorResolvedAddress[]> {
    const hostname = this.normalizedHostname(url.hostname);
    if (
      BLOCKED_HOSTS.has(hostname)
      || BLOCKED_HOST_SUFFIXES.some((suffix) => hostname.endsWith(suffix))
    ) {
      this.block('Connector endpoint hostname is local or reserved');
    }

    let addresses: readonly ConnectorResolvedAddress[];
    if (isIP(hostname)) {
      addresses = [{ address: hostname, family: isIP(hostname) }];
    } else {
      try {
        addresses = await this.resolve(hostname);
      } catch {
        throw new ConnectorError(
          ErrorCode.PLATFORM_API_ERROR,
          'Connector endpoint DNS lookup failed',
          true,
        );
      }
    }

    if (!addresses.length || addresses.some(({ address }) => this.isBlockedAddress(address))) {
      this.block('Connector endpoint must resolve only to public IP addresses');
    }
    return addresses;
  }

  private createPinnedDispatcher(
    expectedHostname: string,
    addresses: readonly ConnectorResolvedAddress[],
  ): Agent {
    return new Agent({
      connect: {
        lookup: createPinnedLookup(expectedHostname, addresses),
      },
    });
  }

  private redirectedRequestInit(init: RequestInit, status: number): RequestInit {
    const method = (init.method ?? 'GET').toUpperCase();
    if (status !== 303 && !([301, 302].includes(status) && method === 'POST')) return init;
    const headers = new Headers(init.headers);
    headers.delete('content-length');
    headers.delete('content-type');
    return { ...init, method: method === 'HEAD' ? 'HEAD' : 'GET', body: undefined, headers };
  }

  private async readLimitedText(response: Response): Promise<string> {
    if (!response.body) return '';
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of response.body as AsyncIterable<Uint8Array>) {
      total += chunk.byteLength;
      if (total > MAX_RESPONSE_BYTES) this.responseTooLarge();
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks, total).toString('utf8');
  }

  private normalizedHostname(value: string): string {
    return normalizeHostname(value);
  }

  private isBlockedAddress(raw: string): boolean {
    const address = raw.toLowerCase().split('%')[0] ?? raw.toLowerCase();
    const family = isIP(address);
    if (family === 4) return BLOCKED_IPV4_NETWORKS.check(address, 'ipv4');
    if (family === 6) return BLOCKED_IPV6_NETWORKS.check(address, 'ipv6');
    return true;
  }

  private block(message: string): never {
    throw new ConnectorError(ErrorCode.PLATFORM_AUTH_FAILED, message, false);
  }

  private responseTooLarge(): never {
    throw new ConnectorError(
      ErrorCode.PLATFORM_API_ERROR,
      'Connector response exceeds 5 MiB',
      false,
    );
  }
}
