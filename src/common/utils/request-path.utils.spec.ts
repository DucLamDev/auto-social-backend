import { requestPathForLog } from './request-path.utils';

describe('requestPathForLog', () => {
  it('removes OAuth codes, state, and all other query values', () => {
    const result = requestPathForLog({
      originalUrl: '/api/v1/oauth/google/callback?code=secret-code&state=secret-state',
    });

    expect(result).toBe('/api/v1/oauth/google/callback');
    expect(result).not.toContain('secret-code');
    expect(result).not.toContain('secret-state');
  });

  it('prefers the framework pathname when available', () => {
    expect(requestPathForLog({
      path: '/api/v1/oauth/linkedin/callback',
      originalUrl: '/api/v1/oauth/linkedin/callback?code=secret',
    })).toBe('/api/v1/oauth/linkedin/callback');
  });
});
