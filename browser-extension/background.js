// Service worker: polls the backend for posts, drives forum tabs and reports
// the outcome. Up to two publishing flows run at once, always on different
// sites. Tabs left for the operator (CAPTCHA, "check then click Post", a failed
// post kept open) do not hold a flow and are released after 10 minutes.
// State lives in chrome.storage because MV3 service workers stop when idle.
import { canFillPage, fillAndSubmit, readErrors, readModeration, readPublishedPost } from './page-actions.js';
import { fillSocialAndSubmit, readSocialPublishedPost } from './social-actions.js';
import { accountAuthStep } from './auth-actions.js';
import { submitDiscoursePost } from './discourse-session.js';
import { showPublishNotice } from './publish-notice.js';
import { collectUiCandidates, verifyUiSelectors } from './ui-recovery.js';
import { applyFormActions, collectFormControls } from './form-fill.js';
import { applyProxy, PROXY_STORAGE_KEY, registerProxyAuth } from './proxy.js';

// The proxy's login prompt can arrive before anything else wakes the worker.
registerProxyAuth();

const TICK_ALARM = 'tick';
const LOAD_TIMEOUT_MS = 90_000;
// Some editors (Tinhte, DZone, Quora) take well over a minute to create and
// render a post; confirmation polls every few seconds within this window.
const SUBMIT_CONFIRM_MS = 180_000;
const SUBMIT_POLL_MS = 5_000;
const PROFILE_VERIFY_MS = 60_000;
const ERROR_CHECK_AFTER_MS = 12_000;
// An error banner must still be there this long after it was first seen.
const ERROR_CONFIRM_MS = 8_000;
// A tab waiting for the operator (draft to check, CAPTCHA, sign-in, a failed or
// unconfirmed post kept open) is tracked this long, then closed and forgotten so
// its site no longer blocks the queue. The post stays on the web under "Cần thao tác".
const WAIT_USER_MS = 10 * 60_000;
// Waiting tabs do not hold a flow; this only bounds how many tabs one Chrome owns.
const MAX_OWNED_TABS = 8;
const MAX_REPORT_MESSAGE = 450;
// Concurrent publishing flows, each on a different site (origin).
const MAX_ACTIVE_FLOWS = 2;
// Phases that hold one of the MAX_ACTIVE_FLOWS slots. Waiting tabs never do.
const FLOW_PHASES = ['loading', 'authenticating', 'filling', 'submitted', 'verifying', 'reporting'];
const MAX_LOGIN_CHECKS = 1;
// Fields reported back for a publish job; the backend refuses unknown ones.
const TASK_RESULT_FIELDS = ['url', 'reason', 'message', 'detectedUsername', 'googleBlocked'];
// When a post finishes or is handed to the operator, ask for the next one
// shortly instead of waiting up to 30 seconds for the alarm.
const NEXT_JOB_DELAY_MS = 1_000;
// AI-assisted recovery when a composer control is not found (site redesign).
// A second round is only for "the opener was found, now find the fields".
const MAX_UI_HINT_ROUNDS = 2;
const UI_HINT_POLL_MS = 2_000;
const UI_HINT_WAIT_MS = 90_000;
const UI_HINT_FIELDS = ['title', 'body', 'submit', 'opener'];
// AI form-fill for required controls the recipe does not know (community,
// language, rules checkbox…): ask, poll, apply, then verify once more.
const MAX_FORM_FILL_ROUNDS = 2;
const FORM_FILL_POLL_MS = 2_000;
const FORM_FILL_WAIT_MS = 60_000;
const FORM_FILL_UNSURE = 'AI chưa điền chắc chắn các mục bắt buộc; mở tab để kiểm và bấm Đăng.';
const FORM_ACTIONS = { select: ['select'], checkbox: ['check', 'uncheck'], radio: ['check'], combobox: ['select', 'type'], text: ['type'] };
// A Google-login account on a page that only offers the site's own form: give a
// late-rendered Google button this long before reporting it.
const NO_GOOGLE_GRACE_MS = 6_000;
// Cloudflare's full-page "Just a moment…" browser check usually passes by itself
// in a few seconds; datacenter IPs (a VPS) see it far more often than home ones.
const CLOUDFLARE_WAIT_MS = 20_000;
// Sign-in buttons that start Google/SSO often do nothing in a hidden background
// tab: bring the test tab to the front before pressing them.
const VISIBLE_AUTH_STEPS = ['accountMenu', 'google', 'openLogin', 'sso'];
// An unrecognized signed-in page is given this long before the profile page is opened.
const PROFILE_CHECK_AFTER_MS = 2_000;
// One page probe during sign-in. A page still loading (slow site, proxy) gets more probes within the sign-in deadline.
const AUTH_PROBE_TIMEOUT_MS = 8_000;
const LOG_LIMIT = 20;
const SUPPORTED_ENGINES = ['producthunt', 'discourse', 'xenforo', 'phpbb', 'vanilla', 'medium', 'substack', 'quora', 'reddit', 'slideshare', 'aws-builder', 'tinhte', 'pixelfed', 'mastodon', 'bluesky', 'tumblr', 'devto', 'minds', 'stackexchange', 'lemmy', 'discuit', 'linkedin', 'differ', 'dzone', 'dailydev', 'disqus', 'mewe', 'ubiquiti', 'huggingface', 'blogger', 'invision', 'flarum', 'zendesk'];

// Chrome fires several tab updates for one navigation; these guard against
// filling or reporting the same job twice while the worker is alive.
const filling = new Set();
const probing = new Set();
const finishing = new Set();
const verifying = new Set();
const concluding = new Set();
const watching = new Set();

// Progress and success toasts share alert containers with real errors
// ("Đang tạo bài viết đợi xíu nhé"). They never mean the post was rejected.
const TRANSIENT_NOTICE = /(?:đang\s+(?:tạo|đăng|lưu|gửi|xử\s+lý|tải)|đợi\s+(?:xíu|chút|một\s+chút)|vui\s+lòng\s+(?:chờ|đợi)|please\s+wait|loading|saving|posting|publishing|processing|uploading|submitting|thành\s+công|đã\s+(?:đăng|lưu|xuất\s+bản|gửi)|success|published|posted|saved)/i;

function isTransientNotice(text) {
  return TRANSIENT_NOTICE.test(String(text ?? ''));
}

/** The post may already exist: never refill, and no draft to protect on this origin. */
function isPostSubmit(task) {
  return Boolean(task.submittedAt) || ['SUBMIT_UNCONFIRMED', 'SUBMIT_REJECTED'].includes(task.waitingReason);
}

function isWaiting(task) {
  return task.phase === 'waitingUser' || task.phase === 'waitingAuth';
}

/** Holds one of the MAX_ACTIVE_FLOWS slots: not waiting, not already reported as failed. */
function occupiesFlow(task) {
  return FLOW_PHASES.includes(task.phase);
}
const authenticating = new Set();
// Publish jobs signing in through Google right now (one at a time per Chrome).
const googleSignIns = new Set();

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
    const error = new Error(response.status === 401 ? 'Mã ghép nối không hợp lệ hoặc đã bị thu hồi' : message);
    error.status = response.status;
    throw error;
  }
  return payload.data;
}

/**
 * The result body of a publish job: only the fields the backend accepts, and
 * optional ones only when they carry something (an empty username or
 * `googleBlocked: false` made older backends refuse the whole report).
 */
function taskResult(outcome, extra) {
  const body = { outcome };
  for (const field of TASK_RESULT_FIELDS) {
    const value = extra[field];
    if (field === 'googleBlocked') { if (value === true) body.googleBlocked = true; continue; }
    if (typeof value === 'string' && value.trim()) body[field] = field === 'detectedUsername' ? value.trim().slice(0, 200) : value;
  }
  return body;
}

/**
 * True once retrying is pointless: delivered, or refused by the backend (4xx,
 * e.g. the job was already finished on the web). False on transient failures.
 */
async function report(task, outcome, extra = {}) {
  if (typeof extra.message === 'string' && extra.message.length > MAX_REPORT_MESSAGE) {
    extra = { ...extra, message: `${extra.message.slice(0, MAX_REPORT_MESSAGE - 1)}…` };
  }
  try {
    if (task.job.kind === 'LOGIN_CHECK') {
      await api(`login-checks/${task.job.jobId}/result`, { outcome, message: extra.message,
        detectedUsername: extra.detectedUsername, googleBlocked: extra.googleBlocked });
    } else await api(`tasks/${task.job.jobId}/result`, taskResult(outcome, extra));
    await log({ jobId: task.job.jobId, account: task.job.account.name, platform: task.job.account.platform, outcome, ...extra });
    return true;
  } catch (error) {
    const rejected = error.status >= 400 && error.status < 500 && ![401, 408, 429].includes(error.status);
    await log({ jobId: task.job.jobId, account: task.job.account.name, platform: task.job.account.platform,
      outcome: rejected ? 'REPORT_REJECTED' : 'REPORT_FAILED', message: String(error.message ?? error) });
    return rejected;
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
  // The backend counts the body the way the destination does. A post over the
  // limit is never typed (the site would cut or refuse it): no tab is opened.
  const post = job.kind === 'LOGIN_CHECK' ? null : job.post;
  if (post && post.maxChars != null && typeof post.length === 'number' && post.length > post.maxChars) {
    await report({ job }, 'NEEDS_ACTION', { reason: 'WAITING_USER', message: `Nội dung dài ${post.length}/${post.maxChars} ký tự, vượt giới hạn của kênh này. Cần rút gọn trên web.` });
    tickSoon();
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
      // Several flows run at once; steps through the one Google session of this
      // Chrome still go one at a time. Wait (on a later tab event or sweep) while
      // another flow is on a Google sign-in step. Checking an existing session on
      // the destination does not need Google, so signed-in flows do not wait.
      if (current.job.auth.provider === 'google' && [...googleSignIns].some(jobId => jobId !== current.job.jobId)) {
        await setTask(task.tabId, { ...current, deadline: Date.now() + LOAD_TIMEOUT_MS });
        return;
      }
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

/** A login check is a background test: its tab and any sign-in popup never stay open. */
async function closeLoginCheckTabs(...tabIds) {
  for (const id of new Set(tabIds.filter(id => id !== undefined && id !== null))) {
    try { await chrome.tabs.remove(id); } catch { /* already closed */ }
  }
}

async function authenticateTask(task) {
  if (authenticating.has(task.job.jobId)) return false;
  authenticating.add(task.job.jobId);
  let current = { ...task, phase: 'authenticating', authDeadline: task.authDeadline ?? Date.now() + (task.job.kind === 'LOGIN_CHECK' ? task.job.auth.provider === 'google' ? 75_000 : 40_000 : 180_000) };
  await setTask(task.tabId, current);
  // The third argument (close tabs) is kept for call sites; login checks always close now.
  const stop = async (message, reason = 'AUTH_REQUIRED', _closeOwnedTabs = false, googleBlocked = false, detectedUsername) => {
    // Optional fields only when they mean something; report() drops anything else for publish jobs.
    await report(current, 'NEEDS_ACTION', { reason, message,
      ...(typeof detectedUsername === 'string' && detectedUsername.trim() ? { detectedUsername: detectedUsername.trim().slice(0, 200) } : {}),
      googleBlocked: task.job.auth.provider === 'google' && googleBlocked === true });
    if (task.job.kind === 'LOGIN_CHECK') {
      await setTask(task.tabId, null);
      // Whatever the outcome, the result is on the web ("Hướng dẫn kết nối" reopens
      // the platform); a leftover test tab only piles up and is no longer tracked.
      await closeLoginCheckTabs(task.tabId, current?.authTabId);
      return false;
    }
    await setTask(task.tabId, { ...current, phase: 'waitingAuth', waitingSince: Date.now(), deadline: Date.now() + WAIT_USER_MS });
    await focusTab(current.authTabId ?? task.tabId);
    tickSoon();
    return false;
  };
  try {
    while (Date.now() < current.authDeadline) {
      current = (await getTasks())[task.tabId];
      if (!current || current.phase !== 'authenticating') return false;
      const tabId = current.authTabId ?? task.tabId;
      let result;
      let documentId;
      try { [{ result, documentId }] = await withDeadline(chrome.scripting.executeScript({ target: { tabId }, func: accountAuthStep, args: [{ job: { ...task.job, authIdentityVerified: current.googleIdentityVerified === true } }], injectImmediately: true }), AUTH_PROBE_TIMEOUT_MS); }
      catch (error) {
        if (error.message === 'AUTH_STEP_TIMEOUT') {
          // A page that is still loading cannot answer yet (a slow site behind a proxy took
          // longer than one probe after opening the profile page): wait for it within the
          // sign-in deadline. Only a loaded page that stays silent twice is stuck.
          let loading;
          try { loading = (await chrome.tabs.get(tabId)).status === 'loading'; }
          catch { return stop('Tab xác thực đã đóng hoặc không còn truy cập được. Chưa xác nhận đúng hồ sơ.'); }
          const silent = loading ? 0 : (current.authSilentProbes ?? 0) + 1;
          if (silent >= 2) return stop(`Trang đã tải nhưng không phản hồi kiểm tra sau 2 lần ${AUTH_PROBE_TIMEOUT_MS / 1000} giây. Đã dừng lượt này để tiếp tục các nền tảng khác.`);
          current = { ...current, authSilentProbes: silent, authSlowLoad: current.authSlowLoad || loading };
          await setTask(task.tabId, current);
          continue;
        }
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
      // Only consecutive silent probes of a loaded page count as stuck.
      if (current.authSilentProbes) { current = { ...current, authSilentProbes: 0 }; await setTask(task.tabId, current); }
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
      // A step that crashed in the page returns nothing; treat it like an
      // unrecognized page instead of waiting silently for the whole deadline.
      const unrecognized = result?.state === 'unknown' || !result?.state;
      const profileUrl = task.job.auth.profileUrl;
      let profileOrigin = '';
      try { profileOrigin = profileUrl ? new URL(profileUrl).origin : ''; } catch { /* invalid URL: skip */ }
      const profileUsable = Boolean(profileOrigin) && [task.job.targetOrigin, ...(task.job.auth.allowedOrigins ?? [])].includes(profileOrigin);
      // The account was just proved on its own profile page; the composer page shows no
      // account marker (that is why the profile page was needed), so it does not re-prove it.
      if (unrecognized && task.job.kind !== 'LOGIN_CHECK' && current.authReturning && current.authByProfile && tabId === task.tabId) {
        await setTask(task.tabId, { ...current, phase: 'loading', authVerified: true, deadline: Date.now() + LOAD_TIMEOUT_MS });
        return true;
      }
      if (unrecognized) {
        if (task.job.kind === 'LOGIN_CHECK' && !current.authActivated) {
          // Several SPAs defer account hydration until their tab becomes visible.
          // Activate this owned test tab once before deciding the form is absent.
          current = { ...current, authActivated: true, authUnknownSince: null };
          await setTask(task.tabId, current);
          await focusTab(tabId);
          await new Promise(resolve => setTimeout(resolve, 1500));
          continue;
        }
        // Open the configured profile page once: the owner-only controls there
        // identify the account on sites without a known account marker. Publish
        // jobs do this too, or they waited out the whole sign-in deadline.
        if (profileUsable && !current.authProfileVisited && current.authUnknownSince && Date.now() - current.authUnknownSince > PROFILE_CHECK_AFTER_MS) {
          current = { ...current, authProfileVisited: true, authUnknownSince: null };
          await setTask(task.tabId, current);
          try { await chrome.tabs.update(tabId, { url: profileUrl }); } catch { /* closed: reported on the next round */ }
          await new Promise(resolve => setTimeout(resolve, 2_000));
          continue;
        }
        if (task.job.kind === 'LOGIN_CHECK' && current.authUnknownSince && Date.now() - current.authUnknownSince > 8_000) return stop('Trang đã tải nhưng chưa nhận diện được form đăng nhập hoặc đúng tài khoản. Cần cập nhật luồng của nền tảng này.');
        if (!current.authUnknownSince) { current = { ...current, authUnknownSince: Date.now() }; await setTask(task.tabId, current); }
      } else if (current.authUnknownSince) { current = { ...current, authUnknownSince: null }; await setTask(task.tabId, current); }
      if (result?.state === 'cloudflare') {
        if (!current.authCloudflareSince) {
          current = { ...current, authCloudflareSince: Date.now() };
          await setTask(task.tabId, current);
          await focusTab(tabId);
        } else if (Date.now() - current.authCloudflareSince > CLOUDFLARE_WAIT_MS) return stop(result.message);
        await new Promise(resolve => setTimeout(resolve, 750));
        continue;
      }
      if (result?.state === 'noGoogle') {
        if (!current.authNoGoogleSince) { current = { ...current, authNoGoogleSince: Date.now() }; await setTask(task.tabId, current); }
        else if (Date.now() - current.authNoGoogleSince > NO_GOOGLE_GRACE_MS) return stop(result.message);
      } else if (current.authNoGoogleSince) { current = { ...current, authNoGoogleSince: null }; await setTask(task.tabId, current); }
      if (result?.state === 'authenticated') {
        if (task.job.kind === 'LOGIN_CHECK') {
          await report(current, 'AUTHENTICATED', { message: 'Đã xác nhận phiên đăng nhập. Chưa kiểm tra quyền đăng bài.', detectedUsername: result.detectedUsername });
          await setTask(task.tabId, null);
          await closeLoginCheckTabs(task.tabId, current.authTabId);
          return false;
        }
        if (tabId !== task.tabId || !current.authReturning) {
          if (tabId !== task.tabId) { try { await chrome.tabs.remove(tabId); } catch { /* popup closed */ } }
          // The destination creates a new menu after navigation. Only this
          // harmless menu action may repeat; never reset password/TOTP attempts.
          const { accountMenu: _previousMenu, ...authSteps } = current.authSteps ?? {};
          current = { ...current, authTabId: null, authReturning: true, authSteps, authSourceDocumentId: tabId === task.tabId ? documentId : null,
            authByProfile: tabId === task.tabId && profileUsable && current.authProfileVisited === true };
          await setTask(task.tabId, current);
          await chrome.tabs.update(task.tabId, { url: task.job.openUrl });
        } else {
          await setTask(task.tabId, { ...current, phase: 'loading', authVerified: true, deadline: Date.now() + LOAD_TIMEOUT_MS });
          return true;
        }
      } else if (result?.state === 'mismatch') {
        const detected = String(result.detectedUsername ?? '').trim().slice(0, 80);
        return stop(`Chrome đang đăng nhập tài khoản khác${detected ? ` (@${detected.replace(/^@/, '')})` : ''}, không phải tài khoản đã cấu hình${task.job.auth.expectedUsername ? ` (@${String(task.job.auth.expectedUsername).replace(/^@/, '')})` : ''}. Đúng là tài khoản cần dùng thì sửa Username và URL hồ sơ ở Phiên Chrome / 2FA; chưa điền hoặc đăng bài.`, 'ACCOUNT_MISMATCH', false, false, result.detectedUsername);
      } else if (result?.state === 'challenge') {
        return stop(result.message, 'AUTH_REQUIRED', false, result.googleBlocked === true);
      } else if (['identifier', 'password', 'totp', 'google', 'chooser', 'alternate', 'totpChoice', 'openLogin', 'sso', 'accountMenu', 'usePassword'].includes(result?.state)) {
        if (!task.job.auth.autoLogin && result.state !== 'accountMenu') return stop('Chưa nhận diện được phiên sẵn có và tài khoản này chưa bật tự đăng nhập hoặc còn thiếu thông tin xác thực.');
        // A Google sign-in step: one flow at a time per Chrome (check and claim without an await between).
        if (task.job.auth.provider === 'google' && result.state !== 'accountMenu') {
          if ([...googleSignIns].some(jobId => jobId !== task.job.jobId)) { await new Promise(resolve => setTimeout(resolve, 750)); continue; }
          googleSignIns.add(task.job.jobId);
        }
        const attempted = current.authSteps?.[result.state];
        if (attempted && Date.now() - attempted > 15_000) return stop(result.state === 'accountMenu'
          ? 'Trang đã đăng nhập nhưng tiện ích chưa mở được menu để xác nhận đúng hồ sơ. Chưa thử lại mật khẩu.'
          : `Bước đăng nhập chưa được chấp nhận (${result.state} tại ${new URL(result.url).origin}${new URL(result.url).pathname}); không tự thử lặp mật khẩu hoặc mã TOTP.`);
        if (!attempted) {
          current = { ...current, authSteps: { ...current.authSteps, [result.state]: Date.now() } };
          await setTask(task.tabId, current); // reserve before obtaining a secret
          if (VISIBLE_AUTH_STEPS.includes(result.state)) {
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
        && !(unrecognized && profileUsable && !current.authProfileVisited)
        && !Object.keys(current.authSteps ?? {}).some(step => step !== 'accountMenu')) {
        // Only use the configured login URL before authentication starts. SSO
        // callbacks can briefly be blank; navigating here would cancel them.
        current = { ...current, authLoginOpened: true };
        await setTask(task.tabId, current);
        await chrome.tabs.update(task.tabId, { url: task.job.auth.loginUrl });
      }
      await new Promise(resolve => setTimeout(resolve, 750));
    }
    const latest = (await getTasks())[task.tabId] ?? current;
    if (latest?.authSlowLoad) return stop('Trang tải quá chậm nên hết giờ mà chưa xác nhận được tài khoản. Kiểm tra mạng / proxy của Chrome này rồi bấm Giao lại cho tiện ích.');
    return stop('Chưa xác nhận được đúng tài khoản sau đăng nhập. Kiểm tra username/URL hồ sơ hoặc CSS nhận diện trong cấu hình trên web.');
  } finally {
    authenticating.delete(task.job.jobId);
    // A flow deferred behind this Google sign-in is picked up by the next sweep.
    if (googleSignIns.delete(task.job.jobId) && task.job.kind !== 'LOGIN_CHECK') tickSoon();
    if (task.job.kind === 'LOGIN_CHECK' && !(await getTasks())[task.tabId]) void tick();
  }
}

/** The job as the page should see it: with AI selectors kept for this tab. */
function effectiveJob(task) {
  if (!task.uiOverride?.recipe) return task.job;
  // Unapproved AI selectors only pre-fill; the operator clicks Post.
  return { ...task.job, recipe: task.uiOverride.recipe, autoSubmit: task.job.autoSubmit && task.uiOverride.approved === true };
}

async function fill(task) {
  if (task.job.kind === 'LOGIN_CHECK') throw new Error('Login checks cannot publish');
  if (filling.has(task.job.jobId)) return;
  filling.add(task.job.jobId);
  const active = { ...task, phase: 'filling', deadline: Date.now() + LOAD_TIMEOUT_MS };
  await setTask(task.tabId, active);
  let result;
  let attachments;
  try {
    if (task.job.auth) {
      const identity = await verifyOwnIdentity(task);
      if (identity?.state !== 'authenticated') {
        await report(task, 'NEEDS_ACTION', { reason: identity?.state === 'mismatch' ? 'ACCOUNT_MISMATCH' : 'AUTH_REQUIRED', message: 'Phiên thay đổi trước khi điền bài. Kiểm tra đúng tài khoản trong hồ sơ Chrome.' });
        filling.delete(task.job.jobId);
        await setTask(task.tabId, { ...task, phase: 'waitingAuth', waitingSince: Date.now(), deadline: Date.now() + WAIT_USER_MS });
        tickSoon();
        return;
      }
      task = { ...task, job: { ...task.job, verifiedSessionUsername: identity.detectedUsername || task.job.auth.expectedUsername } };
    }
    if (task.job.recipe.requiredMedia) {
      if (task.job.media?.length !== 1 || task.job.media[0].sizeBytes > 20 * 1024 * 1024) {
        result = { status: 'mediaRequired', message: 'Đính kèm đúng một file phù hợp, tối đa 20 MiB, cho bài trên web trước khi chạy.' };
      } else {
        try { attachments = [await api(`tasks/${task.job.jobId}/media/${task.job.media[0].id}`, undefined, 'GET')]; }
        catch (error) { result = { status: 'mediaRequired', message: `Không tải được file đính kèm: ${error.message}` }; }
      }
    } else if (task.job.recipe.optionalMedia && task.job.media?.length) {
      // The post was planned with an image: never post it silently without one.
      if (task.job.media[0].sizeBytes > 20 * 1024 * 1024) result = { status: 'mediaRequired', message: 'Ảnh của bài lớn hơn 20 MiB; thay ảnh nhỏ hơn trên web rồi chạy lại.' };
      else {
        try { attachments = [await api(`tasks/${task.job.jobId}/media/${task.job.media[0].id}`, undefined, 'GET')]; }
        catch (error) { result = { status: 'mediaRequired', message: `Không tải được ảnh của bài: ${error.message}` }; }
      }
    }
    if (!result && task.job.recipe.engine === 'discourse' && task.job.autoSubmit && !task.uiOverride) {
      [{ result }] = await chrome.scripting.executeScript({ target: { tabId: task.tabId }, func: submitDiscoursePost, args: [task.job], injectImmediately: true });
      if (result?.status === 'fallback') result = null;
    }
    if (!result) [{ result }] = await chrome.scripting.executeScript({ target: { tabId: task.tabId }, func: task.job.recipe.workflow === 'social' ? fillSocialAndSubmit : fillAndSubmit,
      args: [runnerJob(task, attachments)], injectImmediately: true });
  } catch (error) {
    result = { status: 'uncertain', message: `Không xác nhận được thao tác trong tab: ${error.message ?? error}` };
  }
  // Outside the try: a recovery problem must never look like a possible submit.
  if (result?.status === 'needsForm') result = await formFill(task, result, attachments);
  if (result?.missing?.length && task.job.uiRecovery?.enabled && !task.submittedAt && ['notReady', 'filled'].includes(result.status)) {
    result = await recoverUi(task, result, attachments) ?? result;
    // Keep the selectors used in this tab for a later "continue" from the web.
    const stored = (await getTasks())[task.tabId];
    if (stored) task = { ...task, uiHintRounds: stored.uiHintRounds, uiOverride: stored.uiOverride };
    if (result?.status === 'needsForm') result = await formFill(task, result, attachments);
  }
  if (finishing.has(task.job.jobId) || !(await getTasks())[task.tabId]) return;
  // Stored after the form-fill rounds (and kept for a later "continue" from the web).
  task = { ...task, formFillRounds: (await getTasks())[task.tabId]?.formFillRounds ?? task.formFillRounds };
  const now = Date.now();
  const known = ['published', 'moderation', 'restricted', 'submitted', 'captcha', 'uncertain', 'rejected', 'filled', 'draft', 'tooLong', 'login', 'notReady', 'contentMismatch', 'mediaRequired', 'unavailable'];
  // No (or an unknown) answer from the tab: it may have got as far as Post, so never call it "nothing sent".
  if (!known.includes(result?.status)) result = { status: 'uncertain', message: result?.message ?? 'Không nhận được kết quả rõ ràng từ tab. Kiểm tra tab và bài trên nền tảng trước khi thử lại.' };
  switch (result.status) {
    case 'published':
      await published(task, result.url);
      return;
    case 'moderation':
      await finishReport(task, 'NEEDS_ACTION', { reason: 'MODERATION_PENDING', message: result.message });
      return;
    case 'restricted':
      await finishReport(task, 'FAILED', { reason: 'PERMISSION_REQUIRED', message: result.message }, true);
      return;
    case 'submitted':
      await setTask(task.tabId, { ...task, beforeUrls: result.beforeUrls ?? [], phase: 'submitted', submittedAt: now, deadline: now + SUBMIT_CONFIRM_MS });
      if (task.job.recipe.workflow === 'social') void checkPublished((await getTasks())[task.tabId]);
      void watchSubmitted(task.tabId, task.job.jobId);
      return;
    case 'tooLong':
      // Nothing was typed and the fix is on the web (a shorter version): no tab to keep.
      await finishReport(task, 'NEEDS_ACTION', { reason: 'WAITING_USER', message: result.message }, true);
      return;
    case 'captcha':
    case 'uncertain':
    case 'rejected':
    case 'filled':
    case 'draft': {
      const captcha = result.status === 'captcha';
      const waitingReason = captcha ? 'CAPTCHA_REQUIRED' : ['filled', 'draft'].includes(result.status) ? 'WAITING_USER' : result.status === 'rejected' ? 'SUBMIT_REJECTED' : 'SUBMIT_UNCONFIRMED';
      await report(task, 'NEEDS_ACTION', {
        reason: waitingReason,
        message: result.message ?? (captcha ? 'Hoàn thành CAPTCHA rồi bấm Đăng trong tab vừa mở' : 'Kiểm tra nội dung rồi bấm Đăng trong tab vừa mở'),
      });
      await setTask(task.tabId, { ...task, beforeUrls: result.beforeUrls ?? [], phase: 'waitingUser', waitingMessage: result.message, waitingReason,
        waitingSince: now, deadline: now + WAIT_USER_MS });
      await focusTab(task.tabId);
      tickSoon();
      return;
    }
    case 'mediaRequired':
    case 'unavailable':
      await finishReport(task, 'FAILED', { reason: result.status === 'mediaRequired' ? 'MEDIA_REQUIRED' : 'PLATFORM_UNAVAILABLE', message: result.message }, true);
      return;
    default: {
      // Nothing was sent. The tab stays open for the operator, without holding a flow.
      const reason = { login: 'LOGIN_REQUIRED', contentMismatch: 'CONTENT_MISMATCH', notReady: 'EDITOR_NOT_FOUND' }[result.status];
      const message = result.message ?? (reason === 'EDITOR_NOT_FOUND' ? 'Không thấy khung soạn bài trên trang.' : undefined);
      await report(task, 'FAILED', { reason, message });
      await setTask(task.tabId, { ...task, phase: 'waitingUser', reportedOutcome: 'FAILED', waitingReason: reason, waitingMessage: message,
        waitingSince: now, deadline: now + WAIT_USER_MS });
      await focusTab(task.tabId);
      tickSoon();
    }
  }
}

/** The job handed to the page runner, with this tab's AI selectors and form-fill round count. */
function runnerJob(task, attachments, extra = {}) {
  return { ...effectiveJob(task), formFillRounds: task.formFillRounds ?? 0, ...(attachments ? { attachments } : {}), ...extra };
}

/** Only actions on controls collected in this tab, of a kind that fits the control. */
function formActions(actions, controls) {
  if (!Array.isArray(actions) || actions.length > controls.length) return [];
  const byIndex = new Map(controls.map(control => [control.index, control]));
  const valid = actions.filter(action => {
    const control = byIndex.get(action?.index);
    return control && action.selector === control.selector && FORM_ACTIONS[control.kind]?.includes(action.action)
      && (['check', 'uncheck'].includes(action.action) || (typeof action.value === 'string' && action.value.trim() && action.value.length <= 300));
  });
  // One unusable action means the answer is not trustworthy as a whole.
  return valid.length === actions.length ? valid.map(({ index, selector, action, value }) => ({ index, selector, action, ...(typeof value === 'string' ? { value } : {}) })) : [];
}

/**
 * Required controls the recipe does not know (a community, a language, a rules
 * checkbox…): describe them to the backend AI, poll for its answer, apply the
 * actions in the tab, then run the composer once more to verify the form and
 * the approved text and submit when allowed. At most MAX_FORM_FILL_ROUNDS
 * requests per task. Unlike unapproved ui-hint selectors, form-fill actions do
 * not turn automatic submit off: the runner re-verifies everything first.
 * Returns the fill result to act on.
 */
async function formFill(task, result, attachments) {
  const fallback = { status: 'filled', message: result.message ?? 'Còn mục bắt buộc chưa điền. Điền trong tab rồi bấm Đăng.', beforeUrls: result.beforeUrls };
  const unsure = { status: 'filled', message: FORM_FILL_UNSURE, beforeUrls: result.beforeUrls };
  if (task.job.recipe.workflow !== 'social') return fallback;
  let current = result;
  while (current?.status === 'needsForm') {
    const saved = (await getTasks())[task.tabId];
    if (!saved || saved.submittedAt) return unsure;
    const rounds = saved.formFillRounds ?? 0;
    if (!task.job.formFill?.enabled || rounds >= MAX_FORM_FILL_ROUNDS) return rounds ? unsure : fallback;
    const recipe = effectiveJob({ ...task, uiOverride: saved.uiOverride }).recipe;
    let page;
    try {
      [{ result: page }] = await chrome.scripting.executeScript({ target: { tabId: task.tabId }, func: collectFormControls,
        args: [{ recipe: { titleSelectors: recipe.titleSelectors ?? [], bodySelectors: recipe.bodySelectors ?? [] } }] });
    } catch { return rounds ? unsure : fallback; }
    const controls = page?.controls ?? [];
    if (!controls.length) return rounds ? unsure : fallback;
    await setTask(task.tabId, { ...saved, formFillRounds: rounds + 1, deadline: Date.now() + FORM_FILL_WAIT_MS + LOAD_TIMEOUT_MS });
    let answer;
    try {
      // Each request stays short (MV3 stops a worker on a fetch over ~30 s): ask, then poll.
      answer = await api(`tasks/${task.job.jobId}/form-fill`, { url: page.url, controls });
      const until = Date.now() + FORM_FILL_WAIT_MS;
      while (answer?.status === 'RUNNING' && Date.now() < until) {
        await new Promise(resolve => setTimeout(resolve, FORM_FILL_POLL_MS));
        answer = await api(`tasks/${task.job.jobId}/form-fill/${encodeURIComponent(answer.hintId)}`, undefined, 'GET');
      }
    } catch (error) {
      // 404: form-fill is turned off on the backend. Behave as without it.
      return error.status === 404 && !rounds ? fallback : unsure;
    }
    // READY without actions (e.g. LOW_CONFIDENCE): the AI is not sure, the operator decides.
    const actions = answer?.status === 'READY' ? formActions(answer.actions, controls) : [];
    if (!actions.length) return unsure;
    let applied;
    try {
      [{ result: applied }] = await chrome.scripting.executeScript({ target: { tabId: task.tabId }, func: applyFormActions, args: [{ actions }] });
    } catch { return unsure; }
    if (!applied?.results?.length || applied.results.some(item => !item.ok)) return unsure;
    const latest = (await getTasks())[task.tabId];
    if (!latest || latest.submittedAt) return unsure;
    await setTask(task.tabId, { ...latest, deadline: Date.now() + LOAD_TIMEOUT_MS });
    try {
      [{ result: current }] = await chrome.scripting.executeScript({ target: { tabId: task.tabId }, func: fillSocialAndSubmit,
        args: [runnerJob({ ...task, uiOverride: latest.uiOverride, formFillRounds: rounds + 1 }, attachments, { formFillResume: true })], injectImmediately: true });
    } catch (error) {
      // This run may have clicked Post: never treat it as "nothing sent".
      return { status: 'uncertain', message: `Không xác nhận được thao tác trong tab: ${error.message ?? error}` };
    }
  }
  return current;
}

/** Approved-or-suggested selectors in front of the recipe's own ones (copy). */
function recipeWithHints(recipe, picked) {
  const of = field => picked.filter(([name]) => name === field).map(([, hint]) => hint.selector);
  const title = recipe.titleSelectors?.length ? of('title') : [];
  const body = of('body');
  const merged = {
    ...recipe,
    uiOverride: true,
    readySelectors: [...new Set([...title, ...body, ...(recipe.readySelectors ?? [])])],
    titleSelectors: [...new Set([...title, ...(recipe.titleSelectors ?? [])])],
    bodySelectors: [...new Set([...body, ...(recipe.bodySelectors ?? [])])],
    submitSelectors: [...new Set([...of('submit'), ...(recipe.submitSelectors ?? [])])],
  };
  const opener = of('opener');
  if (opener.length) merged.openerSelectors = [...new Set([...opener, ...(recipe.openerSelectors ?? [])])];
  return merged;
}

/**
 * Ask the backend AI which visible element is the missing control, then fill
 * once more with it. Returns a new fill result, or null to keep the original.
 * Nothing is clicked with an unapproved selector: autoSubmit is turned off,
 * so the operator reviews the pre-filled post and clicks Post.
 */
async function recoverUi(task, result, attachments) {
  try {
    // `task` is the fill's own copy (it may carry the verified username); the
    // stored copy holds the hint rounds and selectors already used in this tab.
    const stored = () => getTasks().then(tasks => tasks[task.tabId]);
    const saved = await stored();
    if (!saved || saved.submittedAt) return null;
    const rounds = saved.uiHintRounds ?? 0;
    const previous = saved.uiOverride?.fields ?? [];
    if (rounds >= MAX_UI_HINT_ROUNDS || (rounds === 1 && !(previous.length && previous.every(field => field === 'opener')))) return null;
    const missing = [...new Set(result.missing)].filter(field => UI_HINT_FIELDS.includes(field));
    if (!missing.length) return null;
    const [{ result: page }] = await chrome.scripting.executeScript({ target: { tabId: task.tabId }, func: collectUiCandidates, args: [{ missing }] });
    if (!page?.candidates?.length) return null;
    await setTask(task.tabId, { ...saved, uiHintRounds: rounds + 1, deadline: Date.now() + UI_HINT_WAIT_MS + LOAD_TIMEOUT_MS });
    // Each request stays short (MV3 stops a worker on a fetch over ~30 s): ask, then poll.
    let hint = await api(`tasks/${task.job.jobId}/ui-hint`, { missing, url: page.url, candidates: page.candidates });
    const until = Date.now() + UI_HINT_WAIT_MS;
    while (hint?.status === 'RUNNING' && Date.now() < until) {
      await new Promise(resolve => setTimeout(resolve, UI_HINT_POLL_MS));
      hint = await api(`tasks/${task.job.jobId}/ui-hint/${hint.hintId}`, undefined, 'GET');
    }
    if (hint?.status !== 'READY') return null;
    const picked = Object.entries(hint.selectors ?? {}).filter(([field, value]) => missing.includes(field) && typeof value?.selector === 'string');
    if (!picked.length) return null;
    // Only the Post button is unknown: the post is already in the editor. Keep
    // the suggestion for review instead of filling again.
    if (missing.every(field => field === 'submit')) {
      return { ...result, message: `${result.message ?? ''} AI đã đề xuất nút Đăng mới; kiểm tra rồi bấm Đăng, và duyệt gợi ý trên web để lần sau tự đăng.`.trim() };
    }
    const [{ result: verified }] = await chrome.scripting.executeScript({ target: { tabId: task.tabId }, func: verifyUiSelectors,
      args: [{ selectors: Object.fromEntries(picked.map(([field, value]) => [field, value.selector])) }] });
    const usable = picked.filter(([field]) => verified?.[field]);
    if (!usable.length) return null;
    const latest = await stored();
    if (!latest || latest.submittedAt) return null;
    const approved = usable.every(([, value]) => value.approved === true) && (latest.uiOverride ? latest.uiOverride.approved === true : true);
    const uiOverride = { recipe: recipeWithHints(effectiveJob({ ...task, uiOverride: latest.uiOverride }).recipe, usable), approved, fields: usable.map(([field]) => field) };
    await setTask(task.tabId, { ...latest, uiHintRounds: rounds + 1, uiOverride, deadline: Date.now() + LOAD_TIMEOUT_MS });
    const current = { ...task, uiHintRounds: rounds + 1, uiOverride };
    const job = effectiveJob(current);
    const [{ result: retried }] = await chrome.scripting.executeScript({ target: { tabId: task.tabId }, func: job.recipe.workflow === 'social' ? fillSocialAndSubmit : fillAndSubmit,
      args: [runnerJob({ ...current, formFillRounds: latest.formFillRounds }, attachments)], injectImmediately: true });
    let outcome = retried;
    // The opener worked; now the composer fields themselves may need a hint.
    if (outcome?.missing?.length && usable.every(([field]) => field === 'opener')) outcome = await recoverUi(current, outcome, attachments) ?? outcome;
    if (outcome?.status === 'filled' && !approved) {
      return { ...outcome, message: 'AI đã tìm ô / nút mới sau khi giao diện đổi và điền sẵn bài. Kiểm tra rồi bấm Đăng; duyệt gợi ý trên web để lần sau tự đăng.' };
    }
    return outcome;
  } catch {
    return null;
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
  await finishReport(task, 'PUBLISHED', { url }, true);
}

async function finishReport(task, outcome, extra, closeTab = false) {
  if (finishing.has(task.job.jobId)) return;
  finishing.add(task.job.jobId);
  try {
    closeTab = closeTab || outcome === 'PUBLISHED' || extra.reason === 'MODERATION_PENDING';
    // Retain the verified receipt across transient backend outages. A retry of
    // this phase only reports the result; it never fills or submits again.
    await setTask(task.tabId, { ...task, phase: 'reporting', pendingReport: { outcome, extra, closeTab }, reportingSince: task.reportingSince ?? Date.now() });
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
    if (task.job.kind !== 'LOGIN_CHECK') tickSoon();
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
  if (concluding.has(task.job.jobId)) return;
  concluding.add(task.job.jobId);
  try {
    let errorText = null;
    try {
      if (await checkModeration(task)) return;
      [{ result: errorText }] = await chrome.scripting.executeScript({ target: { tabId: task.tabId }, func: readErrors, args: [task.job.recipe] });
    } catch { /* page still navigating */ }
    if (isTransientNotice(errorText)) errorText = null;
    const current = (await getTasks())[task.tabId];
    if (!current || current.job.jobId !== task.job.jobId || current.phase !== 'submitted') return;
    if (errorText) {
      // A banner can flash while the editor saves. Only a banner that stays is a rejection.
      if (current.errorSeen?.text !== errorText) {
        await setTask(task.tabId, { ...current, errorSeen: { text: errorText, at: now } });
        return;
      }
      if (now - current.errorSeen.at < ERROR_CONFIRM_MS) return;
    } else if (now < current.deadline) {
      if (current.errorSeen) await setTask(task.tabId, { ...current, errorSeen: null });
      return;
    } else if (await startProfileVerification(current)) return;
    await concludeUnconfirmed(current, errorText
      ? { reason: 'SUBMIT_REJECTED', message: errorText }
      : { reason: 'SUBMIT_UNCONFIRMED', message: 'Đã bấm Đăng nhưng chưa thấy bài mới sau 3 phút. Kiểm tra tab hoặc trang cá nhân trên nền tảng rồi bấm Đã đăng.' });
  } finally {
    concluding.delete(task.job.jobId);
  }
}

// Possibly posted, possibly rejected: never resubmit, hand it to the operator.
async function concludeUnconfirmed(task, extra) {
  const now = Date.now();
  await report(task, 'NEEDS_ACTION', extra);
  await setTask(task.tabId, { ...task, phase: 'waitingUser', waitingReason: extra.reason, waitingMessage: extra.message,
    waitingSince: now, deadline: now + WAIT_USER_MS });
  await focusTab(task.tabId);
  tickSoon();
}

/** The account's own posts page, when the Chrome session settings name it on this site. */
function profileCheckUrl(job) {
  if (job.recipe.workflow !== 'social' || !job.auth?.profileUrl) return null;
  try {
    const url = new URL(job.auth.profileUrl);
    if (url.origin !== job.targetOrigin || url.username || url.password) return null;
    if (job.recipe.engine === 'quora' && /^\/profile\/[^/]+\/?$/.test(url.pathname)) url.pathname = `${url.pathname.replace(/\/$/, '')}/posts`;
    url.hash = '';
    return url.toString();
  } catch { return null; }
}

// Read-only fallback: open the account's own profile in the same tab and look
// for the new post there. The composer was already submitted; nothing is sent.
async function startProfileVerification(task) {
  const url = profileCheckUrl(task.job);
  if (!url || task.profileChecked) return false;
  const now = Date.now();
  await setTask(task.tabId, { ...task, phase: 'verifying', profileChecked: true, deadline: now + PROFILE_VERIFY_MS });
  try { await chrome.tabs.update(task.tabId, { url }); } catch { /* tab closed: onRemoved reports it */ }
  void watchSubmitted(task.tabId, task.job.jobId);
  return true;
}

async function checkVerifying(task) {
  if (Date.now() < task.deadline || concluding.has(task.job.jobId)) return;
  concluding.add(task.job.jobId);
  try {
    const current = (await getTasks())[task.tabId];
    if (current?.phase !== 'verifying' || current.job.jobId !== task.job.jobId) return;
    await concludeUnconfirmed(current, { reason: 'SUBMIT_UNCONFIRMED',
      message: 'Đã bấm Đăng nhưng không thấy bài mới, kể cả trên trang cá nhân. Kiểm tra nền tảng rồi bấm Đã đăng hoặc Giao lại cho tiện ích.' });
  } finally {
    concluding.delete(task.job.jobId);
  }
}

// Polls a submitted tab every few seconds instead of waiting for the 30-second alarm.
async function watchSubmitted(tabId, jobId) {
  if (watching.has(jobId)) return;
  watching.add(jobId);
  try {
    for (;;) {
      await new Promise(resolve => { const timer = setTimeout(resolve, SUBMIT_POLL_MS); timer?.unref?.(); });
      const task = (await getTasks())[tabId];
      if (!task || task.job.jobId !== jobId || !['submitted', 'verifying'].includes(task.phase)) return;
      if (await checkPublished(task)) return;
      if (task.phase === 'submitted') await checkSubmitted(task);
      else await checkVerifying(task);
    }
  } catch { /* the alarm sweep keeps checking */ }
  finally { watching.delete(jobId); }
}

/** When a waiting tab is released; null for a task stored without any deadline. */
function waitingUntil(task) {
  const limits = [task.deadline, task.waitingSince != null ? task.waitingSince + WAIT_USER_MS : undefined].filter(Number.isFinite);
  return limits.length ? Math.min(...limits) : null;
}

/** The tab still shows this job's site (the operator may have reused it for something else). */
async function ownsTab(task, tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    const origin = new URL(tab.url || tab.pendingUrl).origin;
    return [task.job.targetOrigin, ...(task.job.auth?.allowedOrigins ?? []), ...(task.job.auth?.provider === 'google' ? ['https://accounts.google.com'] : [])].includes(origin);
  } catch { return false; }
}

/**
 * Stop tracking a task whose time is up: forget it (so its site is no longer
 * excluded from claims), close its tab and sign-in popup if they are still
 * ours, and look for the next post. The job keeps its last report on the web.
 */
async function releaseTask(task, message, closeTab = true) {
  const current = (await getTasks())[task.tabId];
  if (!current || current.job.jobId !== task.job.jobId) return;
  // Forget first: closing the tab must not report it a second time (onRemoved).
  await setTask(task.tabId, null);
  await log({ jobId: task.job.jobId, account: task.job.account.name, platform: task.job.account.platform, outcome: 'RELEASED', message });
  if (closeTab) {
    for (const tabId of new Set([task.tabId, current.authTabId].filter(id => id !== undefined && id !== null))) {
      if (await ownsTab(task, tabId)) { try { await chrome.tabs.remove(tabId); } catch { /* already closed */ } }
    }
  }
  tickSoon();
}

async function sweep() {
  const now = Date.now();
  for (const task of Object.values(await getTasks())) {
    if (task.phase === 'reporting' && task.pendingReport) {
      // A verified receipt is kept until the backend has it. Any other report
      // that still cannot be delivered after the waiting window is dropped.
      const receipt = task.pendingReport.outcome === 'PUBLISHED' || task.pendingReport.extra?.reason === 'MODERATION_PENDING';
      if (!receipt && now - (task.reportingSince ?? now) >= WAIT_USER_MS) {
        await releaseTask(task, 'Không báo được kết quả về hệ thống sau 10 phút; đã ngừng theo dõi tab này.', task.pendingReport.closeTab);
        continue;
      }
      await finishReport(task, task.pendingReport.outcome, task.pendingReport.extra, task.pendingReport.closeTab);
      continue;
    }
    if (isWaiting(task) && waitingUntil(task) === null) {
      // Stored by an older version without a deadline: start the window now.
      await setTask(task.tabId, { ...task, waitingSince: now, deadline: now + WAIT_USER_MS });
      continue;
    }
    if (task.phase === 'authenticating') {
      if (!authenticating.has(task.job.jobId)) void authenticateTask(task).then(async ready => { if (ready) await tryFill((await getTasks())[task.tabId]); });
      continue;
    }
    if (task.phase === 'waitingAuth') {
      if (now >= waitingUntil(task)) {
        await releaseTask(task, 'Chờ đăng nhập quá 10 phút: đã đóng tab và nhận bài tiếp theo. Bài vẫn ở Cần thao tác trên web.');
        continue;
      }
      if (now - (task.lastIdentityCheck ?? 0) >= 30_000) {
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
    // Checked after the last look for a manually published post.
    if (task.phase === 'waitingUser') {
      if (now >= waitingUntil(task)) await releaseTask(task, 'Tab chờ quá 10 phút: đã đóng tab và nhận bài tiếp theo. Bài vẫn ở Cần thao tác trên web.');
    } else if (task.phase === 'submitted') { await checkSubmitted(task); void watchSubmitted(task.tabId, task.job.jobId); }
    else if (task.phase === 'verifying') await checkVerifying(task);
    else if (task.phase === 'loading') {
      void checkLoading(task);
    } else if (now >= task.deadline && task.phase === 'filling' && !filling.has(task.job.jobId)) {
      await report(task, 'NEEDS_ACTION', { reason: 'SUBMIT_UNCONFIRMED', message: 'Tiện ích khởi động lại khi đang thao tác. Kiểm tra tab và bài đã đăng trước khi thử lại.' });
      await setTask(task.tabId, { ...task, phase: 'waitingUser', waitingReason: 'SUBMIT_UNCONFIRMED', waitingSince: now, deadline: now + WAIT_USER_MS });
    }
  }
}

async function checkLoading(task) {
  await tryFill(task);
  const current = (await getTasks())[task.tabId];
  if (current?.phase === 'loading' && Date.now() >= current.deadline && !probing.has(task.job.jobId)) {
    await finishReport(task, 'FAILED', { reason: 'PAGE_LOAD_FAILED', message: current.probeError ? `Không kiểm tra được form: ${current.probeError}` : 'Trang diễn đàn không tải xong' }, true);
  }
}

let nextJobTimer = null;
// runTick still enforces MAX_ACTIVE_FLOWS, the tab budget, pause and origin
// reservations; this only moves the next poll earlier. Debounced so several
// transitions of one post cause a single extra heartbeat.
function tickSoon() {
  if (nextJobTimer) return;
  nextJobTimer = setTimeout(() => { nextJobTimer = null; void tick(); }, NEXT_JOB_DELAY_MS);
  nextJobTimer?.unref?.();
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
      // Waiting tabs (operator, sign-in, failed post kept open) do not hold a
      // flow; they expire after WAIT_USER_MS. The tab cap is only a safety bound.
      if (tasks.filter(occupiesFlow).length >= MAX_ACTIVE_FLOWS || tasks.length >= MAX_OWNED_TABS) break;
      // Never two flows on one site, and a composer waiting before submission
      // owns this site's draft: a second tab could overwrite it. A submitted
      // post has no draft left to protect.
      const excludeOrigins = [...new Set(tasks.filter(task => !(isWaiting(task) && isPostSubmit(task))).map((task) => task.job.targetOrigin))];
      const { task: job } = await api('claim', { excludeOrigins, supportedEngines: SUPPORTED_ENGINES, authProtocol: 1 });
      if (!job) break;
      // The backend skips these origins before claiming, so a second job for a
      // busy site cannot prevent another platform from starting.
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

const ensureProxy = () => applyProxy().catch(error => chrome.storage.local.set({ lastError: { at: new Date().toISOString(), message: `Không áp dụng được proxy: ${String(error?.message ?? error).slice(0, 200)}` } }));
chrome.runtime.onInstalled.addListener(() => { void ensureProxy(); void startPolling(); });
chrome.runtime.onStartup.addListener(() => { void ensureProxy(); void startPolling(); });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === TICK_ALARM) void startPolling();
});
chrome.storage.onChanged.addListener((changes, area) => {
  // The backend address is the proxy's bypass, so a new pairing re-applies it too.
  if (area === 'local' && (PROXY_STORAGE_KEY in changes || 'apiUrl' in changes)) void ensureProxy();
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
  // Keep a confirmed receipt when the operator closes a tab while offline.
  // The next sweep reports it without submitting a second time.
  if (task.phase === 'reporting') return;
  if (task.phase === 'loading') {
    await report(task, 'FAILED', { reason: 'CANCELLED', message: 'Tab bị đóng trước khi điền nội dung' });
  } else if (task.phase === 'authenticating') {
    await report(task, 'NEEDS_ACTION', { reason: 'AUTH_REQUIRED', message: 'Tab đăng nhập đã đóng trước khi xác nhận đúng tài khoản.' });
  } else if (task.phase === 'submitted' || task.phase === 'filling' || task.phase === 'verifying') {
    await report(task, 'NEEDS_ACTION', { reason: 'SUBMIT_UNCONFIRMED', message: 'Tab bị đóng ngay sau khi bấm Đăng. Kiểm tra diễn đàn.' });
  }
  await setTask(tabId, null);
  if (task.job.kind !== 'LOGIN_CHECK') tickSoon();
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
