import {
  assertPublicBrowserUrl,
  hostnameMatches,
  isBlockedBrowserAddress,
  safeBrowserActionUrl,
} from './browser-navigation-safety';

describe('browser navigation safety', () => {
  it.each([
    '127.0.0.1',
    '10.0.0.1',
    '169.254.169.254',
    '172.16.0.1',
    '192.168.1.1',
    '::1',
    'fc00::1',
  ])('blocks non-public address %s', (address) => {
    expect(isBlockedBrowserAddress(address)).toBe(true);
  });

  it('matches only the host itself or a real subdomain', () => {
    expect(hostnameMatches('example.com', ['example.com'])).toBe(true);
    expect(hostnameMatches('www.example.com', ['example.com'])).toBe(true);
    expect(hostnameMatches('example.com.evil.invalid', ['example.com'])).toBe(false);
  });

  it('rejects private and off-recipe navigation before browser launch', async () => {
    await expect(assertPublicBrowserUrl('https://127.0.0.1/admin', ['127.0.0.1'])).rejects.toThrow('Private');
    await expect(assertPublicBrowserUrl('https://www.iana.org/', ['example.com'])).rejects.toThrow('allowlist');
    await expect(assertPublicBrowserUrl('http://example.com/', ['example.com'])).rejects.toThrow('HTTPS');
  });

  it('removes query secrets and fragments from operator action URLs', () => {
    expect(safeBrowserActionUrl('https://example.com/editor?token=secret#key'))
      .toBe('https://example.com/editor');
  });
});
