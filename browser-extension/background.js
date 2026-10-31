// Service worker: polls the backend for posts, drives forum tabs and reports
// the outcome. Different forums run concurrently; tabs waiting for
// the operator (CAPTCHA, "check then click Post") do not block the queue.
// State lives in chrome.storage because MV3 service workers stop when idle.
import { canFillPage, fillAndSubmit, readErrors, readModeration, readPublishedPost } from './page-actions.js';
import { fillSocialAndSubmit, readSocialPublishedPost } from './social-actions.js';
import { accountAuthStep } from './auth-actions.js';
import { submitDiscoursePost } from './discourse-session.js';
import { showPublishNotice } from './publish-notice.js';

const TICK_ALARM = 'tick';
const LOAD_TIMEOUT_MS = 90_000;
const SUBMIT_CONFIRM_MS = 60_000;
const ERROR_CHECK_AFTER_MS = 12_000;
const WAIT_USER_MS = 30 * 60_000;
const MAX_WAITING_TABS = 5;
const MAX_ACTIVE_FLOWS = 3;
const MAX_LOGIN_CHECKS = 3;
const LOG_LIMIT = 20;
const SUPPORTED_ENGINES = ['discourse', 'xenforo', 'phpbb', 'medium', 'substack', 'quora', 'reddit', 'slideshare', 'aws-builder', 'tinhte', 'pixelfed', 'mastodon', 'bluesky', 'tumblr', 'devto', 'minds', 'stackexchange', 'lemmy', 'discuit', 'linkedin', 'differ', 'dzone'];

// Chrome fires several tab updates for one navigation; these guard against
// filling or reporting the same job twice while the worker is alive.
const filling = new Set();
const probing = new Set();
const finishing = new Set();
const verifying = new Set();
const authenticating = new Set();

// ---- storage helpers --------------------------------------------------------

async function settings() {
  const { apiUrl = '', token = '', paused = false } = await chrome.storage.local.get(['apiUrl', 'token', 'paused']);
  return { apiUrl: apiUrl.replace(/\/$/, ''), token, paused };
}

/** Tasks keyed by tab id. */
let taskWrites = Promise.resolve();
let historyWrites = Promise.resolve();
let restorePromise;
async function getTasks() {
  restorePromise ??= (async () => {
    const { updateCheckpoint } = await chrome.storage.local.get('updateCheckpoint');
    if (!updateCheckpoint) return;
    const existing = (await chrome.storage.session.get('tasks')).tasks ?? {};
    // Preserve submitted/waiting tasks across an extension update: restoring
    // them must never reset them to a fresh submission.
    await chrome.storage.session.set({ tasks: { ...updateCheckpoint.tasks, ...existing } });
    await chrome.storage.local.set({ updateCheckpoint: null, paused: updateCheckpoint.paused });
  })();
  await restorePromise;
  await taskWrites;
  return (await chrome.storage.session.get('tasks')).tasks ?? {};
}

async function setTask(tabId, task) {
  const write = taskWrites.then(async () => {
    const tasks = (await chrome.storage.session.get('tasks')).tasks ?? {};
    if (task) tasks[tabId] = task;
    else {
      filling.delete(tasks[tabId]?.job.jobId);
      delete tasks[tabId];
    }
    await chrome.storage.session.set({ tasks });
  });
  taskWrites = write.catch(() => {});
  await write;
  await updateBadge();
}

async function log(entry) {
  const write = historyWrites.then(async () => {
    const { history = [] } = await chrome.storage.local.get('history');
    history.unshift({ at: new Date().toISOString(), ...entry });
    await chrome.storage.local.set({ history: history.slice(0, LOG_LIMIT) });
  });
  historyWrites = write.catch(() => {});
  await write;
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

async function api(path, body, method = 'POST') {
  const { apiUrl, token } = await settings();
  if (!apiUrl || !token) throw new Error('Chưa ghép nối: mở Cài đặt của tiện ích');
  const response = await fetch(`${apiUrl}/api/v1/extension/agent/${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json' },
    body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
    signal: AbortSignal.timeout(15_000),
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
    if (task.job.kind === 'LOGIN_CHECK') {
      await api(`login-checks/${task.job.jobId}/result`, { outcome, message: extra.message,
        detectedUsername: extra.detectedUsername, googleBlocked: extra.googleBlocked });
    } else await api(`tasks/${task.job.jobId}/result`, { outcome, ...extra });
    await log({ jobId: task.job.jobId, account: task.job.account.name, platform: task.job.account.platform, outcome, ...extra });
    return true;
  } catch (error) {
    await log({ jobId: task.job.jobId, account: task.job.account.name, platform: task.job.account.platform, outcome: 'REPORT_FAILED', message: String(error.message ?? error) });
    return false;
  }
}

// ---- task lifecycle -----------------------------------------------------------

function withDeadline(promise, timeoutMs) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('AUTH_STEP_TIMEOUT')), timeoutMs);
  })]).finally(() => clearTimeout(timer));
}

function composerUrl(job) {
  if (job.recipe.engine !== 'discourse' || !job.post) return job.openUrl;
  // Discourse's /new-topic route sets its own composer model from these fields.
  // Keep the DOM runner for verification, long posts, tags and the final click.
  const url = new URL(job.openUrl);
  url.searchParams.delete('body');
  url.searchParams.set('title', job.post.title);
  const titleUrl = url.toString();
  url.searchParams.set('body', job.post.body);
  return url.toString().length <= 6000 ? url.toString() : titleUrl;
}

async function start(job, waitForFill = true) {
  const origins = [`${job.targetOrigin}/*`, ...(job.auth?.allowedOrigins ?? []).map(origin => `${origin}/*`), ...(job.auth?.autoLogin && job.auth.provider === 'google' ? ['https://accounts.google.com/*'] : [])];
  if (!await chrome.permissions.contains({ origins })) {
    await report({ job }, 'FAILED', { reason: 'PERMISSION_REQUIRED', message: `Tiện ích chưa được cấp quyền cho ${job.targetOrigin}. Mở Cài đặt → Cấp quyền diễn đàn.` });
    return;
  }
  job = { ...job, openUrl: composerUrl(job) };
  // Discourse opens its composer after client-side navigation. Keep that tab
  // visible so background-tab rendering does not leave it on the category list.
  const foreground = job.kind !== 'LOGIN_CHECK' && (job.recipe.engine === 'discourse' || job.recipe.workflow === 'social');
  const tab = await chrome.tabs.create({ url: job.auth ? job.auth.loginUrl || job.targetOrigin : job.openUrl, active: foreground });
  const task = { job, tabId: tab.id, phase: 'loading', deadline: Date.now() + LOAD_TIMEOUT_MS };
  await setTask(tab.id, task);
  await log({ jobId: job.jobId, account: job.account.name, platform: job.account.platform, outcome: 'RECEIVED', message: job.kind === 'LOGIN_CHECK' ? 'Đang test đăng nhập, không đăng bài.' : `Đã nhận bài từ web: ${job.post?.title ?? ''} · ${job.post?.body?.length ?? 0} ký tự` });
  if (foreground) await focusTab(tab.id);
  if (waitForFill) await tryFill(task);
  else void tryFill(task);
}

// A usable composer can appear while analytics/iframes keep the tab loading.
// Also recover when onUpdated fired before tabs.create returned and we stored it.
async function tryFill(task) {
  if (probing.has(task.job.jobId) || filling.has(task.job.jobId)) return;
  probing.add(task.job.jobId);
  try {
    let current = (await getTasks())[task.tabId];
    if (current?.phase !== 'loading' || current.job.jobId !== task.job.jobId) return;
    if (current.job.auth && !current.authVerified) {
      if (!await authenticateTask(current)) return;
      current = (await getTasks())[task.tabId];
      if (!current) return;
    }
    if (current.job.kind === 'LOGIN_CHECK') return; // authentication owns completion; never inspect a composer
    const [{ result: ready }] = await chrome.scripting.executeScript({
      target: { tabId: task.tabId }, func: canFillPage,
      args: [task.job.recipe, task.job.targetOrigin], injectImmediately: true,
    });
    if (ready) await fill(current);
  } catch (error) {
    // Keep the actual injection error instead of reporting every failure as a
    // slow page. Navigation can still recover on the next tab update/alarm.
    const current = (await getTasks())[task.tabId];
    if (current?.phase === 'loading' && current.job.jobId === task.job.jobId) {
      await setTask(task.tabId, { ...current, probeError: String(error.message ?? error).slice(0, 350) });
    }
  } finally { probing.delete(task.job.jobId); }
}

async function authenticateTask(task) {
  if (authenticating.has(task.job.jobId)) return false;
  authenticating.add(task.job.jobId);
  let current = { ...task, phase: 'authenticating', authDeadline: task.authDeadline ?? Date.now() + (task.job.kind === 'LOGIN_CHECK' ? task.job.auth.provider === 'google' ? 75_000 : 40_000 : 180_000) };
  await setTask(task.tabId, current);
  const stop = async (message, reason = 'AUTH_REQUIRED', closeOwnedTabs = false, googleBlocked = false, detectedUsername) => {
    await report(current, 'NEEDS_ACTION', { reason, message, detectedUsername, googleBlocked: task.job.auth.provider === 'google' && googleBlocked });
    if (task.job.kind === 'LOGIN_CHECK') {
      await setTask(task.tabId, null);
      if (closeOwnedTabs) for (const id of new Set([task.tabId, current.authTabId].filter(id => id !== undefined && id !== null))) {
        try { await chrome.tabs.remove(id); } catch { /* already closed */ }
      }
      return false;
    }
    await setTask(task.tabId, { ...current, phase: 'waitingAuth', deadline: Date.now() + WAIT_USER_MS });
    await focusTab(current.authTabId ?? task.tabId);
    return false;
  };
  try {
    while (Date.now() < current.authDeadline) {
      current = (await getTasks())[task.tabId];
      if (!current || current.phase !== 'authenticating') return false;
      const tabId = current.authTabId ?? task.tabId;
      let result;
      let documentId;
      try { [{ result, documentId }] = await withDeadline(chrome.scripting.executeScript({ target: { tabId }, func: accountAuthStep, args: [{ job: { ...task.job, authIdentityVerified: current.googleIdentityVerified === true } }], injectImmediately: true }), 8_000); }
      catch (error) {
        if (error.message === 'AUTH_STEP_TIMEOUT') return stop('Trang không phản hồi kiểm tra trong 8 giây. Đã dừng lượt này để tiếp tục các nền tảng khác.');
        try {
          const tab = await chrome.tabs.get(tabId);
          if (tab.url?.startsWith('https://')) {
            const origin = new URL(tab.url).origin;
            const allowed = [task.job.targetOrigin, ...(task.job.auth.allowedOrigins ?? []), ...(task.job.auth.provider === 'google' ? ['https://accounts.google.com'] : [])];
            if (!allowed.includes(origin)) return stop(`Trang đăng nhập chuyển sang ${origin}; tên miền này chưa được cấu hình cho tài khoản.`);
          }
        } catch { return stop('Tab xác thực đã đóng hoặc không còn truy cập được. Chưa xác nhận đúng hồ sơ.'); }
        await new Promise(resolve => setTimeout(resolve, 750)); continue;
      }
      // tabs.update resolves before its previous document is replaced. Never
      // authenticate/fill that old document while the composer is navigating.
      if (current.authSourceDocumentId && documentId === current.authSourceDocumentId) {
        await new Promise(resolve => setTimeout(resolve, 250)); continue;
      }
      if (Date.now() >= current.authDeadline) break;
      if (result?.url) current.authOrigin = new URL(result.url).origin;
      if (result?.verifiedGoogleIdentity && !current.googleIdentityVerified) {
        current = { ...(await getTasks())[task.tabId], googleIdentityVerified: true };
        await setTask(task.tabId, current);
      }
      if (task.job.kind === 'LOGIN_CHECK' && result?.state === 'unknown') {
        if (!current.authActivated) {
          // Several SPAs defer account hydration until their tab becomes visible.
          // Activate this owned test tab once before deciding the form is absent.
          current = { ...current, authActivated: true, authUnknownSince: null };
          await setTask(task.tabId, current);
          await focusTab(tabId);
          await new Promise(resolve => setTimeout(resolve, 1500));
          continue;
        }
        if (current.authUnknownSince && Date.now() - current.authUnknownSince > 8_000) return stop('Trang đã tải nhưng chưa nhận diện được form đăng nhập hoặc đúng tài khoản. Cần cập nhật luồng của nền tảng này.');
        if (!current.authUnknownSince) { current = { ...current, authUnknownSince: Date.now() }; await setTask(task.tabId, current); }
      } else if (current.authUnknownSince) { current = { ...current, authUnknownSince: null }; await setTask(task.tabId, current); }
      if (result?.state === 'authenticated') {
        if (task.job.kind === 'LOGIN_CHECK') {
          await report(current, 'AUTHENTICATED', { message: 'Đã xác nhận phiên đăng nhập. Chưa kiểm tra quyền đăng bài.', detectedUsername: result.detectedUsername });
          await setTask(task.tabId, null);
          try { await chrome.tabs.remove(task.tabId); } catch { /* already closed */ }
          return false;
        }
        if (tabId !== task.tabId || !current.authReturning) {
          if (tabId !== task.tabId) { try { await chrome.tabs.remove(tabId); } catch { /* popup closed */ } }
          // The destination creates a new menu after navigation. Only this
          // harmless menu action may repeat; never reset password/TOTP attempts.
          const { accountMenu: _previousMenu, ...authSteps } = current.authSteps ?? {};
          current = { ...current, authTabId: null, authReturning: true, authSteps, authSourceDocumentId: tabId === task.tabId ? documentId : null };
          await setTask(task.tabId, current);
          await chrome.tabs.update(task.tabId, { url: task.job.openUrl });
        } else {
          await setTask(task.tabId, { ...current, phase: 'loading', authVerified: true, deadline: Date.now() + LOAD_TIMEOUT_MS });
          return true;
        }
      } else if (result?.state === 'mismatch') {
        return stop('Chrome đang đăng nhập tài khoản khác. Kiểm tra hồ sơ đã gán trên web; chưa điền hoặc đăng bài.', 'ACCOUNT_MISMATCH', false, false, result.detectedUsername);
      } else if (result?.state === 'challenge') {
        return stop(result.message, 'AUTH_REQUIRED', false, result.googleBlocked === true);
      } else if (['identifier', 'password', 'totp', 'google', 'chooser', 'alternate', 'totpChoice', 'openLogin', 'sso', 'accountMenu'].includes(result?.state)) {
        if (!task.job.auth.autoLogin && result.state !== 'accountMenu') return stop('Chưa nhận diện được phiên sẵn có và tài khoản này chưa bật tự đăng nhập hoặc còn thiếu thông tin xác thực.');
        const attempted = current.authSteps?.[result.state];
        if (attempted && Date.now() - attempted > 15_000) return stop(result.state === 'accountMenu'
          ? 'Trang đã đăng nhập nhưng tiện ích chưa mở được menu để xác nhận đúng hồ sơ. Chưa thử lại mật khẩu.'
          : `Bước đăng nhập chưa được chấp nhận (${result.state} tại ${new URL(result.url).origin}${new URL(result.url).pathname}); không tự thử lặp mật khẩu hoặc mã TOTP.`);
        if (!attempted) {
          current = { ...current, authSteps: { ...current.authSteps, [result.state]: Date.now() } };
          await setTask(task.tabId, current); // reserve before obtaining a secret
          if (result.state === 'accountMenu') {
            await focusTab(tabId);
            await new Promise(resolve => setTimeout(resolve, 350));
          }
          let payload;
          if (['identifier', 'password', 'totp'].includes(result.state)) {
            try { payload = await api(`${task.job.kind === 'LOGIN_CHECK' ? 'login-checks' : 'tasks'}/${task.job.jobId}/auth`, { step: result.state, pageUrl: result.url }); }
            catch { return stop('Không lấy được thông tin đăng nhập cho đúng tài khoản/hồ sơ. Kiểm tra cấu hình và giao lại bài từ web.'); }
          }
          try {
            if (Date.now() >= current.authDeadline) return stop('Đã hết thời gian của lượt đăng nhập; không gửi thêm thông tin xác thực.', 'AUTH_REQUIRED', true);
            const [{ result: applied }] = await withDeadline(chrome.scripting.executeScript({ target: { tabId }, func: accountAuthStep,
              args: [{ job: { ...task.job, authIdentityVerified: current.googleIdentityVerified === true }, action: result.state === 'chooser' ? 'choose' : result.state, payload, expectedPageUrl: result.url }], injectImmediately: true }), 10_000);
            if (applied?.verifiedGoogleIdentity) { current = { ...(await getTasks())[task.tabId], googleIdentityVerified: true }; await setTask(task.tabId, current); }
            if (applied?.state === 'challenge') return stop(applied.message, 'AUTH_REQUIRED', false, applied.googleBlocked === true);
          } catch (error) {
            if (error.message === 'AUTH_STEP_TIMEOUT') return stop('Trang không phản hồi thao tác đăng nhập. Đã đóng tab test bị kẹt; không tự gửi lại mật khẩu hoặc TOTP.', 'AUTH_REQUIRED', true);
            /* A successful submit can destroy the execution context. Recheck identity. */
          }
          finally { payload = undefined; }
        }
      } else if (!current.authLoginOpened && !current.authReturning && task.job.auth.autoLogin
        && !Object.keys(current.authSteps ?? {}).some(step => step !== 'accountMenu')) {
        // Only use the configured login URL before authentication starts. SSO
        // callbacks can briefly be blank; navigating here would cancel them.
        current = { ...current, authLoginOpened: true };
        await setTask(task.tabId, current);
        await chrome.tabs.update(task.tabId, { url: task.job.auth.loginUrl });
      }
      await new Promise(resolve => setTimeout(resolve, 750));
    }
    return stop('Chưa xác nhận được đúng tài khoản sau đăng nhập. Kiểm tra username/URL hồ sơ hoặc CSS nhận diện trong cấu hình trên web.');
  } finally {
    authenticating.delete(task.job.jobId);
    if (task.job.kind === 'LOGIN_CHECK' && !(await getTasks())[task.tabId]) void tick();
  }
}

async function fill(task) {
  if (task.job.kind === 'LOGIN_CHECK') throw new Error('Login checks cannot publish');
  if (filling.has(task.job.jobId)) return;
  filling.add(task.job.jobId);
  const active = { ...task, phase: 'filling', deadline: Date.now() + LOAD_TIMEOUT_MS };
  await setTask(task.tabId, active);
  let result;
  try {
    if (task.job.auth) {
      const identity = await verifyOwnIdentity(task);
      if (identity?.state !== 'authenticated') {
        await report(task, 'NEEDS_ACTION', { reason: identity?.state === 'mismatch' ? 'ACCOUNT_MISMATCH' : 'AUTH_REQUIRED', message: 'Phiên thay đổi trước khi điền bài. Kiểm tra đúng tài khoản trong hồ sơ Chrome.' });
        filling.delete(task.job.jobId);
        await setTask(task.tabId, { ...task, phase: 'waitingAuth', deadline: Date.now() + WAIT_USER_MS });
        return;
      }
      task = { ...task, job: { ...task.job, verifiedSessionUsername: identity.detectedUsername || task.job.auth.expectedUsername } };
    }
    let attachments;
    if (task.job.recipe.requiredMedia) {
      if (task.job.media?.length !== 1 || task.job.media[0].sizeBytes > 20 * 1024 * 1024) {
        result = { status: 'mediaRequired', message: 'Đính kèm đúng một file phù hợp, tối đa 20 MiB, cho bài trên web trước khi chạy.' };
      } else {
        try { attachments = [await api(`tasks/${task.job.jobId}/media/${task.job.media[0].id}`, undefined, 'GET')]; }
        catch (error) { result = { status: 'mediaRequired', message: `Không tải được file đính kèm: ${error.message}` }; }
      }
    }
    if (!result && task.job.recipe.engine === 'discourse' && task.job.autoSubmit) {
      [{ result }] = await chrome.scripting.executeScript({ target: { tabId: task.tabId }, func: submitDiscoursePost, args: [task.job], injectImmediately: true });
      if (result?.status === 'fallback') result = null;
    }
    if (!result) [{ result }] = await chrome.scripting.executeScript({ target: { tabId: task.tabId }, func: task.job.recipe.workflow === 'social' ? fillSocialAndSubmit : fillAndSubmit,
      args: [{ ...task.job, ...(attachments ? { attachments } : {}) }], injectImmediately: true });
  } catch (error) {
    result = { status: 'uncertain', message: `Không xác nhận được thao tác trong tab: ${error.message ?? error}` };
  }
  if (finishing.has(task.job.jobId) || !(await getTasks())[task.tabId]) return;
  const now = Date.now();
  switch (result?.status) {
    case 'published':
      await published(task, result.url);
      return;
    case 'moderation':
      await finishReport(task, 'NEEDS_ACTION', { reason: 'MODERATION_PENDING', message: result.message });
      return;
    case 'restricted':
      await report(task, 'FAILED', { reason: 'PERMISSION_REQUIRED', message: result.message });
      await setTask(task.tabId, null);
      return;
    case 'submitted':
      await setTask(task.tabId, { ...task, beforeUrls: result.beforeUrls ?? [], phase: 'submitted', submittedAt: now, deadline: now + SUBMIT_CONFIRM_MS });
      if (task.job.recipe.workflow === 'social') void checkPublished((await getTasks())[task.tabId]);
      return;
    case 'captcha':
    case 'uncertain':
    case 'rejected':
    case 'filled': {
      const captcha = result.status === 'captcha';
      await report(task, 'NEEDS_ACTION', {
        reason: captcha ? 'CAPTCHA_REQUIRED' : result.status === 'uncertain' ? 'SUBMIT_UNCONFIRMED' : result.status === 'rejected' ? 'SUBMIT_REJECTED' : 'WAITING_USER',
        message: result.message ?? (captcha ? 'Hoàn thành CAPTCHA rồi bấm Đăng trong tab vừa mở' : 'Kiểm tra nội dung rồi bấm Đăng trong tab vừa mở'),
      });
      await setTask(task.tabId, { ...task, beforeUrls: result.beforeUrls ?? [], phase: 'waitingUser', waitingMessage: result.message,
        waitingReason: captcha ? 'CAPTCHA_REQUIRED' : result.status === 'filled' ? 'WAITING_USER' : result.status === 'rejected' ? 'SUBMIT_REJECTED' : 'SUBMIT_UNCONFIRMED', deadline: now + WAIT_USER_MS });
      await focusTab(task.tabId);
      return;
    }
    case 'login':
      await report(task, 'FAILED', { reason: 'LOGIN_REQUIRED', message: result.message });
      await setTask(task.tabId, null);
      await focusTab(task.tabId);
      return;
    case 'mediaRequired':
    case 'unavailable':
      await report(task, 'FAILED', { reason: result.status === 'mediaRequired' ? 'MEDIA_REQUIRED' : 'PLATFORM_UNAVAILABLE', message: result.message });
      await setTask(task.tabId, null);
      return;
    default:
      await report(task, 'FAILED', { reason: 'EDITOR_NOT_FOUND', message: result?.message ?? 'Không nhận diện được trang' });
      await setTask(task.tabId, null);
      await focusTab(task.tabId);
  }
}

// Read the own-account marker, opening its menu if needed. This never obtains
// a password or OTP, changes account, or submits a login form.
async function verifyOwnIdentity(task) {
  const probe = async action => {
    const [{ result }] = await chrome.scripting.executeScript({ target: { tabId: task.tabId }, func: accountAuthStep,
      args: [{ job: task.job, ...(action ? { action } : {}) }], injectImmediately: true });
    return result;
  };
  let identity = await probe();
  if (identity?.state === 'accountMenu') {
    await probe('accountMenu');
    await new Promise(resolve => setTimeout(resolve, 500));
    identity = await probe();
  }
  return identity;
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
  await finishReport(task, 'PUBLISHED', { url }, task.phase !== 'waitingUser');
}

async function finishReport(task, outcome, extra, closeTab = false) {
  if (finishing.has(task.job.jobId)) return;
  finishing.add(task.job.jobId);
  try {
    // Retain the verified receipt across transient backend outages. A retry of
    // this phase only reports the result; it never fills or submits again.
    await setTask(task.tabId, { ...task, phase: 'reporting', pendingReport: { outcome, extra, closeTab } });
    if (outcome === 'PUBLISHED' || extra.reason === 'MODERATION_PENDING') {
      try {
        await chrome.scripting.executeScript({ target: { tabId: task.tabId }, func: showPublishNotice, args: [{
          jobId: task.job.jobId, targetOrigin: task.job.targetOrigin, title: task.job.post?.title,
          status: outcome === 'PUBLISHED' ? 'published' : 'moderation', url: extra.url,
        }] });
      } catch { /* A closed tab cannot prevent recording an accepted post. */ }
    }
    if (!await report(task, outcome, extra)) return;
    await setTask(task.tabId, null);
    if (closeTab) { try { await chrome.tabs.remove(task.tabId); } catch { /* already closed */ } }
  } finally {
    finishing.delete(task.job.jobId);
  }
}

async function checkPublished(task, candidateUrl) {
  if (!task || ['authenticating', 'waitingAuth', 'reporting'].includes(task.phase) || (task.job.recipe.workflow === 'social' && task.phase === 'filling')) return false;
  if (verifying.has(task.job.jobId) || finishing.has(task.job.jobId)) return false;
  verifying.add(task.job.jobId);
  try {
    const url = new URL(candidateUrl ?? (await chrome.tabs.get(task.tabId)).url);
    if (url.origin !== task.job.targetOrigin || (task.job.recipe.workflow !== 'social' && !new RegExp(task.job.recipe.successUrlPattern).test(url.href))) return false;
    const [{ result }] = await chrome.scripting.executeScript({ target: { tabId: task.tabId }, func: task.job.recipe.workflow === 'social' ? readSocialPublishedPost : readPublishedPost, args: [task] });
    if (!result || !(await getTasks())[task.tabId]) return false;
    await published(task, result);
    return true;
  } catch { return false; } // SPA rendering may finish on a later tick.
  finally { verifying.delete(task.job.jobId); }
}

async function checkModeration(task) {
  try {
    const [{ result }] = await chrome.scripting.executeScript({ target: { tabId: task.tabId }, func: readModeration, args: [task.job.recipe] });
    if (!result) return false;
    await finishReport(task, 'NEEDS_ACTION', { reason: 'MODERATION_PENDING', message: result });
    return true;
  } catch { return false; }
}

async function checkSubmitted(task) {
  const now = Date.now();
  if (now - task.submittedAt < ERROR_CHECK_AFTER_MS && now < task.deadline) return;
  let errorText = null;
  try {
    if (await checkModeration(task)) return;
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
    if (task.phase === 'reporting' && task.pendingReport) {
      await finishReport(task, task.pendingReport.outcome, task.pendingReport.extra, task.pendingReport.closeTab);
      continue;
    }
    if (task.phase === 'authenticating') {
      if (!authenticating.has(task.job.jobId)) void authenticateTask(task).then(async ready => { if (ready) await tryFill((await getTasks())[task.tabId]); });
      continue;
    }
    if (task.phase === 'waitingAuth') {
      if (now >= task.deadline) await setTask(task.tabId, null);
      else if (now - (task.lastIdentityCheck ?? 0) >= 30_000) {
        await setTask(task.tabId, { ...task, lastIdentityCheck: now });
        try {
          const identity = await verifyOwnIdentity(task);
          if (identity?.state === 'authenticated') {
            const resumed = { ...task, phase: 'loading', authVerified: true, deadline: now + LOAD_TIMEOUT_MS };
            await setTask(task.tabId, resumed);
            if (!task.authReturning) await chrome.tabs.update(task.tabId, { url: task.job.openUrl });
            else void tryFill(resumed);
          }
        } catch { /* A later heartbeat may find the restored session. */ }
      }
      continue;
    }
    if (task.phase !== 'loading' && await checkPublished(task)) continue;
    if (task.phase === 'waitingUser' && await checkModeration(task)) continue;
    if (task.phase === 'submitted') await checkSubmitted(task);
    else if (task.phase === 'loading') {
      void checkLoading(task);
    } else if (now >= task.deadline && task.phase === 'filling' && !filling.has(task.job.jobId)) {
      await report(task, 'NEEDS_ACTION', { reason: 'SUBMIT_UNCONFIRMED', message: 'Tiện ích khởi động lại khi đang thao tác. Kiểm tra tab và bài đã đăng trước khi thử lại.' });
      await setTask(task.tabId, { ...task, phase: 'waitingUser', deadline: now + WAIT_USER_MS });
    } else if (now >= task.deadline && task.phase === 'waitingUser') {
      await setTask(task.tabId, null); // the job stays in "Cần xử lý" on the dashboard
    }
  }
}

async function checkLoading(task) {
  await tryFill(task);
  const current = (await getTasks())[task.tabId];
  if (current?.phase === 'loading' && Date.now() >= current.deadline && !probing.has(task.job.jobId)) {
    await report(task, 'FAILED', { reason: 'PAGE_LOAD_FAILED', message: current.probeError ? `Không kiểm tra được form: ${current.probeError}` : 'Trang diễn đàn không tải xong' });
    await setTask(task.tabId, null);
  }
}

let tickInFlight = null;
let tickAgain = false;
function tick() {
  // Startup, pairing, the alarm and manual refresh can arrive together. Share
  // one run so they cannot claim multiple jobs before the first tab is stored.
  if (tickInFlight) { tickAgain = true; return tickInFlight; }
  tickInFlight = runTick().finally(() => {
    tickInFlight = null;
    if (tickAgain) { tickAgain = false; void tick(); }
  });
  return tickInFlight;
}

async function runTick() {
  const { apiUrl, token, paused } = await settings();
  if (!apiUrl || !token) return;
  try {
    const beat = await api('heartbeat');
    await chrome.storage.local.set({ lastHeartbeat: { at: new Date().toISOString(), ...beat }, lastError: null });
    await sweep();
    if (!paused && beat.loginChecks) {
      const permitted = await Promise.all((beat.origins ?? []).map(async origin =>
        await chrome.permissions.contains({ origins: [`${origin}/*`] }) ? origin : null));
      for (let picked = 0; picked < MAX_LOGIN_CHECKS; picked++) {
        const active = Object.values(await getTasks());
        if (active.length >= MAX_LOGIN_CHECKS || active.some(item => item.job.kind !== 'LOGIN_CHECK')) break;
        const { task: loginCheck } = await api('login-checks/claim', { allowedOrigins: permitted.filter(Boolean) });
        if (!loginCheck) break;
        await start(loginCheck, false);
      }
    }
    const { loginChecksOnly = false } = await chrome.storage.local.get('loginChecksOnly');
    if (loginChecksOnly || Object.values(await getTasks()).some(item => item.job.kind === 'LOGIN_CHECK')) { await updateBadge(); return; }
    for (let picked = 0; !paused && picked < Math.min(MAX_ACTIVE_FLOWS, beat.waiting ?? 0); picked++) {
      const tasks = Object.values(await getTasks());
      const active = tasks.filter((task) => ['loading', 'authenticating', 'filling', 'submitted', 'reporting'].includes(task.phase));
      if (active.length >= MAX_ACTIVE_FLOWS || tasks.filter((task) => ['waitingUser', 'waitingAuth'].includes(task.phase)).length >= MAX_WAITING_TABS) break;
      // A waiting composer also owns this forum's draft. Other origins can
      // continue, but a second tab on this origin could overwrite that draft.
      const excludeOrigins = [...new Set(tasks.map((task) => task.job.targetOrigin))];
      const { task: job } = await api('claim', { excludeOrigins, supportedEngines: SUPPORTED_ENGINES, authProtocol: 1 });
      if (!job) break;
      // The backend skips these origins before claiming, so a second job for a
      // busy forum cannot prevent another platform from starting.
      await start(job, false);
    }
  } catch (error) {
    await chrome.storage.local.set({ lastError: { at: new Date().toISOString(), message: String(error.message ?? error) } });
  }
  await updateBadge();
}

// ---- events -----------------------------------------------------------------

async function ensureAlarm() {
  const alarm = await chrome.alarms.get(TICK_ALARM);
  if (!alarm || alarm.periodInMinutes !== 0.5) {
    await chrome.alarms.create(TICK_ALARM, { periodInMinutes: 0.5 });
  }
}

async function startPolling() {
  try {
    await ensureAlarm();
    await tick();
  } catch (error) {
    await chrome.storage.local.set({ lastError: { at: new Date().toISOString(), message: String(error.message ?? error) } });
    await updateBadge();
  }
}

chrome.runtime.onInstalled.addListener(() => { void startPolling(); });
chrome.runtime.onStartup.addListener(() => { void startPolling(); });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === TICK_ALARM) void startPolling();
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && ('apiUrl' in changes || 'token' in changes || changes.paused?.newValue === false)) {
    void startPolling();
  }
});
chrome.permissions.onAdded.addListener(() => { void startPolling(); });
async function trackAuthPopup(sourceTabId, tabId) {
  const task = (await getTasks())[sourceTabId];
  if (task?.phase === 'authenticating' && task.job.auth?.provider === 'google' && !task.authTabId) {
    await setTask(task.tabId, { ...task, authTabId: tabId });
  }
}
chrome.tabs.onCreated.addListener(tab => {
  if (tab.openerTabId !== undefined) void trackAuthPopup(tab.openerTabId, tab.id);
});
// New-window OAuth popups may have no openerTabId in tabs.onCreated.
// webNavigation carries the actual source tab, including noopener windows.
chrome.webNavigation?.onCreatedNavigationTarget.addListener(details => {
  void trackAuthPopup(details.sourceTabId, details.tabId);
});

// Alarms can be cleared across browser sessions on supported older Chromes.
// Repair a missing alarm whenever the worker wakes, without postponing one
// already scheduled. No popup needs to stay open for polling to work.
void ensureAlarm().catch(() => {});

chrome.tabs.onUpdated.addListener(async (tabId, info, tab) => {
  const task = (await getTasks())[tabId];
  if (!task) return;
  const url = info.url ?? tab.url ?? '';
  if (task.phase !== 'loading' && url && await checkPublished(task, url)) return;
  if (task.phase === 'loading' && (info.status || info.url)) await tryFill(task);
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const parent = Object.values(await getTasks()).find(item => item.authTabId === tabId);
  if (parent) await setTask(parent.tabId, { ...parent, authTabId: null });
  const task = (await getTasks())[tabId];
  if (!task) return;
  if (task.phase === 'loading') {
    await report(task, 'FAILED', { reason: 'CANCELLED', message: 'Tab bị đóng trước khi điền nội dung' });
  } else if (task.phase === 'authenticating') {
    await report(task, 'NEEDS_ACTION', { reason: 'AUTH_REQUIRED', message: 'Tab đăng nhập đã đóng trước khi xác nhận đúng tài khoản.' });
  } else if (task.phase === 'submitted' || task.phase === 'filling') {
    await report(task, 'NEEDS_ACTION', { reason: 'SUBMIT_UNCONFIRMED', message: 'Tab bị đóng ngay sau khi bấm Đăng. Kiểm tra diễn đàn.' });
  }
  await setTask(tabId, null);
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'resume-pre-submit' && _sender.id === chrome.runtime.id) {
    (async () => {
      const task = Object.values(await getTasks()).find(item => item.job.jobId === message.jobId);
      const { history = [] } = await chrome.storage.local.get('history');
      const reason = task?.waitingReason ?? history.find(item => item.jobId === message.jobId && item.outcome === 'NEEDS_ACTION')?.reason;
      if (!task || task.phase !== 'waitingUser' || task.submittedAt || reason !== 'WAITING_USER') return { ok: false, message: 'Chỉ tiếp tục bài đã dừng trước khi gửi.' };
      filling.delete(task.job.jobId);
      const next = { ...task, phase: 'loading', deadline: Date.now() + LOAD_TIMEOUT_MS };
      await setTask(task.tabId, next);
      void tryFill(next);
      return { ok: true };
    })().then(sendResponse);
    return true;
  }
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
