// Node-only tests of the optional Chrome proxy; no network or real proxy is used.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test, before } = require('node:test');

let proxy;
before(async () => {
  const source = fs.readFileSync(path.join(__dirname, '../../browser-extension/proxy.js'), 'utf8');
  proxy = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
});
const saved = { enabled: true, host: '203.0.113.7', port: 6015, username: 'user-a', password: 'fixture-pass' }; // vpsttt-secretscan: ignore

test('reads the usual residential proxy formats and refuses broken ones', () => {
  assert.deepEqual(proxy.parseProxy(' 203.0.113.7:6015:user-a:fixture:pass '), { host: '203.0.113.7', port: 6015, username: 'user-a', password: 'fixture:pass' }); // vpsttt-secretscan: ignore
  assert.deepEqual(proxy.parseProxy('203.0.113.7:6015'), { host: '203.0.113.7', port: 6015, username: '', password: '' });
  assert.deepEqual(proxy.parseProxy('http://user-a:p%40ss@proxy.example:8080'), { host: 'proxy.example', port: 8080, username: 'user-a', password: 'p@ss' });
  for (const bad of ['', '203.0.113.7', '203.0.113.7:6015:user-only', '203.0.113.7:99999', 'socks5://proxy.example:1080', 'bad host:80']) {
    assert.throws(() => proxy.parseProxy(bad), /proxy|Cổng|SOCKS|Định dạng|Nhập/);
  }
});

test('sends every page through the proxy except the paired backend and local addresses', () => {
  const config = proxy.proxyConfig(saved, 'https://apiautosocial.vpsttt.vn');
  assert.deepEqual(config.rules.singleProxy, { scheme: 'http', host: '203.0.113.7', port: 6015 });
  assert.ok(config.rules.bypassList.includes('apiautosocial.vpsttt.vn'));
  assert.ok(config.rules.bypassList.includes('<local>'));
  assert.equal(config.mode, 'fixed_servers');
});

test('answers only the configured proxy, never a website, and at most twice per request', () => {
  const details = { isProxy: true, challenger: { host: '203.0.113.7', port: 6015 } };
  assert.deepEqual(proxy.proxyAuthAnswer(details, saved, 1), { username: 'user-a', password: 'fixture-pass' }); // vpsttt-secretscan: ignore
  assert.equal(proxy.proxyAuthAnswer(details, saved, 3), null);
  assert.equal(proxy.proxyAuthAnswer({ ...details, isProxy: false }, saved, 1), null);
  assert.equal(proxy.proxyAuthAnswer({ isProxy: true, challenger: { host: 'evil.example', port: 6015 } }, saved, 1), null);
  assert.equal(proxy.proxyAuthAnswer(details, { ...saved, enabled: false }, 1), null);
});

test('applies or clears the Chrome proxy, and answers prompts through the registered listener', async () => {
  const calls = [];
  let listener;
  const store = { proxy: saved, apiUrl: 'https://apiautosocial.vpsttt.vn' };
  globalThis.chrome = {
    storage: { local: { get: async keys => Object.fromEntries([keys].flat().filter(key => key in store).map(key => [key, store[key]])) } },
    proxy: { settings: { set: async value => calls.push(['set', value]), clear: async value => calls.push(['clear', value]) } },
    webRequest: { onAuthRequired: { addListener: (fn, filter, extra) => { listener = fn; calls.push(['listen', filter, extra]); } } },
  };
  await proxy.applyProxy();
  assert.equal(calls[0][0], 'set');
  assert.equal(calls[0][1].value.rules.singleProxy.port, 6015);
  store.proxy = { ...saved, enabled: false };
  await proxy.applyProxy();
  assert.deepEqual(calls[1], ['clear', { scope: 'regular' }]);
  store.proxy = saved;
  proxy.registerProxyAuth();
  assert.deepEqual(calls[2].slice(1), [{ urls: ['<all_urls>'] }, ['asyncBlocking']]);
  const answer = details => new Promise(resolve => listener(details, resolve));
  const prompt = { requestId: 'r1', isProxy: true, challenger: { host: '203.0.113.7', port: 6015 } };
  assert.deepEqual(await answer(prompt), { authCredentials: { username: 'user-a', password: 'fixture-pass' } }); // vpsttt-secretscan: ignore
  await answer(prompt);
  assert.deepEqual(await answer(prompt), {}); // third try on the same request: let Chrome ask the person
  assert.deepEqual(await answer({ requestId: 'r2', isProxy: false, challenger: { host: 'site.example', port: 443 } }), {});
  delete globalThis.chrome;
});
