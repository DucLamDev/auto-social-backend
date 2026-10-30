import { effectiveConnectorKey, EXTENSION_RECIPES, extensionOpenUrl, parseExtensionDeliverySettings } from './extension-delivery';

const xenforo = { extensionEngine: 'xenforo', extensionTargetUrl: 'https://voz.vn/f/chuyen-tro-linh-tinh.17/post-thread', extensionAutoSubmit: true };

describe('extension delivery settings', () => {
  it('routes only accounts switched to the extension', () => {
    expect(effectiveConnectorKey('manual', { delivery: 'extension' })).toBe('extension');
    expect(effectiveConnectorKey('discourse', {})).toBe('discourse');
    expect(effectiveConnectorKey('browser-assisted', null)).toBe('browser-assisted');
  });

  it('accepts per-engine target pages and rejects the rest', () => {
    expect(parseExtensionDeliverySettings(xenforo)).toEqual({ engine: 'xenforo', targetUrl: xenforo.extensionTargetUrl, autoSubmit: true, tags: [], category: '', flair: '' });
    expect(parseExtensionDeliverySettings({ ...xenforo, extensionEngine: 'phpbb', extensionTargetUrl: 'https://forum.example.com/posting.php?mode=post&f=7' }).engine).toBe('phpbb');
    expect(() => parseExtensionDeliverySettings({ ...xenforo, extensionTargetUrl: 'https://voz.vn/f/x.17/' })).toThrow('post-thread');
    expect(() => parseExtensionDeliverySettings({ ...xenforo, extensionTargetUrl: 'http://voz.vn/f/x.17/post-thread' })).toThrow('https');
    expect(() => parseExtensionDeliverySettings({ ...xenforo, extensionEngine: 'phpbb', extensionTargetUrl: 'https://f.example.com/viewforum.php?f=7' })).toThrow('posting.php');
    expect(() => parseExtensionDeliverySettings({ ...xenforo, extensionEngine: 'discourse', extensionTargetUrl: 'https://community.nginx.org/t/x/12' })).toThrow('home page');
    expect(() => parseExtensionDeliverySettings({ ...xenforo, extensionEngine: 'vbulletin' })).toThrow('extensionEngine');
    expect(() => parseExtensionDeliverySettings({ ...xenforo, extensionAutoSubmit: 'yes' })).toThrow('true or false');
    expect(parseExtensionDeliverySettings({ ...xenforo, extensionTargetUrl: 'http://127.0.0.1:3922/forums/a.1/post-thread' }).targetUrl).toContain('127.0.0.1');
  });

  it('opens the Discourse composer and keeps other targets as given', () => {
    expect(extensionOpenUrl({ engine: 'discourse', targetUrl: 'https://community.nginx.org/', autoSubmit: true })).toBe('https://community.nginx.org/new-topic');
    expect(extensionOpenUrl({ engine: 'discourse', targetUrl: 'https://example.com/forum/new-topic?category=help', autoSubmit: true })).toBe('https://example.com/forum/new-topic?category=help');
    expect(extensionOpenUrl({ engine: 'xenforo', targetUrl: xenforo.extensionTargetUrl, autoSubmit: true })).toBe(xenforo.extensionTargetUrl);
  });

  it('recognises published thread URLs per engine', () => {
    const matches = (engine: keyof typeof EXTENSION_RECIPES, url: string) => new RegExp(EXTENSION_RECIPES[engine].successUrlPattern).test(url);
    expect(matches('xenforo', 'https://voz.vn/t/bai-viet.123456/')).toBe(true);
    expect(matches('xenforo', 'https://forums.cpanel.net/threads/hello.7001/')).toBe(true);
    expect(matches('xenforo', 'https://voz.vn/f/chuyen-tro.17/post-thread')).toBe(false);
    expect(matches('discourse', 'https://community.nginx.org/t/hello-world/4521')).toBe(true);
    expect(matches('discourse', 'https://community.nginx.org/new-topic')).toBe(false);
    expect(matches('phpbb', 'https://forum.mikrotik.com/viewtopic.php?f=3&t=99')).toBe(true);
    expect(matches('phpbb', 'https://forum.mikrotik.com/posting.php?mode=post&f=3')).toBe(false);
  });
});
