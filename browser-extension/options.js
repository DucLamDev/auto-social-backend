import { parseProxy, PROXY_STORAGE_KEY } from './proxy.js';

const $ = (id) => document.getElementById(id);
let origins = [];

function originPattern(url) {
  return `${new URL(url).origin}/*`;
}

async function load() {
  // The operator may open settings while an unpacked update is already on disk.
  // Refresh the worker as well, instead of showing new UI with an old scheduler.
  try {
    const installed = await fetch(chrome.runtime.getURL('manifest.json'), { cache: 'no-store' }).then(response => response.json());
    if (installed.version !== chrome.runtime.getManifest().version) { chrome.runtime.reload(); return; }
  } catch { /* Normal heartbeat below reports any actual connection problem. */ }
  const { apiUrl = '', token = '', paused = false, lastHeartbeat } = await chrome.storage.local.get(['apiUrl', 'token', 'paused', 'lastHeartbeat']);
  $('apiUrl').value = apiUrl;
  $('token').value = token;
  renderPause(paused);
  if (lastHeartbeat) await renderOrigins(lastHeartbeat);
  if (apiUrl && token) {
    try {
      const beat = await heartbeat(apiUrl.replace(/\/$/, ''), token);
      await chrome.storage.local.set({ lastHeartbeat: { at: new Date().toISOString(), ...beat }, lastError: null });
      await renderOrigins(beat);
      $('pairStatus').textContent = `Đã kết nối: ${beat.device.name}.`;
      $('pairStatus').className = 'ok';
      void chrome.runtime.sendMessage({ type: 'tick-now' });
    } catch (error) {
      $('pairStatus').textContent = String(error.message ?? error);
      $('pairStatus').className = 'bad';
    }
  }
}

async function loadProxy() {
  const { [PROXY_STORAGE_KEY]: proxy } = await chrome.storage.local.get(PROXY_STORAGE_KEY);
  $('proxyEnabled').checked = Boolean(proxy?.enabled);
  $('proxyAddress').value = proxy?.host ? `${proxy.host}:${proxy.port}` : '';
  $('proxyUser').value = proxy?.username ?? '';
  // The saved password is never shown again; an empty field keeps it.
  $('proxyPassword').value = '';
  $('proxyPassword').placeholder = proxy?.password ? 'Đã lưu. Để trống để giữ nguyên' : 'Mật khẩu proxy';
  $('proxyStatus').textContent = proxy?.enabled ? `Đang dùng proxy ${proxy.host}:${proxy.port}.` : 'Không dùng proxy.';
  $('proxyStatus').className = proxy?.enabled ? 'ok' : 'muted';
}

// Pasting "host:port:user:password" fills the three fields at once.
$('proxyAddress').addEventListener('change', () => {
  const value = $('proxyAddress').value.trim();
  if (value.split(':').length < 4) return;
  try {
    const parsed = parseProxy(value);
    $('proxyAddress').value = `${parsed.host}:${parsed.port}`;
    $('proxyUser').value = parsed.username;
    $('proxyPassword').value = parsed.password;
    $('proxyStatus').textContent = 'Đã tách tên đăng nhập và mật khẩu. Bấm Lưu proxy.';
    $('proxyStatus').className = 'muted';
  } catch (error) {
    $('proxyStatus').textContent = String(error.message ?? error);
    $('proxyStatus').className = 'bad';
  }
});

$('proxyForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const status = $('proxyStatus');
  const enabled = $('proxyEnabled').checked;
  try {
    // Chrome only lets the extension answer the proxy's login for pages it may see.
    // Asked first, while this click still counts as a user gesture.
    if (enabled && !await chrome.permissions.request({ origins: ['https://*/*', 'http://*/*'] })) {
      throw new Error('Cần cho phép tiện ích truy cập các trang để tự đăng nhập proxy.');
    }
    const { [PROXY_STORAGE_KEY]: saved } = await chrome.storage.local.get(PROXY_STORAGE_KEY);
    const address = $('proxyAddress').value.trim();
    let next = { ...saved, enabled: false };
    if (address || enabled) {
      const parsed = parseProxy(address);
      const { host, port } = parsed;
      const username = $('proxyUser').value.trim() || parsed.username;
      const sameLogin = saved?.host === host && saved?.username === username;
      const password = $('proxyPassword').value || parsed.password || (sameLogin ? saved?.password ?? '' : '');
      next = { enabled, host, port, username, password };
    }
    await chrome.storage.local.set({ [PROXY_STORAGE_KEY]: next });
    await loadProxy();
    if (enabled) {
      status.textContent = `Đã bật proxy ${next.host}:${next.port}. Bấm "Xem IP đang dùng" để kiểm tra.`;
      status.className = 'ok';
    }
  } catch (error) {
    status.textContent = String(error.message ?? error);
    status.className = 'bad';
  }
});

$('proxyCheck').addEventListener('click', () => { void chrome.tabs.create({ url: 'https://api.ipify.org/' }); });

function renderPause(paused) {
  $('pause').textContent = paused ? 'Tiếp tục' : 'Tạm dừng';
  $('pauseStatus').textContent = paused ? 'Đang tạm dừng: không nhận bài mới.' : 'Đang chạy.';
}

async function renderOrigins(beat) {
  origins = beat.origins ?? [];
  const box = $('origins');
  if (!origins.length) {
    box.textContent = 'Chưa có tài khoản nào bật "Đăng bằng tiện ích Chrome".';
    $('grant').disabled = true;
    return;
  }
  const granted = await Promise.all(origins.map((origin) => chrome.permissions.contains({ origins: [`${origin}/*`] })));
  box.replaceChildren(...origins.map((origin, index) => {
    const line = document.createElement('p');
    line.textContent = `${granted[index] ? '✓' : '○'} ${origin}`;
    line.className = granted[index] ? 'ok' : 'warn';
    return line;
  }));
  $('grant').disabled = granted.every(Boolean);
  $('grantStatus').textContent = granted.every(Boolean) ? 'Đã đủ quyền.' : `${granted.filter((value) => !value).length} nền tảng chưa cấp quyền.`;
}

async function heartbeat(apiUrl, token) {
  const response = await fetch(`${apiUrl}/api/v1/extension/agent/heartbeat`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: '{}',
    signal: AbortSignal.timeout(15_000),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.success) throw new Error(response.status === 401 ? 'Mã ghép nối sai hoặc đã bị thu hồi' : payload?.error?.message ?? `HTTP ${response.status}`);
  return payload.data;
}

$('pair').addEventListener('submit', async (event) => {
  event.preventDefault();
  const status = $('pairStatus');
  const apiUrl = $('apiUrl').value.trim().replace(/\/$/, '');
  const token = $('token').value.trim();
  try {
    // Must run inside the click handler: Chrome only shows the permission prompt on a user gesture.
    const allowed = await chrome.permissions.request({ origins: [originPattern(apiUrl)] });
    if (!allowed) throw new Error('Cần cho phép tiện ích kết nối tới địa chỉ API');
    status.textContent = 'Đang kiểm tra…';
    const beat = await heartbeat(apiUrl, token);
    await chrome.storage.local.set({ apiUrl, token, lastHeartbeat: { at: new Date().toISOString(), ...beat }, lastError: null });
    status.textContent = `Đã ghép nối: ${beat.device.name}. ${beat.waiting} bài đang chờ.`;
    status.className = 'ok';
    await renderOrigins(beat);
    chrome.runtime.sendMessage({ type: 'badge' });
  } catch (error) {
    status.textContent = String(error.message ?? error);
    status.className = 'bad';
  }
});

$('grant').addEventListener('click', async () => {
  const allowed = await chrome.permissions.request({ origins: origins.map((origin) => `${origin}/*`) });
  $('grantStatus').textContent = allowed ? 'Đã cấp quyền.' : 'Bạn đã từ chối cấp quyền.';
  const { lastHeartbeat } = await chrome.storage.local.get('lastHeartbeat');
  if (lastHeartbeat) await renderOrigins(lastHeartbeat);
  if (allowed) void chrome.runtime.sendMessage({ type: 'tick-now' });
});

$('pause').addEventListener('click', async () => {
  const { paused = false } = await chrome.storage.local.get('paused');
  await chrome.storage.local.set({ paused: !paused });
  renderPause(!paused);
  chrome.runtime.sendMessage({ type: 'badge' });
});

void load();
void loadProxy();
