// Node-only service-worker regression tests; no real backend or forum is contacted.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const job = {
  jobId: 'job-test', openUrl: 'http://forum.test/new-topic', targetOrigin: 'http://forum.test',
  account: { name: 'Test forum', platform: 'Discourse' },
  recipe: { engine: 'discourse', successUrlPattern: '/t/[^/]+/\\d+' },
};

// Existing cases drive polling by hand; the early next-job poll stays out of
// their way unless a test asks for it.
function setup({ nextJobDelay = 60_000 } = {}) {
  const state ={ ready: true, fills: 0, result: { status: 'filled' }, reports: [], injections: [], openedUrls: [], claims: 0, waiting: false, alarm: null, alarmCreates: 0, jobs: null, claimRequests: [], nextTabId: 0 };
  const area = initial => {
    const data = structuredClone(initial);
    return {
      get: async keys => structuredClone(Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter(k => k in data).map(k => [k, data[k]]))),
      set: async patch => Object.assign(data, structuredClone(patch)),
    };
  };
  const event = () => ({ listeners: [], addListener(fn) { this.listeners.push(fn); } });
  const chrome = {
    storage: { local: area({ apiUrl: 'http://backend.test', token: 'test-only', history: [] }), session: area({}), onChanged: event() },
    permissions: { contains: async () => true, onAdded: event() },
    action: { setBadgeBackgroundColor: async () => {}, setBadgeText: async () => {} },
    tabs: {
      create: async ({ url }) => { state.openedUrls.push(url); return { id: ++state.nextTabId, windowId: 2, status: 'loading' }; },
      update: async (id, options) => { if (options?.active) state.activated = id; if (options?.url) state.openedUrls.push(options.url); return { id, windowId: 2 }; }, remove: async id => { (state.closedTabs ??= []).push(id); },
      get: async id => ({ id, url: state.currentUrl ?? job.openUrl }),
      onUpdated: event(), onRemoved: event(), onCreated: event(),
    },
    windows: { update: async () => {} },
    alarms: {
      get: async () => state.alarm,
      create: async (name, options) => { state.alarmCreates++; state.alarm = { name, ...options }; },
      onAlarm: event(),
    },
    runtime: { onInstalled: event(), onStartup: event(), onMessage: event() },
    scripting: { executeScript: async injection => {
      state.injections.push(injection);
      if (injection.func.name === 'canFillPage') {
        if (state.probeError) throw new Error(state.probeError);
        return [{ result: state.ready }];
      }
      if (injection.func.name === 'fillAndSubmit' || injection.func.name === 'fillSocialAndSubmit') {
        state.fills++;
        if (state.fillResult) return [{ result: await state.fillResult(injection.args[0]) }];
        if (state.result instanceof Error) throw state.result;
        return [{ result: state.result }];
      }
      if (injection.func.name === 'submitDiscoursePost') return [{ result: state.directResult ?? { status: 'fallback' } }];
      if (injection.func.name === 'collectUiCandidates') return [{ result: state.candidates ?? null }];
      if (injection.func.name === 'verifyUiSelectors') return [{ result: state.verified ?? injection.args[0].selectors }];
      if (injection.func.name === 'readModeration') return [{ result: state.moderation ?? null }];
      if (injection.func.name === 'readPublishedPost' || injection.func.name === 'readSocialPublishedPost') return [{ result: state.publishedUrl ?? null }];
      if (injection.func.name === 'readErrors') return [{ result: state.errorText ?? null }];
      if (injection.func.name === 'accountAuthStep') {
        if (state.authError) throw new Error(state.authError);
        const result = typeof state.authResult === 'function' ? state.authResult(injection.args[0]) : state.authResult;
        return [{ result, documentId: state.authDocumentId }];
      }
      return [{ result: null }];
    } },
  };
  const source = fs.readFileSync(path.join(__dirname, '../../browser-extension/background.js'), 'utf8')
    .replace(/^import .* from '\.\/(?:page-actions|social-actions|auth-actions|discourse-session|publish-notice|ui-recovery)\.js';\r?\n/gm, '')
    .replace(/const NEXT_JOB_DELAY_MS = [\d_]+;/, `const NEXT_JOB_DELAY_MS = ${nextJobDelay};`)
    .replace(/const NO_GOOGLE_GRACE_MS = [\d_]+;/, 'const NO_GOOGLE_GRACE_MS = 0;');
  const context = vm.createContext({
    chrome, URL, Date, AbortSignal, setTimeout, clearTimeout,
    canFillPage: function canFillPage() {}, fillAndSubmit: function fillAndSubmit() {}, readErrors: function readErrors() {}, readModeration: function readModeration() {}, readPublishedPost: function readPublishedPost() {},
    fillSocialAndSubmit: function fillSocialAndSubmit() {}, readSocialPublishedPost: function readSocialPublishedPost() {},
    accountAuthStep: function accountAuthStep() {},
    submitDiscoursePost: function submitDiscoursePost() {},
    showPublishNotice: function showPublishNotice() {},
    collectUiCandidates: function collectUiCandidates() {}, verifyUiSelectors: function verifyUiSelectors() {},
    fetch: async (url, options) => {
      if (url.endsWith('/result')) {
        if (state.reportOffline) throw new Error('Backend offline');
        if (state.reportStatus) return { ok: false, status: state.reportStatus, json: async () => ({ success: false, error: { message: 'Job already finished' } }) };
        state.reports.push(JSON.parse(options.body));
      }
      let data = {};
      if (url.includes('/ui-hint')) {
        (state.hintRequests ??= []).push({ url, method: options.method, body: options.body ? JSON.parse(options.body) : null });
        const answer = typeof state.hint === 'function' ? state.hint(state.hintRequests.length) : state.hint;
        if (answer instanceof Error) return { ok: false, status: 404, json: async () => ({ success: false, error: { message: answer.message } }) };
        return { ok: true, json: async () => ({ success: true, data: answer }) };
      }
      if (url.endsWith('/heartbeat')) {
        data = { waiting: state.jobs ? state.jobs.length : state.waiting ? 1 : 0 };
        state.onHeartbeat?.();
      }
      if (url.endsWith('/claim')) {
        state.claims++;
        const request = JSON.parse(options.body);
        state.claimRequests.push(request);
        if (state.jobs) {
          const index = state.jobs.findIndex(item => !(request.excludeOrigins ?? []).includes(item.targetOrigin));
          data = { task: index >= 0 ? state.jobs.splice(index, 1)[0] : null };
        } else data = { task: state.waiting ? job : null };
        state.waiting = false;
      }
      return { ok: true, json: async () => ({ success: true, data }) };
    },
  });
  vm.runInContext(source + '\nglobalThis.worker = { start, sweep, getTasks, tick, tickSoon, ensureAlarm, withDeadline, authenticateTask };', context);
  return { state, chrome, worker: context.worker };
}

test('a page probe that never resolves cannot hold the authentication queue forever', async () => {
  const { worker } = setup();
  await assert.rejects(worker.withDeadline(new Promise(() => {}), 5), /AUTH_STEP_TIMEOUT/);
  assert.equal(await worker.withDeadline(Promise.resolve('ready'), 100), 'ready');
});

test('account menu can reopen after composer navigation without repeating credentials', async () => {
  const { state, worker } = setup();
  let menuAt = -1, menus = 0;
  state.authResult = ({ action }) => {
    if (action === 'accountMenu') { menuAt = state.openedUrls.length; menus++; return { state: 'submitted' }; }
    return { state: menuAt === state.openedUrls.length ? 'authenticated' : 'accountMenu', url: 'http://forum.test/' };
  };
  assert.equal(await worker.authenticateTask({ tabId: 8, job: { ...job, auth: { autoLogin: false } } }), true);
  assert.equal(menus, 2);
  assert.equal(state.reports.length, 0);
  assert.equal(state.injections.some(i => ['password', 'totp'].includes(i.args?.[0]?.action)), false);
});

test('waiting authentication resumes in its existing tab after identity is confirmed', async () => {
  const { state, chrome, worker } = setup();
  state.authResult = { state: 'authenticated', detectedUsername: 'alice' };
  await chrome.storage.session.set({ tasks: { 8: { tabId: 8, job: { ...job, auth: { autoLogin: false } }, phase: 'waitingAuth', deadline: Date.now() + 60000 } } });
  await worker.sweep();
  assert.equal((await worker.getTasks())[8].phase, 'loading');
  assert.equal(state.nextTabId, 0);
  assert.deepEqual(state.openedUrls, [job.openUrl]);
});

test('composer authentication waits for navigation to replace the previous document', async () => {
  const { state, worker } = setup();
  let probes = 0;
  state.authResult = () => {
    state.authDocumentId = ++probes < 3 ? 'old-document' : 'composer-document';
    return { state: 'authenticated', detectedUsername: 'alice' };
  };
  assert.equal(await worker.authenticateTask({ tabId: 8, job: { ...job, auth: { autoLogin: false } } }), true);
  assert.equal(probes, 3);
  assert.deepEqual(state.openedUrls, [job.openUrl]);
  assert.equal((await worker.getTasks())[8].authVerified, true);
});

test('updating restores uncertain submissions without sending them again', async () => {
  const { state, chrome, worker } = setup();
  await chrome.storage.local.set({ updateCheckpoint: { paused: false, tasks: { 8: { tabId: 8, job, phase: 'waitingUser', submittedAt: Date.now(), deadline: Date.now() + 60000 } } } });
  await worker.sweep();
  assert.equal((await worker.getTasks())[8].phase, 'waitingUser');
  assert.equal(state.fills, 0);
  assert.equal((await chrome.storage.local.get('updateCheckpoint')).updateCheckpoint, null);
});

for (const googleBlocked of [false, true]) test(`only a confirmed Google challenge blocks the shared Google queue (${googleBlocked})`, async () => {
  const { state, worker } = setup();
  state.authResult = { state: 'challenge', url: 'https://accounts.google.com/', message: 'Fixture challenge', googleBlocked };
  await worker.authenticateTask({ tabId: 8, job: { ...job, kind: 'LOGIN_CHECK', auth: { provider: 'google', autoLogin: true } } });
  assert.equal(state.reports[0].googleBlocked, googleBlocked);
  assert.equal(state.fills, 0);
});

test('a different logged-in profile is reported with its identity without another login attempt', async () => {
  const { state, worker } = setup();
  state.authResult = { state: 'mismatch', url: 'https://forum.test/', detectedUsername: 'other-profile' };
  await worker.authenticateTask({ tabId: 8, job: { ...job, kind: 'LOGIN_CHECK', auth: { provider: 'password', autoLogin: false } } });
  assert.equal(state.reports[0].detectedUsername, 'other-profile');
  assert.equal(state.reports[0].outcome, 'NEEDS_ACTION');
  assert.equal(state.fills, 0);
});

test('activates a deferred login page once and verifies it without publishing', async () => {
  const { state, worker } = setup();
  state.authResult = () => ({ state: state.activated === 8 ? 'authenticated' : 'unknown', url: 'https://forum.test/' });
  await worker.authenticateTask({ tabId: 8, job: { ...job, kind: 'LOGIN_CHECK', auth: { provider: 'password', autoLogin: false } } });
  assert.equal(state.activated, 8);
  assert.equal(state.reports[0].outcome, 'AUTHENTICATED');
  assert.equal(state.fills, 0);
});

test('SSO callback hydration never redirects an in-progress login back to its start', async () => {
  const { state, worker } = setup();
  let probes = 0;
  state.authResult = () => ({ state: ++probes > 1 ? 'authenticated' : 'unknown', url: 'https://login.vivaldi.net/callback' });
  await worker.authenticateTask({ tabId: 8, authActivated: true, authSteps: { sso: Date.now(), password: Date.now() },
    job: { ...job, kind: 'LOGIN_CHECK', auth: { provider: 'password', autoLogin: true, loginUrl: 'https://social.vivaldi.net/auth/sign_in' } } });
  assert.deepEqual(state.openedUrls, []);
  assert.equal(state.reports[0].outcome, 'AUTHENTICATED');
  assert.equal(state.fills, 0);
});

test('an unconfigured SSO origin releases the queue immediately without logging its URL query', async () => {
  const { state, worker } = setup();
  state.authError = 'Cannot access contents of the page';
  state.currentUrl = 'https://identity.example.test/login?token=do-not-log';
  await worker.authenticateTask({ tabId: 8, job: { ...job, kind: 'LOGIN_CHECK', auth: { provider: 'google', autoLogin: true } } });
  assert.ok(state.reports[0].message.includes('https://identity.example.test'));
  assert.ok(!JSON.stringify(state.reports).includes('do-not-log'));
  assert.equal(state.fills, 0);
});

test('starts filling an already usable form without waiting for a complete tab event', async () => {
  const { state, worker } = setup();
  await worker.start(job);
  assert.equal(state.fills, 1);
  assert.equal((await worker.getTasks())[1].phase, 'waitingUser');
  assert.equal(state.reports[0].outcome, 'NEEDS_ACTION');
  assert.ok(state.injections.every(i => i.injectImmediately === true));
});

async function settleUntil(condition) {
  for (let attempt = 0; attempt < 30 && !await condition(); attempt++) await new Promise(setImmediate);
  assert.ok(await condition(), 'background event did not complete');
}

test('browser startup automatically claims a waiting web job without a popup message', async () => {
  const { state, chrome } = setup();
  state.waiting = true;
  chrome.runtime.onStartup.listeners.forEach(listener => listener());
  await settleUntil(() => state.reports.length === 1);
  assert.equal(state.claims, 1);
  assert.equal(state.fills, 1);
  assert.equal(state.alarm.periodInMinutes, 0.5);
});

test('pairing and resuming start polling, while a paused extension does not claim a post', async () => {
  const { state, chrome } = setup();
  state.waiting = true;
  await chrome.storage.local.set({ paused: true });
  chrome.storage.onChanged.listeners.forEach(listener => listener({ token: { newValue: 'test-only' } }, 'local'));
  await new Promise(setImmediate);
  assert.equal(state.claims, 0);
  await chrome.storage.local.set({ paused: false });
  chrome.storage.onChanged.listeners.forEach(listener => listener({ paused: { newValue: false } }, 'local'));
  await settleUntil(() => state.reports.length === 1);
  assert.equal(state.claims, 1);
  assert.equal(state.fills, 1);
});

test('overlapping polling triggers share one claim and repair alarms without resetting an existing schedule', async () => {
  const { state, worker } = setup();
  await settleUntil(() => state.alarm !== null);
  const created = state.alarmCreates;
  await worker.ensureAlarm();
  assert.equal(state.alarmCreates, created);
  state.alarm = null;
  await worker.ensureAlarm();
  assert.equal(state.alarmCreates, created + 1);
  state.waiting = true;
  await Promise.all([worker.tick(), worker.tick(), worker.tick()]);
  await settleUntil(() => state.fills === 1);
  assert.equal(state.claims, 1);
  assert.equal(state.fills, 1);
});

test('work arriving during a poll runs immediately instead of waiting for the next alarm', async () => {
  const { state, worker } = setup();
  let heartbeats = 0;
  state.onHeartbeat = () => {
    if (++heartbeats === 1) { state.waiting = true; void worker.tick(); }
  };
  await worker.tick();
  await settleUntil(() => state.reports.length === 1);
  assert.ok(heartbeats >= 2);
  assert.equal(state.claims, 1);
  assert.equal(state.fills, 1);
});

test('publishes one forum at a time and closes the completed tab before starting the next', async () => {
  const { state, worker, chrome } = setup();
  const makeJob = (id, host) => ({ ...job, jobId: id, targetOrigin: `http://${host}.test`, openUrl: `http://${host}.test/new-topic` });
  state.jobs = [makeJob('a1', 'a'), makeJob('a2', 'a'), makeJob('b1', 'b'), makeJob('c1', 'c'), makeJob('d1', 'd')];
  const release = new Map();
  state.fillResult = pending => new Promise(resolve => release.set(pending.jobId, resolve));
  await worker.tick();
  await settleUntil(() => state.fills === 1);
  assert.deepEqual(Object.values(await worker.getTasks()).map(t => t.job.jobId), ['a1']);
  assert.deepEqual(state.jobs.map(t => t.jobId), ['a2', 'b1', 'c1', 'd1']);
  await worker.tick();
  assert.equal(state.fills, 1);
  release.get('a1')({ status: 'submitted' });
  await settleUntil(async () => (await worker.getTasks())[1]?.phase === 'submitted');
  await new Promise(setImmediate);
  state.publishedUrl = 'http://a.test/t/post/1';
  await Promise.all(chrome.tabs.onUpdated.listeners.map(listener => listener(1, { url: 'http://a.test/t/post/1' }, { url: 'http://a.test/t/post/1' })));
  await worker.tick();
  await settleUntil(() => state.fills === 2);
  assert.deepEqual(state.closedTabs, [1]);
  assert.deepEqual(Object.values(await worker.getTasks()).map(t => t.job.jobId), ['a2']);
  assert.deepEqual(state.jobs.map(t => t.jobId), ['b1', 'c1', 'd1']);
  for (const resolve of release.values()) resolve({ status: 'filled' });
});

test('one failed forum leaves the other flows running and concurrent result logs stay separate', async () => {
  const { state, worker, chrome } = setup();
  state.jobs = ['a', 'b', 'c'].map(id => ({ ...job, jobId: id, targetOrigin: `http://${id}.test`, openUrl: `http://${id}.test/new-topic` }));
  state.fillResult = async pending => pending.jobId === 'a' ? { status: 'login', message: 'Sign in' } : { status: 'filled' };
  await worker.tick();
  await settleUntil(() => state.reports.length === 1);
  await worker.tick();
  await settleUntil(() => state.reports.length === 2);
  await worker.tick();
  await settleUntil(() => state.reports.length === 3);
  assert.equal(state.reports.filter(report => report.outcome === 'FAILED').length, 1);
  assert.deepEqual(Object.values(await worker.getTasks()).map(t => t.job.jobId), ['a', 'b', 'c']);
  const { history } = await chrome.storage.local.get('history');
  assert.deepEqual([...new Set(history.map(entry => entry.jobId))].sort(), ['a', 'b', 'c']);
  assert.equal(history.filter(entry => entry.outcome === 'RECEIVED').length, 3);
});

test('a CAPTCHA composer keeps its forum reserved while other forums continue', async () => {
  const { state, worker } = setup();
  state.result = { status: 'captcha' };
  await worker.start(job);
  state.jobs = [{ ...job, jobId: 'same-forum-next' }, { ...job, jobId: 'other-forum', targetOrigin: 'http://other.test', openUrl: 'http://other.test/new-topic' }];
  state.result = { status: 'submitted' };
  await worker.tick();
  await settleUntil(() => state.fills === 2);
  assert.deepEqual(state.jobs.map(item => item.jobId), ['same-forum-next']);
  assert.deepEqual(Object.values(await worker.getTasks()).map(task => task.job.jobId), ['job-test', 'other-forum']);
});

test('opens Discourse with the exact approved web post and preserves category and tags', async () => {
  const { state, worker } = setup();
  const post = { title: 'Hướng dẫn NGINX & reverse proxy', body: 'Nội dung từ web.\n\nserver { listen 80; }' };
  await worker.start({ ...job, openUrl: job.openUrl + '?category=projects/nginx&tags=web-server', post });
  const params = new URL(state.openedUrls[0]).searchParams;
  assert.equal(params.get('title'), post.title);
  assert.equal(params.get('body'), post.body);
  assert.equal(params.get('category'), 'projects/nginx');
  assert.equal(params.get('tags'), 'web-server');
});

test('keeps long bodies in the task without making an oversized forum URL', async () => {
  const { state, worker } = setup();
  const post = { title: 'Long guide', body: 'A long article. '.repeat(1000) };
  await worker.start({ ...job, post });
  assert.equal(new URL(state.openedUrls[0]).searchParams.get('body'), null);
  assert.equal((await worker.getTasks())[1].job.post.body, post.body);
});

test('the periodic sweep recovers a composer that appeared without a load-complete event', async () => {
  const { state, worker } = setup();
  state.ready = false;
  await worker.start(job);
  assert.equal(state.fills, 0);
  state.ready = true;
  await worker.sweep();
  await settleUntil(() => state.reports.length === 1);
  assert.equal(state.fills, 1);
  assert.equal((await worker.getTasks())[1].phase, 'waitingUser');
});

test('reports the actual page injection error when repeated probes fail', async () => {
  const { state, chrome, worker } = setup();
  state.probeError = 'Cannot access contents of the page';
  await worker.start(job);
  const tasks = await worker.getTasks();
  tasks[1].deadline = 0;
  await chrome.storage.session.set({ tasks });
  await worker.sweep();
  await settleUntil(() => state.reports.length === 1);
  assert.equal(state.fills, 0);
  assert.equal(state.reports[0].reason, 'PAGE_LOAD_FAILED');
  assert.ok(state.reports[0].message.includes(state.probeError));
});

test('repeated tab updates never submit the same active task a second time', async () => {
  const { state, chrome, worker } = setup();
  state.result = { status: 'submitted' };
  await worker.start(job);
  await Promise.all(chrome.tabs.onUpdated.listeners.flatMap(listener => [
    listener(1, { status: 'complete' }, { url: job.openUrl }),
    listener(1, { url: job.openUrl }, { url: job.openUrl }),
  ]));
  await worker.sweep();
  assert.equal(state.fills, 1);
  assert.equal((await worker.getTasks())[1].phase, 'submitted');
});

test('an explicitly retried task can run after a previous pre-submit failure', async () => {
  const { state, worker, chrome } = setup();
  state.result = { status: 'notReady' };
  await worker.start(job);
  assert.equal(state.reports[0].outcome, 'FAILED');
  await Promise.all(chrome.tabs.onRemoved.listeners.map(listener => listener(1)));
  state.result = { status: 'filled' };
  await worker.start(job);
  assert.equal(state.fills, 2);
  assert.equal(state.reports[1].reason, 'WAITING_USER');
});

test('an interrupted injection requests reconciliation instead of retrying a possible submission', async () => {
  const { state, worker } = setup();
  state.result = new Error('Execution interrupted');
  await worker.start(job);
  await worker.sweep();
  assert.equal(state.fills, 1);
  assert.equal(state.reports[0].reason, 'SUBMIT_UNCONFIRMED');
  assert.equal((await worker.getTasks())[1].phase, 'waitingUser');
});

test('moderation is reported once and removes the active tab from the scheduler without claiming it as published', async () => {
  const { state, chrome, worker } = setup();
  state.result = { status: 'submitted' };
  await worker.start(job);
  const tasks = await worker.getTasks();
  tasks[1].submittedAt = 0;
  await chrome.storage.session.set({ tasks });
  state.moderation = 'Post received; waiting for a moderator';
  await worker.sweep();
  assert.deepEqual(state.reports, [{ outcome: 'NEEDS_ACTION', reason: 'MODERATION_PENDING', message: state.moderation }]);
  assert.equal(Object.keys(await worker.getTasks()).length, 0);
  await worker.sweep();
  assert.equal(state.reports.length, 1);
});

test('visiting an unrelated topic never reports success; a rendered matching post is recovered on a later tick', async () => {
  const { state, chrome, worker } = setup();
  state.result = { status: 'submitted' };
  await worker.start(job);
  const navigate = url => Promise.all(chrome.tabs.onUpdated.listeners.map(listener => listener(1, { url }, { url })));
  await navigate('http://other.test/t/welcome/1');
  assert.equal(state.injections.filter(item => item.func.name === 'readPublishedPost').length, 0);
  await navigate('http://forum.test/t/welcome/1');
  assert.equal(state.reports.length, 0);
  assert.equal((await worker.getTasks())[1].phase, 'submitted');
  // The matching post renders after the SPA URL event, without another event.
  state.currentUrl = state.publishedUrl = 'http://forum.test/t/actual-post/2';
  await worker.sweep();
  assert.deepEqual(state.reports, [{ outcome: 'PUBLISHED', url: state.publishedUrl }]);
  assert.equal(Object.keys(await worker.getTasks()).length, 0);
});

test('approval after a manual submit is recorded without publishing or retrying', async () => {
  const { state, worker } = setup();
  await worker.start(job);
  state.moderation = 'Post received; waiting for approval';
  await worker.sweep();
  assert.equal(state.reports.at(-1).reason, 'MODERATION_PENDING');
  assert.equal(Object.keys(await worker.getTasks()).length, 0);
  assert.deepEqual(state.closedTabs, [1]);
});

test('a waiting manual tab closes as soon as its published post is confirmed', async () => {
  const { state, worker } = setup();
  await worker.start(job);
  assert.equal((await worker.getTasks())[1].phase, 'waitingUser');
  state.currentUrl = state.publishedUrl = 'http://forum.test/t/manual-post/7';
  await worker.sweep();
  assert.equal(state.reports.at(-1).outcome, 'PUBLISHED');
  assert.deepEqual(state.closedTabs, [1]);
  assert.equal(state.fills, 1);
});

for (const [status, expected] of [['moderation', 'MODERATION_PENDING'], ['uncertain', 'SUBMIT_UNCONFIRMED'], ['rejected', 'SUBMIT_REJECTED'], ['restricted', 'PERMISSION_REQUIRED'], ['published', undefined]]) {
  test(`direct Discourse ${status} never falls through to a second UI submit`, async () => {
    const { state, worker } = setup();
    state.directResult = { status, url: 'http://forum.test/t/created/42', message: 'Fixture result' };
    await worker.start({ ...job, autoSubmit: true });
    assert.equal(state.fills, 0);
    assert.equal(state.reports.length, 1);
    assert.equal(state.reports[0].reason, expected);
    if (status === 'published') assert.equal(state.reports[0].outcome, 'PUBLISHED');
    const notices = state.injections.filter(i => i.func.name === 'showPublishNotice');
    assert.equal(notices.length, ['moderation', 'published'].includes(status) ? 1 : 0);
    if (notices.length) assert.equal(notices[0].args[0].status, status);
  });
}

test('retains a verified permalink during a backend outage and retries only reporting', async () => {
  const { state, worker, chrome } = setup();
  state.directResult = { status: 'published', url: 'http://forum.test/t/created/42' };
  state.reportOffline = true;
  await worker.start({ ...job, autoSubmit: true });
  assert.equal((await worker.getTasks())[1].phase, 'reporting');
  assert.equal(state.fills, 0); assert.equal(state.reports.length, 0);
  await Promise.all(chrome.tabs.onRemoved.listeners.map(listener => listener(1)));
  assert.equal((await worker.getTasks())[1].phase, 'reporting');
  state.reportOffline = false;
  await worker.sweep();
  assert.equal(state.reports[0].url, state.directResult.url);
  assert.equal(Object.keys(await worker.getTasks()).length, 0);
  assert.equal(state.injections.filter(i => i.func.name === 'submitDiscoursePost').length, 1);
});

// ---- queue never blocked by waiting tabs; confirmation after submit -----------

const socialJob = (id, origin = 'https://www.quora.com', extra = {}) => ({
  ...job, jobId: id, targetOrigin: origin, openUrl: `${origin}/`,
  account: { name: `Social ${id}`, platform: 'Social' },
  recipe: { engine: 'quora', workflow: 'social', successUrlPattern: '^https://[^/]+/profile/[^/]+/[^/?#]+$' }, ...extra,
});

async function seedTasks(chrome, tasks) {
  await chrome.storage.session.set({ tasks: Object.fromEntries(tasks.map(task => [task.tabId, task])) });
}

async function patchTask(chrome, tabId, patch) {
  const { tasks } = await chrome.storage.session.get('tasks');
  tasks[tabId] = { ...tasks[tabId], ...patch };
  await chrome.storage.session.set({ tasks });
}

test('waiting tabs stay tracked and prevent additional tabs once the budget is reached', async () => {
  const { state, worker, chrome } = setup();
  const now = Date.now();
  const waiting = (id, index, postSubmit) => ({
    job: socialJob(id, `http://${id}.test`), tabId: 100 + index, phase: 'waitingUser', waitingSince: now - (10 - index) * 60_000,
    deadline: now + 60_000, ...(postSubmit ? { submittedAt: now - 300_000, waitingReason: 'SUBMIT_UNCONFIRMED' } : { waitingReason: 'WAITING_USER' }),
  });
  await seedTasks(chrome, [waiting('tinhte', 0, true), waiting('dzone', 1, true), waiting('quora', 2, true), waiting('serverfault', 3, false), waiting('unix', 4, false)]);
  state.jobs = [socialJob('next', 'http://next.test')];
  state.result = { status: 'filled' };

  await worker.tick();
  const tracked = Object.values(await worker.getTasks()).map(task => task.job.jobId);
  assert.equal(state.claims, 0);
  assert.equal(state.fills, 0);
  assert.ok(!tracked.includes('next'));
  assert.ok(tracked.includes('tinhte'), 'waiting tabs remain tracked');
  assert.ok(tracked.includes('serverfault') && tracked.includes('unix'), 'composers waiting before submission stay tracked');
  assert.equal(tracked.length, 5);
});

test('a progress notice after submit is not a rejection and the post is confirmed later', async () => {
  const { state, worker, chrome } = setup();
  const now = Date.now();
  await seedTasks(chrome, [{ job: socialJob('tinhte', 'https://tinhte.vn'), tabId: 7, phase: 'submitted', submittedAt: now - 20_000, deadline: now + 160_000, beforeUrls: [] }]);
  state.currentUrl = 'https://tinhte.vn/editorv2/create/767/';
  state.errorText = 'Đang tạo bài viết đợi xíu nhé';

  await worker.sweep();
  assert.equal(state.reports.length, 0);
  assert.equal((await worker.getTasks())[7].phase, 'submitted');

  state.errorText = null;
  state.currentUrl = 'https://tinhte.vn/thread/chia-se-kinh-nghiem.123456/';
  state.publishedUrl = state.currentUrl;
  await worker.sweep();
  assert.deepEqual(state.reports.map(report => report.outcome), ['PUBLISHED']);
  assert.equal(state.reports[0].url, 'https://tinhte.vn/thread/chia-se-kinh-nghiem.123456/');
});

test('an error banner counts as a rejection only when it is still shown on a later check', async () => {
  const { state, worker, chrome } = setup();
  const now = Date.now();
  await seedTasks(chrome, [{ job: socialJob('dzone', 'https://dzone.com'), tabId: 8, phase: 'submitted', submittedAt: now - 20_000, deadline: now + 160_000, beforeUrls: [] }]);
  state.currentUrl = 'https://dzone.com/content/article/post.html';
  state.errorText = 'Title must be at least 10 characters';

  await worker.sweep();
  assert.equal(state.reports.length, 0, 'a banner seen once is not yet a rejection');
  await patchTask(chrome, 8, { errorSeen: { text: state.errorText, at: Date.now() - 9_000 } });
  await worker.sweep();
  assert.deepEqual(state.reports.map(report => [report.reason, report.message]), [['SUBMIT_REJECTED', 'Title must be at least 10 characters']]);
  assert.equal((await worker.getTasks())[8].waitingReason, 'SUBMIT_REJECTED');
});

test('after the confirmation window the own profile is checked read-only before asking the operator', async () => {
  const { state, worker, chrome } = setup();
  const now = Date.now();
  const quora = socialJob('quora', 'https://www.quora.com', { auth: { profileUrl: 'https://www.quora.com/profile/VPSTTT' } });
  await seedTasks(chrome, [{ job: quora, tabId: 9, phase: 'submitted', submittedAt: now - 200_000, deadline: now - 1_000, beforeUrls: [] }]);
  state.currentUrl = 'https://www.quora.com/';

  await worker.sweep();
  assert.equal(state.reports.length, 0);
  assert.equal((await worker.getTasks())[9].phase, 'verifying');
  assert.equal(state.openedUrls.at(-1), 'https://www.quora.com/profile/VPSTTT/posts');
  assert.equal(state.fills, 0, 'verification never fills or submits again');

  state.currentUrl = 'https://www.quora.com/profile/VPSTTT/posts';
  state.publishedUrl = 'https://www.quora.com/profile/VPSTTT/Lam-the-nao-de-chon-VPS';
  await Promise.all(chrome.tabs.onUpdated.listeners.map(listener => listener(9, { url: state.currentUrl }, { url: state.currentUrl })));
  assert.deepEqual(state.reports.map(report => [report.outcome, report.url]), [['PUBLISHED', 'https://www.quora.com/profile/VPSTTT/Lam-the-nao-de-chon-VPS']]);
});

test('a profile check that finds nothing hands the post to the operator once, without a second profile visit', async () => {
  const { state, worker, chrome } = setup();
  const now = Date.now();
  const quora = socialJob('quora', 'https://www.quora.com', { auth: { profileUrl: 'https://www.quora.com/profile/VPSTTT' } });
  await seedTasks(chrome, [{ job: quora, tabId: 9, phase: 'verifying', profileChecked: true, submittedAt: now - 300_000, deadline: now - 1_000, beforeUrls: [] }]);
  state.currentUrl = 'https://www.quora.com/profile/VPSTTT/posts';

  await worker.sweep();
  await worker.sweep();
  assert.deepEqual(state.reports.map(report => report.reason), ['SUBMIT_UNCONFIRMED']);
  const task = (await worker.getTasks())[9];
  assert.equal(task.phase, 'waitingUser');
  assert.equal(task.waitingReason, 'SUBMIT_UNCONFIRMED');
  assert.ok(task.deadline - Date.now() <= 10 * 60_000, 'a submitted tab is tracked only for a late confirmation');
});

test('without a profile URL the post is handed to the operator when the window ends', async () => {
  const { state, worker, chrome } = setup();
  const now = Date.now();
  await seedTasks(chrome, [{ job: socialJob('dzone', 'https://dzone.com'), tabId: 8, phase: 'submitted', submittedAt: now - 200_000, deadline: now - 1_000, beforeUrls: [] }]);
  state.currentUrl = 'https://dzone.com/content/article/post.html';
  await worker.sweep();
  assert.deepEqual(state.reports.map(report => report.reason), ['SUBMIT_UNCONFIRMED']);
  assert.equal(state.openedUrls.length, 0);
});

test('a report refused by the backend stops retrying, and long messages are shortened', async () => {
  const { state, worker, chrome } = setup();
  await seedTasks(chrome, [{ job: socialJob('done', 'http://done.test'), tabId: 5, phase: 'reporting',
    pendingReport: { outcome: 'NEEDS_ACTION', extra: { reason: 'SUBMIT_REJECTED', message: 'x'.repeat(1000) }, closeTab: false } }]);
  state.reportStatus = 409;
  await worker.sweep();
  assert.equal(Object.keys(await worker.getTasks()).length, 0, 'the slot is freed instead of retrying forever');
  const { history } = await chrome.storage.local.get('history');
  assert.equal(history[0].outcome, 'REPORT_REJECTED');

  state.reportStatus = 0;
  await seedTasks(chrome, [{ job: socialJob('long', 'http://long.test'), tabId: 6, phase: 'reporting',
    pendingReport: { outcome: 'NEEDS_ACTION', extra: { reason: 'SUBMIT_REJECTED', message: 'y'.repeat(1000) }, closeTab: false } }]);
  await worker.sweep();
  assert.ok(state.reports[0].message.length <= 450);
});

// ---- next post starts right after the previous one frees its slot ----------
const forumJob = host => ({ ...job, jobId: host, targetOrigin: `http://${host}.test`, openUrl: `http://${host}.test/new-topic` });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

test('a published post starts the next queued post without waiting for the alarm', async () => {
  const { state, worker } = setup({ nextJobDelay: 0 });
  state.jobs = [forumJob('a'), forumJob('b')];
  state.fillResult = async pending => ({ status: 'published', url: `${pending.targetOrigin}/t/post/1` });
  await worker.tick();
  for (let i = 0; i < 20 && state.fills < 2; i++) await pause(5);
  assert.equal(state.claims, 2, 'the second post was claimed without a manual poll');
  assert.equal(state.fills, 2);
  assert.deepEqual(state.reports.map(report => report.outcome), ['PUBLISHED', 'PUBLISHED']);
});

test('a draft handed to the operator lets the next forum start right away', async () => {
  const { state, worker } = setup({ nextJobDelay: 0 });
  state.jobs = [forumJob('a'), forumJob('b')];
  state.result = { status: 'filled' };
  await worker.tick();
  for (let i = 0; i < 20 && state.fills < 2; i++) await pause(5);
  assert.equal(state.fills, 2);
  const tasks = Object.values(await worker.getTasks());
  assert.deepEqual(tasks.map(task => task.phase), ['waitingUser', 'waitingUser'], 'both drafts stay tracked for the operator');
});

test('a paused extension does not claim the next post after one finishes', async () => {
  const { state, worker, chrome } = setup({ nextJobDelay: 0 });
  state.jobs = [forumJob('a'), forumJob('b')];
  state.fillResult = async pending => {
    await chrome.storage.local.set({ paused: true });
    return { status: 'published', url: `${pending.targetOrigin}/t/post/1` };
  };
  await worker.tick();
  await settleUntil(() => state.reports.length === 1);
  await pause(30);
  assert.equal(state.claims, 1);
  assert.deepEqual(state.jobs.map(item => item.jobId), ['b']);
});

test('the early poll never starts a second flow while one is still filling', async () => {
  const { state, worker } = setup({ nextJobDelay: 0 });
  state.jobs = [forumJob('a'), forumJob('b'), forumJob('c')];
  let release;
  state.fillResult = () => new Promise(resolve => { release = resolve; });
  await worker.tick();
  await settleUntil(() => state.fills === 1);
  worker.tickSoon();
  worker.tickSoon();
  await pause(30);
  assert.equal(state.claims, 1, 'MAX_ACTIVE_FLOWS still holds');
  assert.equal(state.fills, 1);
  release({ status: 'filled' });
});

// ---- AI-assisted recovery when a composer control is not found -------------
const recoveryJob = (extra = {}) => ({ ...job, jobId: 'job-ui', autoSubmit: true, uiRecovery: { enabled: true },
  recipe: { engine: 'discourse', successUrlPattern: '/t/[^/]+/\\d+', readySelectors: ['#reply-title'], titleSelectors: ['#reply-title'], bodySelectors: ['textarea.d-editor-input'], submitSelectors: ['button.create'] }, ...extra });
const candidates = { url: 'http://forum.test/new-topic', candidates: [{ index: 0, kind: 'contenteditable', tag: 'div', inDialog: true, inForm: true, disabled: false, selector: 'div.new-editor' }] };
const readyHint = (approved = false, selectors = { body: { selector: 'div.new-editor', approved, suggestionId: 's-1' } }) => ({ hintId: 'h-1', status: 'READY', selectors });

test('a composer field that moved is filled once with the AI selector and left for the operator to post', async () => {
  const { state, worker } = setup();
  state.candidates = candidates;
  state.hint = readyHint(false);
  const seen = [];
  state.fillResult = async pending => { seen.push(pending); return seen.length === 1 ? { status: 'notReady', missing: ['body'], message: 'Không thấy form' } : { status: 'filled' }; };
  await worker.start(recoveryJob());
  await settleUntil(() => state.reports.length === 1);
  assert.equal(state.fills, 2);
  assert.equal(seen[1].autoSubmit, false, 'an unapproved AI selector never clicks Post');
  assert.equal(seen[1].recipe.bodySelectors[0], 'div.new-editor');
  assert.equal(seen[1].recipe.uiOverride, true);
  assert.equal(state.reports[0].reason, 'WAITING_USER');
  assert.match(state.reports[0].message, /AI đã tìm/);
  assert.deepEqual(state.hintRequests[0].body.missing, ['body']);
  assert.equal(state.hintRequests[0].body.candidates.length, 1);
  const task = Object.values(await worker.getTasks())[0];
  assert.equal(task.uiOverride.approved, false, 'the tab remembers the AI selectors for a later continue');
});

test('an approved AI selector keeps automatic submit', async () => {
  const { state, worker } = setup();
  state.candidates = candidates;
  state.hint = readyHint(true);
  const seen = [];
  state.fillResult = async pending => { seen.push(pending); return seen.length === 1 ? { status: 'notReady', missing: ['body'] } : { status: 'submitted' }; };
  await worker.start(recoveryJob());
  await settleUntil(async () => Object.values(await worker.getTasks())[0]?.phase === 'submitted');
  assert.equal(seen[1].autoSubmit, true);
});

test('when the AI cannot help, the original "editor not found" result is reported', async () => {
  const { state, worker } = setup();
  state.candidates = candidates;
  state.hint = { hintId: 'h-1', status: 'FAILED', errorCode: 'AI_HINT_FAILED' };
  state.result = { status: 'notReady', missing: ['body'], message: 'Không thấy form đăng bài' };
  await worker.start(recoveryJob());
  await settleUntil(() => state.reports.length === 1);
  assert.equal(state.fills, 1);
  assert.deepEqual([state.reports[0].outcome, state.reports[0].reason], ['FAILED', 'EDITOR_NOT_FOUND']);
});

test('recovery stays off unless the backend enables it, and a disabled endpoint changes nothing', async () => {
  const off = setup();
  off.state.candidates = candidates;
  off.state.result = { status: 'notReady', missing: ['body'] };
  await off.worker.start(recoveryJob({ uiRecovery: undefined }));
  await settleUntil(() => off.state.reports.length === 1);
  assert.equal(off.state.hintRequests, undefined);
  const disabled = setup();
  disabled.state.candidates = candidates;
  disabled.state.hint = new Error('AI-assisted UI recovery is disabled');
  disabled.state.result = { status: 'notReady', missing: ['body'] };
  await disabled.worker.start(recoveryJob());
  await settleUntil(() => disabled.state.reports.length === 1);
  assert.equal(disabled.state.reports[0].reason, 'EDITOR_NOT_FOUND');
});

test('when only the Post button is unknown the hint is recorded without filling again', async () => {
  const { state, worker } = setup();
  state.candidates = candidates;
  state.hint = readyHint(false, { submit: { selector: 'button.go', approved: false, suggestionId: 's-2' } });
  state.result = { status: 'filled', missing: ['submit'], message: 'Nút đăng chưa sẵn sàng.' };
  await worker.start(recoveryJob());
  await settleUntil(() => state.reports.length === 1);
  assert.equal(state.fills, 1);
  assert.equal(state.reports[0].reason, 'WAITING_USER');
  assert.match(state.reports[0].message, /đề xuất nút Đăng/);
});

test('an opener hint may lead to one more hint for the fields, never a third', async () => {
  const { state, worker } = setup();
  state.candidates = candidates;
  state.hint = count => count === 1
    ? readyHint(false, { opener: { selector: 'a.compose', approved: false, suggestionId: 's-3' } })
    : readyHint(false);
  state.result = { status: 'notReady', missing: ['opener'] };
  const seen = [];
  state.fillResult = async pending => { seen.push(pending); return seen.length === 1 ? { status: 'notReady', missing: ['opener'] } : { status: 'notReady', missing: ['body'] }; };
  await worker.start(recoveryJob());
  await settleUntil(() => state.reports.length === 1);
  assert.equal(state.hintRequests.filter(request => request.method === 'POST').length, 2);
  assert.equal(state.fills, 3);
  assert.deepEqual(seen[2].recipe.openerSelectors, ['a.compose']);
  assert.equal(state.reports[0].reason, 'EDITOR_NOT_FOUND');
});

// ---- login checks never leave their tabs behind ---------------------------
const loginCheck = (auth = {}) => ({ ...job, kind: 'LOGIN_CHECK', auth: { provider: 'password', autoLogin: true, ...auth } });

for (const [label, authResult, outcome] of [
  ['a confirmed login', { state: 'authenticated', url: 'https://forum.test/', detectedUsername: 'alice' }, 'AUTHENTICATED'],
  ['another signed-in account', { state: 'mismatch', url: 'https://forum.test/', detectedUsername: 'bob' }, 'NEEDS_ACTION'],
  ['a challenge', { state: 'challenge', url: 'https://forum.test/', message: 'CAPTCHA' }, 'NEEDS_ACTION'],
]) test(`a login check that ends with ${label} closes its tab and sign-in popup`, async () => {
  const { state, worker } = setup();
  state.authResult = authResult;
  await worker.authenticateTask({ tabId: 8, authTabId: 9, job: loginCheck() });
  assert.equal(state.reports[0].outcome, outcome);
  assert.deepEqual([...(state.closedTabs ?? [])].sort(), [8, 9]);
  assert.equal(Object.keys(await worker.getTasks()).length, 0);
});

test('a Google account on a page with only the site form is reported quickly, not after the deadline', async () => {
  const { state, worker } = setup();
  state.authResult = { state: 'noGoogle', url: 'https://substack.com/sign-in', message: 'Trang đăng nhập không có nút đăng nhập bằng Google.' };
  const started = Date.now();
  await worker.authenticateTask({ tabId: 8, job: loginCheck({ provider: 'google' }) });
  assert.ok(Date.now() - started < 5_000);
  assert.equal(state.reports[0].outcome, 'NEEDS_ACTION');
  assert.match(state.reports[0].message, /không có nút đăng nhập bằng Google/);
  assert.deepEqual(state.closedTabs, [8]);
  assert.ok(!state.injections.some(injection => ['identifier', 'password'].includes(injection.args?.[0]?.action)), 'no credential step is attempted');
});

test('a page step that returns nothing counts as an unrecognized page instead of a silent wait', async () => {
  const { state, worker } = setup();
  state.authResult = undefined;
  await worker.authenticateTask({ tabId: 8, authActivated: true, authUnknownSince: Date.now() - 9_000, job: loginCheck() });
  assert.equal(state.reports[0].outcome, 'NEEDS_ACTION');
  assert.match(state.reports[0].message, /chưa nhận diện được form đăng nhập/);
  assert.deepEqual(state.closedTabs, [8]);
});

test('"Sign in with password" is clicked before the password step, without asking for a secret first', async () => {
  const { state, worker } = setup();
  let switched = false;
  state.authResult = ({ action }) => {
    if (action === 'usePassword') { switched = true; return { state: 'submitted', url: 'https://substack.com/sign-in' }; }
    return switched ? { state: 'authenticated', url: 'https://substack.com/' } : { state: 'usePassword', url: 'https://substack.com/sign-in' };
  };
  await worker.authenticateTask({ tabId: 8, job: loginCheck() });
  assert.ok(state.injections.some(injection => injection.args?.[0]?.action === 'usePassword'));
  assert.equal(state.injections.find(injection => injection.args?.[0]?.action === 'usePassword').args[0].payload, undefined);
  assert.equal(state.reports[0].outcome, 'AUTHENTICATED');
});
