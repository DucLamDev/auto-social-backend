import { movedUrl, sessionOf } from './extension-account-session.service';
import { loginSession } from './extension-login-check.service';

const dailyDev = {
  extensionSession: { deviceId: 'device-1', expectedUsername: 'vpsttt', profileUrl: 'https://daily.dev/vpsttt', identitySelector: '', origin: 'https://app.daily.dev',
    provider: 'google', autoLogin: true, autoTotp: true, loginUrl: 'https://app.daily.dev/', loginUsername: 'writer@example.test' },
  extensionLoginMethods: { google: { available: true, username: 'writer@example.test', autoTotp: true, loginUrl: 'https://app.daily.dev/' } },
};

describe('sites that moved to another origin', () => {
  it('sends sessions saved for app.daily.dev to daily.dev, keeping the path', () => {
    expect(movedUrl('https://app.daily.dev/onboarding?x=1')).toBe('https://daily.dev/onboarding?x=1');
    expect(movedUrl('https://dev.to/enter')).toBe('https://dev.to/enter');
    expect(movedUrl('not a url')).toBe('not a url');
    expect(sessionOf(dailyDev)).toMatchObject({ origin: 'https://daily.dev', loginUrl: 'https://daily.dev/', profileUrl: 'https://daily.dev/vpsttt' });
    expect(loginSession(dailyDev, 'google')).toMatchObject({ origin: 'https://daily.dev', loginUrl: 'https://daily.dev/', provider: 'google' });
  });

  it('leaves other sessions untouched', () => {
    const devto = { extensionSession: { ...dailyDev.extensionSession, origin: 'https://dev.to', loginUrl: 'https://dev.to/enter' } };
    expect(sessionOf(devto)).toBe(devto.extensionSession);
  });
});
