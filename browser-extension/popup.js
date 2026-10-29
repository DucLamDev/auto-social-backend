const $ = (id) => document.getElementById(id);
const OUTCOME = { PUBLISHED: ['Đã đăng', 'ok'], NEEDS_ACTION: ['Cần bạn thao tác', 'warn'], FAILED: ['Chưa đăng được', 'bad'], REPORT_FAILED: ['Không báo được về hệ thống', 'bad'] };

function render(state) {
  const stateLine = $('state');
  if (!state.apiUrl) {
    stateLine.textContent = 'Chưa ghép nối';
    stateLine.className = 'status warn';
    $('detail').textContent = 'Mở Cài đặt và dán mã ghép nối từ trang Tài khoản.';
  } else if (state.lastError) {
    stateLine.textContent = 'Lỗi kết nối';
    stateLine.className = 'status bad';
    $('detail').textContent = state.lastError.message;
  } else if (state.paused) {
    stateLine.textContent = 'Đang tạm dừng';
    stateLine.className = 'status muted';
    $('detail').textContent = '';
  } else {
    stateLine.textContent = 'Đang chạy';
    stateLine.className = 'status ok';
    const beat = state.lastHeartbeat;
    $('detail').textContent = beat ? `${beat.device?.name ?? ''} · ${beat.waiting ?? 0} bài đang chờ · ${beat.origins?.length ?? 0} diễn đàn` : '';
  }
  $('pause').textContent = state.paused ? 'Tiếp tục' : 'Tạm dừng';

  const current = $('current');
  const tasks = state.tasks ?? [];
  current.hidden = tasks.length === 0;
  current.replaceChildren(...tasks.map((task) => {
    const phase = { loading: 'Đang mở và điền form', submitted: 'Đã bấm Đăng, chờ xác nhận', waitingUser: 'Chờ bạn thao tác trong tab' }[task.phase] ?? task.phase;
    const line = document.createElement('p');
    line.className = task.phase === 'waitingUser' ? 'warn' : '';
    line.textContent = `${task.job.account.platform} · ${task.job.account.name}: ${phase}`;
    return line;
  }));

  const history = state.history ?? [];
  if (history.length) {
    $('log').replaceChildren(...history.slice(0, 6).map((entry) => {
      const [label, tone] = OUTCOME[entry.outcome] ?? [entry.outcome, 'muted'];
      const item = document.createElement('li');
      const head = document.createElement('span');
      head.className = tone;
      head.textContent = `${label} · ${entry.platform ?? ''} ${entry.account ?? ''}`;
      const tail = document.createElement('div');
      tail.className = 'muted';
      tail.textContent = `${new Date(entry.at).toLocaleString('vi-VN')}${entry.url ? ` · ${entry.url}` : ''}${entry.message ? ` · ${entry.message}` : ''}`;
      item.append(head, tail);
      return item;
    }));
  }
}

async function refresh() {
  render(await chrome.runtime.sendMessage({ type: 'state' }));
}

$('run').addEventListener('click', async () => {
  $('run').disabled = true;
  await chrome.runtime.sendMessage({ type: 'tick-now' });
  $('run').disabled = false;
  await refresh();
});
$('pause').addEventListener('click', async () => {
  const { paused = false } = await chrome.storage.local.get('paused');
  await chrome.storage.local.set({ paused: !paused });
  chrome.runtime.sendMessage({ type: 'badge' });
  await refresh();
});
$('settings').addEventListener('click', () => chrome.runtime.openOptionsPage());

void refresh();
