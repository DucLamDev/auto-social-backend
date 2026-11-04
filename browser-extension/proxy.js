// Optional upstream proxy for this Chrome profile. A residential proxy keeps
// sites from treating the VPS datacenter IP as a bot (CAPTCHA on every login).
// The settings live only in this Chrome's local storage and are never sent to
// the backend; the paired API is reached directly, not through the proxy.

export const PROXY_STORAGE_KEY = 'proxy';
const MAX_AUTH_TRIES = 2;

/**
 * Accepts "host:port", "host:port:user:password" (the usual residential proxy
 * format) or "http://user:password@host:port". Throws a Vietnamese message.
 */
export function parseProxy(text) {
  const raw = String(text ?? '').trim();
  if (!raw) throw new Error('Nhập địa chỉ proxy dạng host:port hoặc host:port:user:mật khẩu.');
  let host, port, username = '', password = '';
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    let url;
    try { url = new URL(raw); } catch { throw new Error('Địa chỉ proxy không hợp lệ.'); }
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Chỉ hỗ trợ proxy HTTP/HTTPS (Chrome không gửi được mật khẩu cho proxy SOCKS).');
    host = url.hostname; port = url.port || (url.protocol === 'https:' ? '443' : '80');
    username = decodeURIComponent(url.username); password = decodeURIComponent(url.password);
  } else {
    const parts = raw.split(':');
    if (parts.length !== 2 && parts.length < 4) throw new Error('Định dạng proxy: host:port hoặc host:port:user:mật khẩu.');
    [host, port] = parts;
    username = parts[2] ?? '';
    password = parts.slice(3).join(':');
  }
  host = host.trim().replace(/^\[|\]$/g, '');
  const portNumber = Number(port);
  if (!/^[a-z0-9.-]+$/i.test(host) && !/^[0-9a-f:]+$/i.test(host)) throw new Error('Tên máy proxy không hợp lệ.');
  if (!Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65535) throw new Error('Cổng proxy phải từ 1 đến 65535.');
  return { host, port: portNumber, username: username.trim(), password };
}

/** Chrome proxy rules: everything through the proxy except the paired backend and local addresses. */
export function proxyConfig(proxy, apiUrl) {
  const bypassList = ['<local>', 'localhost', '127.0.0.1', '[::1]'];
  try { if (apiUrl) bypassList.push(new URL(apiUrl).hostname); } catch { /* not paired yet */ }
  return { mode: 'fixed_servers', rules: { singleProxy: { scheme: 'http', host: proxy.host, port: Number(proxy.port) }, bypassList } };
}

/**
 * Credentials for a login prompt, only when it comes from the configured proxy
 * itself, never from a website, and at most twice per request so a wrong
 * password cannot loop.
 */
export function proxyAuthAnswer(details, proxy, tries) {
  if (!details?.isProxy || !proxy?.enabled || !proxy.username) return null;
  const challenger = details.challenger ?? {};
  if (String(challenger.host ?? '').toLowerCase() !== String(proxy.host).toLowerCase() || Number(challenger.port) !== Number(proxy.port)) return null;
  if (tries > MAX_AUTH_TRIES) return null;
  return { username: proxy.username, password: proxy.password ?? '' };
}

/** Applies (or removes) the proxy saved in this Chrome. */
export async function applyProxy() {
  const { [PROXY_STORAGE_KEY]: proxy, apiUrl } = await chrome.storage.local.get([PROXY_STORAGE_KEY, 'apiUrl']);
  if (proxy?.enabled && proxy.host && proxy.port) await chrome.proxy.settings.set({ value: proxyConfig(proxy, apiUrl), scope: 'regular' });
  else await chrome.proxy.settings.clear({ scope: 'regular' });
}

/** Must be registered at the top level of the service worker, so Chrome wakes it for a prompt. */
export function registerProxyAuth() {
  const tries = new Map();
  chrome.webRequest.onAuthRequired.addListener((details, callback) => {
    void (async () => {
      let credentials = null;
      try {
        const { [PROXY_STORAGE_KEY]: proxy } = await chrome.storage.local.get(PROXY_STORAGE_KEY);
        const count = (tries.get(details.requestId) ?? 0) + 1;
        if (tries.size > 500) tries.clear();
        tries.set(details.requestId, count);
        credentials = proxyAuthAnswer(details, proxy, count);
      } catch { /* answer nothing: Chrome shows its own prompt */ }
      callback(credentials ? { authCredentials: credentials } : {});
    })();
  }, { urls: ['<all_urls>'] }, ['asyncBlocking']);
}
