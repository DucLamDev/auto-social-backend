import {
  assertBrowserProfileSettings,
  BrowserProfileSettingError,
  browserContextOptions,
  browserProxyName,
  DEFAULT_BROWSER_CONTEXT_PROFILE,
  resolveBrowserContextProfile,
} from './browser-context-profile';

describe('browser context profile', () => {
  it('uses the Vietnamese defaults when the account sets nothing', () => {
    expect(resolveBrowserContextProfile({})).toEqual(DEFAULT_BROWSER_CONTEXT_PROFILE);
    expect(resolveBrowserContextProfile({ browserLocale: '', browserViewport: null }))
      .toEqual(DEFAULT_BROWSER_CONTEXT_PROFILE);
  });

  it('applies valid per-account settings', () => {
    const profile = resolveBrowserContextProfile({
      browserLocale: 'en-US',
      browserTimezone: 'Europe/Berlin',
      browserViewport: '1920x1080',
    });
    expect(browserContextOptions(profile)).toEqual({
      locale: 'en-US',
      timezoneId: 'Europe/Berlin',
      viewport: { width: 1920, height: 1080 },
    });
  });

  it.each([
    [{ browserLocale: 'vietnamese' }, 'browserLocale'],
    [{ browserTimezone: 'Mars/Olympus' }, 'browserTimezone'],
    [{ browserViewport: '200x200' }, 'browserViewport'],
    [{ browserViewport: '1366*768' }, 'browserViewport'],
    [{ browserProxy: 'http://user:pass@proxy:3128' }, 'browserProxy'],
  ])('rejects invalid setting %j', (settings, key) => {
    expect(() => assertBrowserProfileSettings(settings)).toThrow(BrowserProfileSettingError);
    expect(() => assertBrowserProfileSettings(settings)).toThrow(key);
  });

  it('never echoes a pasted proxy URL back in the error message', () => {
    let message = '';
    try {
      browserProxyName({ browserProxy: 'http://user:secret@proxy:3128' });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('browserProxy');
    expect(message).not.toContain('secret');
  });

  it('returns the proxy name only when one is selected', () => {
    expect(browserProxyName({})).toBeUndefined();
    expect(browserProxyName({ browserProxy: '' })).toBeUndefined();
    expect(browserProxyName({ browserProxy: 'vn-1' })).toBe('vn-1');
  });
});
