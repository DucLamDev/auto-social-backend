import { HttpStatus, Injectable } from '@nestjs/common';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { Agent, fetch, Response } from 'undici';
import { ApplicationException, ErrorCode } from '../common/exceptions/application.exception';

const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const BLOCKED_HOSTS = new Set(['localhost', 'localhost.localdomain', 'metadata.google.internal']);

@Injectable()
export class SsrfSafeHttpService {
  async getText(input: string, acceptedTypes: string[] = ['text/html', 'application/xml', 'text/xml', 'application/rss+xml', 'application/json']): Promise<{ body: string; finalUrl: string; contentType: string }> {
    let current = new URL(input);
    for (let redirect = 0; redirect <= 5; redirect += 1) {
      await this.assertSafe(current);
      const { response, dispatcher } = await this.safeFetch(current);
      try {
        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get('location');
          await response.body?.cancel();
          if (!location || redirect === 5) this.block('Crawler redirect limit exceeded');
          current = new URL(location, current);
          continue;
        }
        if (!response.ok) {
          await response.body?.cancel();
          throw new ApplicationException(
            ErrorCode.PLATFORM_API_ERROR,
            `Source returned HTTP ${response.status}`,
            HttpStatus.BAD_GATEWAY,
          );
        }
        const length = Number(response.headers.get('content-length') ?? 0);
        if (length > MAX_RESPONSE_BYTES) {
          await response.body?.cancel();
          this.block('Crawler response exceeds 5 MiB');
        }
        const contentType = (response.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
        if (!acceptedTypes.includes(contentType)) {
          await response.body?.cancel();
          this.block(`Crawler content type '${contentType}' is not allowed`);
        }
        const buffer = await this.readLimitedBody(response);
        return { body: buffer.toString('utf8'), finalUrl: current.toString(), contentType };
      } finally {
        await dispatcher.close().catch(() => undefined);
      }
    }
    this.block('Crawler redirect limit exceeded');
  }

  async assertSafe(url: URL): Promise<void> {
    if (!['http:', 'https:'].includes(url.protocol)) this.block('Only HTTP(S) source URLs are allowed');
    if (url.username || url.password) this.block('Source URLs cannot contain credentials');
    const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
    if (BLOCKED_HOSTS.has(hostname) || hostname.endsWith('.local') || hostname.endsWith('.internal')) {
      this.block('Local and internal hostnames are blocked');
    }
    const addresses = isIP(hostname) ? [{ address: hostname }] : await lookup(hostname, { all: true, verbatim: true });
    if (!addresses.length || addresses.some(({ address }) => this.isBlockedAddress(address))) {
      this.block('Private, local, reserved, and metadata IP addresses are blocked');
    }
  }

  private async safeFetch(url: URL): Promise<{ response: Response; dispatcher: Agent }> {
    const dispatcher = new Agent({
      connect: {
        lookup: (hostname, options, callback) => {
          const family = typeof options === 'number' ? options : options.family;
          lookup(hostname, { all: true, verbatim: true, family: family === 4 || family === 6 ? family : 0 })
            .then((addresses) => {
              const safe = addresses.filter(({ address }) => !this.isBlockedAddress(address));
              const first = safe[0];
              if (!first) return callback(new Error('DNS resolved only to blocked addresses'), '', 4);
              callback(null, first.address, first.family);
            })
            .catch((error: unknown) => callback(error instanceof Error ? error : new Error('DNS lookup failed'), '', 4));
        },
      },
    });
    try {
      const response = await fetch(url, {
        method: 'GET',
        redirect: 'manual',
        headers: { 'user-agent': 'SocialPublisherCrawler/0.1 (+https://example.invalid/bot)' },
        signal: AbortSignal.timeout(15_000),
        dispatcher,
      });
      return { response, dispatcher };
    } catch (error) {
      await dispatcher.close().catch(() => undefined);
      throw error;
    }
  }

  private async readLimitedBody(response: Response): Promise<Buffer> {
    if (!response.body) return Buffer.alloc(0);
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of response.body as AsyncIterable<Uint8Array>) {
      total += chunk.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        this.block('Crawler response exceeds 5 MiB');
      }
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks, total);
  }

  private isBlockedAddress(raw: string): boolean {
    const value = raw.toLowerCase().split('%')[0] ?? raw.toLowerCase();
    if (value === '::' || value === '::1') return true;
    if (value.startsWith('fc') || value.startsWith('fd') || value.startsWith('fe8') || value.startsWith('fe9') || value.startsWith('fea') || value.startsWith('feb')) return true;
    if (value.startsWith('ff')) return true;
    if (value.startsWith('2001:db8:')) return true;
    if (value.startsWith('::ffff:')) return this.isBlockedAddress(value.slice(7));
    if (isIP(value) === 4) {
      const octets = value.split('.').map(Number);
      const [a = 0, b = 0] = octets;
      return (
        a === 0 || a === 10 || a === 127 ||
        (a === 100 && b >= 64 && b <= 127) ||
        (a === 169 && b === 254) ||
        (a === 172 && b >= 16 && b <= 31) ||
        (a === 192 && b === 0) ||
        (a === 192 && b === 168) ||
        (a === 198 && (b === 18 || b === 19)) ||
        a >= 224
      );
    }
    return isIP(value) !== 6;
  }

  private block(message: string): never {
    throw new ApplicationException(ErrorCode.CRAWLER_URL_BLOCKED, message, HttpStatus.BAD_REQUEST);
  }
}
