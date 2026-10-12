import { lookup as systemLookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';

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
] as const;

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

export interface BrowserResolvedAddress {
  address: string;
  family: number;
}

export type BrowserHostResolver = (
  hostname: string,
) => Promise<readonly BrowserResolvedAddress[]>;

const defaultResolver: BrowserHostResolver = (hostname) =>
  systemLookup(hostname, { all: true, verbatim: true });

export function normalizeBrowserHostname(value: string): string {
  return value.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
}

export function isBlockedBrowserAddress(raw: string): boolean {
  const value = normalizeBrowserHostname(raw).split('%')[0] ?? normalizeBrowserHostname(raw);
  const family = isIP(value);
  if (family === 4) return BLOCKED_IPV4_NETWORKS.check(value, 'ipv4');
  if (family === 6) return BLOCKED_IPV6_NETWORKS.check(value, 'ipv6');
  return true;
}

export function hostnameMatches(hostname: string, allowedHosts: readonly string[]): boolean {
  const normalized = normalizeBrowserHostname(hostname);
  return allowedHosts.some((allowed) => {
    const expected = normalizeBrowserHostname(allowed).replace(/^\./, '');
    return normalized === expected || normalized.endsWith(`.${expected}`);
  });
}

/**
 * Resolve once and return only the addresses that were validated. Callers that
 * open a socket must connect to one of these returned IP literals rather than
 * resolving the hostname a second time.
 */
export async function resolvePublicBrowserHost(
  input: string,
  resolver: BrowserHostResolver = defaultResolver,
): Promise<readonly BrowserResolvedAddress[]> {
  const hostname = normalizeBrowserHostname(input);
  if (
    !hostname
    || BLOCKED_HOSTS.has(hostname)
    || BLOCKED_HOST_SUFFIXES.some((suffix) => hostname.endsWith(suffix))
  ) {
    throw new Error('Local and internal browser targets are blocked');
  }
  const literalFamily = isIP(hostname);
  const addresses = literalFamily
    ? [{ address: hostname, family: literalFamily }]
    : await resolver(hostname);
  if (!addresses.length || addresses.some(({ address }) => isBlockedBrowserAddress(address))) {
    throw new Error('Private, local, reserved, and metadata browser targets are blocked');
  }
  return addresses;
}

export async function assertPublicBrowserUrl(
  input: string,
  allowedHosts?: readonly string[],
): Promise<URL> {
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    throw new Error('Browser automation URL must be absolute');
  }
  if (parsed.protocol !== 'https:') throw new Error('Browser automation only permits HTTPS URLs');
  if (parsed.username || parsed.password) throw new Error('Browser automation URLs cannot contain credentials');
  const hostname = normalizeBrowserHostname(parsed.hostname);
  if (allowedHosts?.length && !hostnameMatches(hostname, allowedHosts)) {
    throw new Error('Browser navigation left the recipe host allowlist');
  }
  await resolvePublicBrowserHost(hostname);
  return parsed;
}

export function safeBrowserActionUrl(input: string): string | undefined {
  try {
    const parsed = new URL(input);
    if (parsed.protocol !== 'https:') return undefined;
    parsed.username = '';
    parsed.password = '';
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return undefined;
  }
}
