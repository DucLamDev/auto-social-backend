const $ = (id) => document.getElementById(id);
let origins = [];

function originPattern(url) {
  return `${new URL(url).origin}/*`;
}

async function load() {
  const { apiUrl = '', token = '', paused = false, lastHeartbeat } = await chrome.storage.local.get(['apiUrl', 'token', 'paused', 'lastHeartbeat']);
  $('apiUrl').value = apiUrl;
  $('token').value = token;
  renderPause(paused);
  if (lastHeartbeat) await renderOrigins(lastHeartbeat);
}

function renderPause(paused) {
  $('pause').textContent = paused ? 'Tiếp tục' : 'Tạm dừng';
  $('pauseStatus').textContent = paused ? 'Đang tạm dừng: không nhận bài mới.' : 'Đang chạy.';
}

async function renderOrigins(beat) {
  origins = beat.origins ?? [];
  const box = $('origins');
  if (!origins.length) {
    box.textContent = 'Chưa có tài khoản diễn đàn nào bật "Đăng bằng tiện ích Chrome".';
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
  $('grantStatus').textContent = granted.every(Boolean) ? 'Đã đủ quyền.' : `${granted.filter((value) => !value).length} diễn đàn chưa cấp quyền.`;
}

async function heartbeat(apiUrl, token) {
  const response = await fetch(`${apiUrl}/api/v1/extension/agent/heartbeat`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: '{}',
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
});

$('pause').addEventListener('click', async () => {
  const { paused = false } = await chrome.storage.local.get('paused');
  await chrome.storage.local.set({ paused: !paused });
  renderPause(!paused);
  chrome.runtime.sendMessage({ type: 'badge' });
});

void load();
