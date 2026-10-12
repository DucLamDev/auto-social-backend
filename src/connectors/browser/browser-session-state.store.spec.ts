import { CredentialsService } from '../../credentials/credentials.service';
import { BrowserSessionStateStore } from './browser-session-state.store';

describe('BrowserSessionStateStore', () => {
  const state = {
    cookies: [{ name: 'session', value: 'secret', domain: '.example.com', path: '/' }],
    origins: [{ origin: 'https://example.com', localStorage: [{ name: 'key', value: 'value' }] }],
  };

  it('normalizes an imported Playwright storageState JSON document', async () => {
    const credentials = { merge: jest.fn() } as unknown as CredentialsService;
    const store = new BrowserSessionStateStore(credentials);

    await expect(store.load('account-1', JSON.stringify(state))).resolves.toEqual(state);
  });

  it('persists refreshed state through encrypted platform credentials', async () => {
    const merge = jest.fn().mockResolvedValue(undefined);
    const credentials = { merge } as unknown as CredentialsService;
    const store = new BrowserSessionStateStore(credentials);

    await store.save('account-1', state);

    expect(merge).toHaveBeenCalledWith('account-1', { storageState: state });
  });

  it.each([
    [null],
    [{}],
    [{ cookies: {}, origins: [] }],
    [{ cookies: [{ name: 'x' }], origins: [] }],
  ])('rejects malformed browser state %#', (value) => {
    const store = new BrowserSessionStateStore({} as CredentialsService);
    expect(() => store.normalize(value)).toThrow('Browser');
  });
});
