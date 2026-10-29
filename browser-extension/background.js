// Service worker: polls the backend for posts, drives forum tabs and reports
// the outcome. Only one tab is filled/submitted at a time; tabs waiting for
// the operator (CAPTCHA, "check then click Post") do not block the queue.
// State lives in chrome.storage because MV3 service workers stop when idle.
import { fillAndSubmit, readErrors } from './page-actions.js';

const TICK_ALARM = 'tick';
const LOAD_TIMEOUT_MS = 90_000;
const SUBMIT_CONFIRM_MS = 60_000;
const ERROR_CHECK_AFTER_MS = 12_000;
const WAIT_USER_MS = 30 * 60_000;
const MAX_WAITING_TABS = 5;
const LOG_LIMIT = 20;

// Chrome fires several tab updates for one navigation; these guard against
// filling or reporting the same job twice while the worker is alive.
const filling = new Set();
const finishing = new Set();

// ---- storage helpers --------------------------------------------------------

async function settings() {
  const { apiUrl = '', token = '', paused = false } = await chrome.storage.local.get(['apiUrl', 'token', 'paused']);
  return { apiUrl: apiUrl.replace(/\/$/, ''), token, paused };
}

/** Tasks keyed by tab id. */
async function getTasks() {
  return (await chrome.storage.session.get('tasks')).tasks ?? {};
}

async function setTask(tabId, task) {
  const tasks = await getTasks();
  if (task) tasks[tabId] = task; else delete tasks[tabId];
  await chrome.storage.session.set({ tasks });
  await updateBadge();
}

async function log(entry) {
  const { history = [] } = await chrome.storage.local.get('history');
  history.unshift({ at: new Date().toISOString(), ...entry });
  await chrome.storage.local.set({ history: history.slice(0, LOG_LIMIT) });
}

async function updateBadge() {
  const tasks = Object.values(await getTasks());
  const waiting = tasks.filter((task) => task.phase === 'waitingUser').length;
  const { lastError, paused } = await chrome.storage.local.get(['lastError', 'paused']);
  if (waiting) {
    await chrome.action.setBadgeBackgroundColor({ color: '#d97706' });
    await chrome.action.setBadgeText({ text: String(waiting) });
  } else if (lastError) {
    await chrome.action.setBadgeBackgroundColor({ color: '#dc2626' });
    await chrome.action.setBadgeText({ text: 'ERR' });
  } else if (paused) {
    await chrome.action.setBadgeBackgroundColor({ color: '#64748b' });
    await chrome.action.setBadgeText({ text: 'II' });
  } else {
    await chrome.action.setBadgeText({ text: tasks.length ? '…' : '' });
  }
}

// ---- backend ----------------------------------------------------------------

async function api(path, body) {
  const { apiUrl, token } = await settings();
  if (!apiUrl || !token) throw new Error('Chưa ghép nối: mở Cài đặt của tiện ích');
  const response = await fetch(`${apiUrl}/api/v1/extension/agent/${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.success) {
    const message = payload?.error?.message ?? `HTTP ${response.status}`;
    throw new Error(response.status === 401 ? 'Mã ghép nối không hợp lệ hoặc đã bị thu hồi' : message);
  }
  return payload.data;
}

async function report(task, outcome, extra = {}) {
  try {
    await api(`tasks/${task.job.jobId}/result`, { outcome, ...extra });
    await log({ jobId: task.job.jobId, account: task.job.account.name, platform: task.job.account.platform, outcome, ...extra });
  } catch (error) {
    await log({ jobId: task.job.jobId, account: task.job.account.name, platform: task.job.account.platform, outcome: 'REPORT_FAILED', message: String(error.message ?? error) });
  }
}

// ---- task lifecycle -----------------------------------------------------------

async function start(job) {
  if (!await chrome.permissions.contains({ origins: [`${job.targetOrigin}/*`] })) {
    await report({ job }, 'FAILED', { reason: 'PERMISSION_REQUIRED', message: `Tiện ích chưa được cấp quyền cho ${job.targetOrigin}. Mở Cài đặt → Cấp quyền diễn đàn.` });
    return;
  }
  const tab = await chrome.tabs.create({ url: job.openUrl, active: false });
  await setTask(tab.id, { job, tabId: tab.id, phase: 'loading', deadline: Date.now() + LOAD_TIMEOUT_MS });
}

async function fill(task) {
  if (filling.has(task.job.jobId)) return;
  filling.add(task.job.jobId);
  let result;
  try {
    [{ result }] = await chrome.scripting.executeScript({ target: { tabId: task.tabId }, func: fillAndSubmit, args: [task.job] });
  } catch (error) {
    result = { status: 'notReady', message: `Không chạy được trên trang: ${error.message ?? error}` };
  }
  const now = Date.now();
  switch (result?.status) {
    case 'submitted':
      await setTask(task.tabId, { ...task, phase: 'submitted', submittedAt: now, deadline: now + SUBMIT_CONFIRM_MS });
      return;
    case 'captcha':
    case 'filled': {
      const captcha = result.status === 'captcha';
      await report(task, 'NEEDS_ACTION', {
        reason: captcha ? 'CAPTCHA_REQUIRED' : 'WAITING_USER',
        message: captcha ? 'Hoàn thành CAPTCHA rồi bấm Đăng trong tab vừa mở' : 'Kiểm tra nội dung rồi bấm Đăng trong tab vừa mở',
      });
      await setTask(task.tabId, { ...task, phase: 'waitingUser', deadline: now + WAIT_USER_MS });
      await focusTab(task.tabId);
      return;
    }
    case 'login':
      await report(task, 'FAILED', { reason: 'LOGIN_REQUIRED', message: result.message });
      await setTask(task.tabId, null);
      await focusTab(task.tabId);
      return;
    default:
      await report(task, 'FAILED', { reason: 'EDITOR_NOT_FOUND', message: result?.message ?? 'Không nhận diện được trang' });
      await setTask(task.tabId, null);
  }
}

async function focusTab(tabId) {
  try {
    const tab = await chrome.tabs.update(tabId, { active: true });
    if (tab?.windowId !== undefined) await chrome.windows.update(tab.windowId, { focused: true });
  } catch {
    // The operator may have closed it already.
  }
}

async function published(task, url) {
  if (finishing.has(task.job.jobId)) return;
  finishing.add(task.job.jobId);
  await setTask(task.tabId, null);
  await report(task, 'PUBLISHED', { url });
  // Close the background tab the extension opened; keep a tab the operator worked in.
  if (task.phase !== 'waitingUser') {
    try { await chrome.tabs.remove(task.tabId); } catch { /* already closed */ }
  }
}

async function checkSubmitted(task) {
  const now = Date.now();
  if (now - task.submittedAt < ERROR_CHECK_AFTER_MS && now < task.deadline) return;
  let errorText = null;
  try {
    [{ result: errorText }] = await chrome.scripting.executeScript({ target: { tabId: task.tabId }, func: readErrors, args: [task.job.recipe] });
  } catch { /* page still navigating */ }
  if (!errorText && now < task.deadline) return;
  // Possibly posted, possibly rejected: never resubmit, hand it to the operator.
  await report(task, 'NEEDS_ACTION', errorText
    ? { reason: 'SUBMIT_REJECTED', message: errorText }
    : { reason: 'SUBMIT_UNCONFIRMED', message: 'Đã bấm Đăng nhưng không thấy bài mới. Kiểm tra tab diễn đàn.' });
  await setTask(task.tabId, { ...task, phase: 'waitingUser', deadline: now + WAIT_USER_MS });
  await focusTab(task.tabId);
}

async function sweep() {
  const now = Date.now();
  for (const task of Object.values(await getTasks())) {
    if (task.phase === 'submitted') await checkSubmitted(task);
    else if (now >= task.deadline && task.phase === 'loading') {
      await report(task, 'FAILED', { reason: 'PAGE_LOAD_FAILED', message: 'Trang diễn đàn không tải xong' });
      await setTask(task.tabId, null);
    } else if (now >= task.deadline && task.phase === 'waitingUser') {
      await setTask(task.tabId, null); // the job stays in "Cần xử lý" on the dashboard
    }
  }
}

async function tick() {
  const { apiUrl, token, paused } = await settings();
  if (!apiUrl || !token) return;
  await sweep();
  const tasks = Object.values(await getTasks());
  const busy = tasks.some((task) => task.phase === 'loading' || task.phase === 'submitted');
  const waitingTabs = tasks.filter((task) => task.phase === 'waitingUser').length;
  try {
    const beat = await api('heartbeat');
    await chrome.storage.local.set({ lastHeartbeat: { at: new Date().toISOString(), ...beat }, lastError: null });
    if (!paused && !busy && waitingTabs < MAX_WAITING_TABS && beat.waiting > 0) {
      const { task: job } = await api('claim');
      if (job) await start(job);
    }
  } catch (error) {
    await chrome.storage.local.set({ lastError: { at: new Date().toISOString(), message: String(error.message ?? error) } });
  }
  await updateBadge();
}

// ---- events -----------------------------------------------------------------

function ensureAlarm() {
  chrome.alarms.create(TICK_ALARM, { periodInMinutes: 0.5 });
}

chrome.runtime.onInstalled.addListener(() => { ensureAlarm(); void updateBadge(); });
chrome.runtime.onStartup.addListener(ensureAlarm);
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === TICK_ALARM) void tick();
});

chrome.tabs.onUpdated.addListener(async (tabId, info, tab) => {
  const task = (await getTasks())[tabId];
  if (!task) return;
  const url = info.url ?? tab.url ?? '';
  if (task.phase !== 'loading' && url && new RegExp(task.job.recipe.successUrlPattern).test(url)) {
    await published(task, url);
    return;
  }
  if (task.phase === 'loading' && info.status === 'complete') await fill(task);
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const task = (await getTasks())[tabId];
  if (!task) return;
  if (task.phase === 'loading') {
    await report(task, 'FAILED', { reason: 'CANCELLED', message: 'Tab bị đóng trước khi điền nội dung' });
  } else if (task.phase === 'submitted') {
    await report(task, 'NEEDS_ACTION', { reason: 'SUBMIT_UNCONFIRMED', message: 'Tab bị đóng ngay sau khi bấm Đăng. Kiểm tra diễn đàn.' });
  }
  await setTask(tabId, null);
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'tick-now') {
    tick().then(() => sendResponse({ ok: true }), (error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }
  if (message?.type === 'state') {
    Promise.all([getTasks(), chrome.storage.local.get(['history', 'lastHeartbeat', 'lastError', 'paused', 'apiUrl'])])
      .then(([tasks, stored]) => sendResponse({ tasks: Object.values(tasks), ...stored }));
    return true;
  }
  if (message?.type === 'badge') void updateBadge();
  return false;
});
