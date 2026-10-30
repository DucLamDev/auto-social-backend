// Actual MV3 extension, three independent local forums, no external posting.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { test } = require('node:test');
const { chromium } = require('playwright');
const { EXTENSION_RECIPES } = require('../../src/connectors/extension/extension-delivery.ts');

test('web queues three independent forum flows; CAPTCHA in one does not block the other posts', { timeout: 60_000 }, async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'social-multiflow-test-'));
  const extensionPath = path.join(workspace, 'extension');
  fs.cpSync(path.join(__dirname, '../../browser-extension'), extensionPath, { recursive: true });
  const manifestPath = path.join(extensionPath, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.host_permissions = ['http://127.0.0.1/*'];
  delete manifest.optional_host_permissions;
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  const servers = [];
  const jobs = [];
  const reports = [];
  const submissions = [];
  const visited = new Set();
  const claimRequests = [];
  let releaseVisits;
  const allVisited = new Promise(resolve => { releaseVisits = resolve; });
  const serve = async handler => {
    const server = http.createServer(handler);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    servers.push(server);
    return `http://127.0.0.1:${server.address().port}`;
  };
  const json = (response, data) => { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(data)); };
  let context;
  try {
    for (const [id, engine, captcha] of [['nginx-fixture', 'discourse', true], ['directadmin-fixture', 'xenforo', false], ['caddy-fixture', 'discourse', false]]) {
      const origin = await serve(async (request, response) => {
        const url = new URL(request.url, 'http://localhost');
        if (url.pathname === '/posted') {
          let body = ''; for await (const chunk of request) body += chunk;
          submissions.push({ id, ...JSON.parse(body) });
          // A globally serial worker deadlocks here: all three forms must have
          // opened before any successful forum returns its topic URL.
          await allVisited;
          json(response, { url: engine === 'xenforo' ? '/threads/new-post.42/' : '/t/new-post/42' });
          return;
        }
        visited.add(id);
        if (visited.size === 3) releaseVisits();
        const fields = engine === 'discourse'
          ? '<div id="reply-control"><input id="reply-title"><textarea class="d-editor-input"></textarea><button class="create">Post</button></div>'
          : '<form action="/forums/general.1/post-thread"><input name="title"><div class="fr-element" contenteditable="true"></div><button type="submit" class="button--primary">Post</button></form>';
        response.writeHead(200, { 'content-type': 'text/html' });
        response.end(`<!doctype html>${fields}${captcha ? '<div class="g-recaptcha">Complete CAPTCHA</div>' : ''}<script>
          const title = document.querySelector('input');
          const editor = document.querySelector('textarea, [contenteditable]');
          document.querySelector('button').onclick = async event => {
            event.preventDefault();
            const result = await fetch('/posted', {method:'POST',body:JSON.stringify({title:title.value,body:editor.value ?? editor.innerText})});
            const post = await result.json();
            const titleText = title.value; const bodyText = editor.value ?? editor.innerText;
            document.body.innerHTML = ${JSON.stringify(engine === 'discourse' ? '<div id="topic-title"><h1></h1></div><div class="topic-post"><div class="cooked"></div></div>' : '<h1 class="p-title-value"></h1><article class="message--post"><div class="message-body"><div class="bbWrapper"></div></div></article>')};
            document.querySelector('h1').textContent = titleText;
            document.querySelector('.cooked, .bbWrapper').textContent = bodyText;
            history.pushState({},'',post.url);
          };
        </script>`);
      });
      jobs.push({ jobId: id, targetOrigin: origin, account: { name: id, platform: id },
        flow: { id, name: id, engine, revision: 1 }, recipe: EXTENSION_RECIPES[engine],
        openUrl: origin + (engine === 'xenforo' ? '/forums/general.1/post-thread' : '/new-topic'),
        autoSubmit: true, post: { title: `Approved title for ${id}`, body: `Different approved content for ${id}.` } });
    }
    const expected = structuredClone(jobs);
    const apiUrl = await serve(async (request, response) => {
      let body = ''; for await (const chunk of request) body += chunk;
      let data = {};
      if (request.url.endsWith('/heartbeat')) data = { waiting: jobs.length, origins: expected.map(job => job.targetOrigin), device: { name: 'Parallel Chrome' } };
      if (request.url.endsWith('/claim')) {
        const payload = JSON.parse(body); claimRequests.push(payload);
        const index = jobs.findIndex(job => !(payload.excludeOrigins ?? []).includes(job.targetOrigin));
        data = { task: index < 0 ? null : jobs.splice(index, 1)[0] };
      }
      if (request.url.endsWith('/result')) reports.push({ id: request.url.split('/tasks/')[1].split('/')[0], ...JSON.parse(body) });
      json(response, { success: true, data });
    });
    context = await chromium.launchPersistentContext(path.join(workspace, 'profile'), {
      executablePath: chromium.executablePath(), headless: true,
      args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
    });
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    await worker.evaluate(apiUrl => chrome.storage.local.set({ apiUrl, token: 'local-only' }), apiUrl);
    for (let i = 0; i < 60 && reports.length < 3; i++) await new Promise(resolve => setTimeout(resolve, 500));
    assert.equal(visited.size, 3);
    assert.equal(reports.length, 3);
    assert.deepEqual(reports.map(report => [report.id, report.outcome]).sort(), [
      ['caddy-fixture', 'PUBLISHED'], ['directadmin-fixture', 'PUBLISHED'], ['nginx-fixture', 'NEEDS_ACTION'],
    ]);
    assert.equal(reports.find(report => report.id === 'nginx-fixture').reason, 'CAPTCHA_REQUIRED');
    assert.equal(submissions.length, 2);
    for (const submission of submissions) {
      assert.equal(submission.title, expected.find(job => job.jobId === submission.id).post.title);
      assert.equal(submission.body, expected.find(job => job.jobId === submission.id).post.body);
    }
    assert.equal(claimRequests[2].excludeOrigins.length, 2);
    const { tasks } = await worker.evaluate(() => chrome.storage.session.get('tasks'));
    assert.deepEqual(Object.values(tasks).map(task => task.job.jobId), ['nginx-fixture']);
    assert.ok(context.pages().every(page => !page.url().includes('/popup.html')));
  } finally {
    releaseVisits();
    await context?.close();
    for (const server of servers) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    const resolved = path.resolve(workspace);
    assert.ok(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep + 'social-multiflow-test-'));
    fs.rmSync(resolved, { recursive: true, force: true });
  }
});
