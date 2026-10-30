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

function setup() {
  const state = { ready: true, fills: 0, result: { status: 'filled' }, reports: [], injections: [], openedUrls: [], claims: 0, waiting: false, alarm: null, alarmCreates: 0, jobs: null, claimRequests: [], nextTabId: 0 };
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
      update: async (id, options) => { if (options?.active) state.activated = id; return { id, windowId: 2 }; }, remove: async () => {},
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
      if (injection.func.name === 'fillAndSubmit') {
        state.fills++;
        if (state.fillResult) return [{ result: await state.fillResult(injection.args[0]) }];
        if (state.result instanceof Error) throw state.result;
        return [{ result: state.result }];
      }
      if (injection.func.name === 'submitDiscoursePost') return [{ result: state.directResult ?? { status: 'fallback' } }];
      if (injection.func.name === 'readModeration') return [{ result: state.moderation ?? null }];
      if (injection.func.name === 'readPublishedPost') return [{ result: state.publishedUrl ?? null }];
      if (injection.func.name === 'accountAuthStep') {
        if (state.authError) throw new Error(state.authError);
        return [{ result: typeof state.authResult === 'function' ? state.authResult() : state.authResult }];
      }
      return [{ result: null }];
    } },
  };
  const source = fs.readFileSync(path.join(__dirname, '../../browser-extension/background.js'), 'utf8')
    .replace(/^import .* from '\.\/(?:page-actions|social-actions|auth-actions|discourse-session|publish-notice)\.js';\r?\n/gm, '');
  const context = vm.createContext({
    chrome, URL, Date, AbortSignal, setTimeout, clearTimeout,
    canFillPage: function canFillPage() {}, fillAndSubmit: function fillAndSubmit() {}, readErrors: function readErrors() {}, readModeration: function readModeration() {}, readPublishedPost: function readPublishedPost() {},
    fillSocialAndSubmit: function fillSocialAndSubmit() {}, readSocialPublishedPost: function readSocialPublishedPost() {},
    accountAuthStep: function accountAuthStep() {},
    submitDiscoursePost: function submitDiscoursePost() {},
    showPublishNotice: function showPublishNotice() {},
    fetch: async (url, options) => {
      if (url.endsWith('/result')) {
        if (state.reportOffline) throw new Error('Backend offline');
        state.reports.push(JSON.parse(options.body));
      }
      let data = {};
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
  vm.runInContext(source + '\nglobalThis.worker = { start, sweep, getTasks, tick, ensureAlarm, withDeadline, authenticateTask };', context);
  return { state, chrome, worker: context.worker };
}

test('a page probe that never resolves cannot hold the authentication queue forever', async () => {
  const { worker } = setup();
  await assert.rejects(worker.withDeadline(new Promise(() => {}), 5), /AUTH_STEP_TIMEOUT/);
  assert.equal(await worker.withDeadline(Promise.resolve('ready'), 100), 'ready');
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
  for (let attempt = 0; attempt < 30 && !condition(); attempt++) await new Promise(setImmediate);
  assert.ok(condition(), 'background event did not complete');
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

test('three forums run concurrently while a second job on the same forum waits for its own flow', async () => {
  const { state, worker, chrome } = setup();
  const makeJob = (id, host) => ({ ...job, jobId: id, targetOrigin: `http://${host}.test`, openUrl: `http://${host}.test/new-topic` });
  state.jobs = [makeJob('a1', 'a'), makeJob('a2', 'a'), makeJob('b1', 'b'), makeJob('c1', 'c'), makeJob('d1', 'd')];
  const release = new Map();
  state.fillResult = pending => new Promise(resolve => release.set(pending.jobId, resolve));
  await worker.tick();
  await settleUntil(() => state.fills === 3);
  assert.deepEqual(Object.values(await worker.getTasks()).map(t => t.job.jobId), ['a1', 'b1', 'c1']);
  assert.deepEqual(state.jobs.map(t => t.jobId), ['a2', 'd1']);
  await worker.tick();
  assert.equal(state.fills, 3);
  release.get('a1')({ status: 'submitted' });
  await settleUntil(() => state.injections.length >= 6);
  await new Promise(setImmediate);
  state.publishedUrl = 'http://a.test/t/post/1';
  await Promise.all(chrome.tabs.onUpdated.listeners.map(listener => listener(1, { url: 'http://a.test/t/post/1' }, { url: 'http://a.test/t/post/1' })));
  await worker.tick();
  await settleUntil(() => state.fills === 4);
  assert.deepEqual(Object.values(await worker.getTasks()).map(t => t.job.jobId), ['b1', 'c1', 'a2']);
  assert.deepEqual(state.jobs.map(t => t.jobId), ['d1']);
  for (const resolve of release.values()) resolve({ status: 'filled' });
});

test('one failed forum leaves the other flows running and concurrent result logs stay separate', async () => {
  const { state, worker, chrome } = setup();
  state.jobs = ['a', 'b', 'c'].map(id => ({ ...job, jobId: id, targetOrigin: `http://${id}.test`, openUrl: `http://${id}.test/new-topic` }));
  state.fillResult = async pending => pending.jobId === 'a' ? { status: 'login', message: 'Sign in' } : { status: 'filled' };
  await worker.tick();
  await settleUntil(() => state.reports.length === 3);
  assert.equal(state.reports.filter(report => report.outcome === 'FAILED').length, 1);
  assert.deepEqual(Object.values(await worker.getTasks()).map(t => t.job.jobId), ['b', 'c']);
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
  const { state, worker } = setup();
  state.result = { status: 'notReady' };
  await worker.start(job);
  assert.equal(state.reports[0].outcome, 'FAILED');
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
  const { state, worker } = setup();
  state.directResult = { status: 'published', url: 'http://forum.test/t/created/42' };
  state.reportOffline = true;
  await worker.start({ ...job, autoSubmit: true });
  assert.equal((await worker.getTasks())[1].phase, 'reporting');
  assert.equal(state.fills, 0); assert.equal(state.reports.length, 0);
  state.reportOffline = false;
  await worker.sweep();
  assert.equal(state.reports[0].url, state.directResult.url);
  assert.equal(Object.keys(await worker.getTasks()).length, 0);
  assert.equal(state.injections.filter(i => i.func.name === 'submitDiscoursePost').length, 1);
});
