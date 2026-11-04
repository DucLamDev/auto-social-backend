// Actual MV3 extension against local fixture sites and a fake backend; nothing leaves the machine. Run:
//   node --import tsx --test scripts/extension-e2e/form-fill-extension.test.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { test } = require('node:test');
const { chromium } = require('playwright');
const { EXTENSION_RECIPES } = require('../../src/connectors/extension/extension-delivery.ts');

// Lemmy-like create_post: community picker, language <select>, a required rules
// checkbox the recipe does not know. "Create" stays disabled until all are set.
const page = `<!doctype html><meta charset="utf-8"><form id="create-post">
  <div class="dropdown"><button type="button" id="post-community" role="combobox" aria-haspopup="listbox" aria-expanded="false">Select a community</button>
    <div class="dropdown-menu" hidden><input aria-label="Search communities"><button type="button" class="dropdown-item" role="option">technology</button><button type="button" class="dropdown-item" role="option">linux</button></div></div>
  <label for="post-title">Title</label><textarea id="post-title"></textarea>
  <label for="markdown-textarea-1">Body</label><textarea id="markdown-textarea-1"></textarea>
  <label for="post-language">Language</label><select id="post-language"><option value="0">Undetermined</option><option value="37">English</option><option value="96">Tiếng Việt</option></select>
  <label><input type="checkbox" id="rules" required> I have read the community rules</label>
  <input type="hidden" name="auth" value="csrf-secret">
  <button type="submit" disabled>Create</button>
</form><script>
  const form = document.querySelector('form'), submit = form.querySelector('[type="submit"]'), picker = form.querySelector('#post-community'), menu = form.querySelector('.dropdown-menu');
  const title = form.querySelector('#post-title'), body = form.querySelector('#markdown-textarea-1'), language = form.querySelector('select'), rules = form.querySelector('#rules');
  const sync = () => { submit.disabled = !(title.value && body.value && rules.checked && language.value !== '0' && picker.textContent !== 'Select a community'); };
  picker.onclick = () => { menu.hidden = !menu.hidden; picker.setAttribute('aria-expanded', String(!menu.hidden)); };
  for (const option of menu.querySelectorAll('[role="option"]')) option.onclick = () => { picker.textContent = option.textContent; menu.hidden = true; picker.setAttribute('aria-expanded', 'false'); sync(); };
  form.addEventListener('input', sync); form.addEventListener('change', sync);
  form.onsubmit = async event => {
    event.preventDefault();
    const record = { title: title.value, body: body.value, community: picker.textContent, language: language.value, rules: rules.checked };
    await fetch('/posted', { method: 'POST', body: JSON.stringify(record) });
    document.body.innerHTML = '<div class="post-listing"><h5 class="post-title"></h5><div class="md"></div></div>';
    document.querySelector('.post-title').textContent = record.title;
    document.querySelector('.md').textContent = record.body;
    history.pushState({}, '', '/post/123');
  };
</script>`;

const RESULT_FIELDS = ['outcome', 'url', 'reason', 'message', 'detectedUsername', 'googleBlocked'];

test('two Lemmy-like sites run at once: AI form-fill completes one and posts it, a low-confidence answer leaves the other to the operator', { timeout: 90_000 }, async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'social-formfill-test-'));
  const extensionPath = path.join(workspace, 'extension');
  fs.cpSync(path.join(__dirname, '../../browser-extension'), extensionPath, { recursive: true });
  const manifestPath = path.join(extensionPath, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.host_permissions = ['http://127.0.0.1/*'];
  delete manifest.optional_host_permissions;
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  const servers = [];
  const serve = async handler => {
    const server = http.createServer(handler);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    servers.push(server);
    return `http://127.0.0.1:${server.address().port}`;
  };
  const json = (response, data, status = 200) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(data)); };
  const readBody = async request => { let body = ''; for await (const chunk of request) body += chunk; return body; };
  const jobs = [], reports = [], rejected = [], posted = [], claimRequests = [], formFillRequests = [];
  let context;
  try {
    for (const id of ['lemmy-ai', 'lemmy-unsure']) {
      const origin = await serve(async (request, response) => {
        if (request.url === '/posted') { posted.push({ id, ...JSON.parse(await readBody(request)) }); json(response, {}); return; }
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); response.end(page);
      });
      jobs.push({ jobId: id, targetOrigin: origin, openUrl: `${origin}/create_post`, account: { name: id, platform: 'Lemmy' }, flow: { id, name: id, engine: 'lemmy', revision: 1 },
        recipe: { ...EXTENSION_RECIPES.lemmy, languageSelectors: ['select#post-language'] }, autoSubmit: true, formFill: { enabled: true }, options: { tags: [], category: '' },
        post: { title: `Self-hosting notes ${id}`, body: 'Run the service behind Nginx and keep backups.\n\nSecond paragraph with the details for this post.', summary: '', maxChars: 10000, length: 97, language: 'en' } });
    }
    const origins = jobs.map(job => job.targetOrigin);
    const answerFor = controls => {
      const community = controls.find(control => control.kind === 'combobox' && control.options?.some(option => option.label === 'technology'));
      const rules = controls.find(control => control.kind === 'checkbox' && /rules/i.test(control.label ?? ''));
      return [{ index: community.index, selector: community.selector, action: 'select', value: 'technology' }, { index: rules.index, selector: rules.selector, action: 'check' }];
    };
    const apiUrl = await serve(async (request, response) => {
      const body = await readBody(request);
      const route = request.url.replace('/api/v1/extension/agent/', '');
      if (route === 'heartbeat') return json(response, { success: true, data: { waiting: jobs.length, origins, device: { name: 'Form-fill Chrome' } } });
      if (route === 'claim') {
        const payload = JSON.parse(body); claimRequests.push(payload);
        const index = jobs.findIndex(job => !(payload.excludeOrigins ?? []).includes(job.targetOrigin));
        return json(response, { success: true, data: { task: index < 0 ? null : jobs.splice(index, 1)[0] } });
      }
      const [, jobId, action, hintId] = /^tasks\/([^/]+)\/([^/]+)(?:\/([^/]+))?$/.exec(route) ?? [];
      if (action === 'form-fill' && request.method === 'POST') {
        const payload = JSON.parse(body); formFillRequests.push({ jobId, ...payload });
        if (jobId === 'lemmy-unsure') return json(response, { success: true, data: { hintId: 'h-unsure', status: 'READY', actions: [], errorCode: 'LOW_CONFIDENCE' } });
        return json(response, { success: true, data: { hintId: 'h-ai', status: 'RUNNING' } });
      }
      if (action === 'form-fill' && request.method === 'GET') {
        const asked = formFillRequests.find(item => item.jobId === jobId);
        return json(response, { success: true, data: { hintId, status: 'READY', confidence: 0.9, actions: answerFor(asked.controls) } });
      }
      if (action === 'result') {
        const payload = JSON.parse(body);
        // Like the backend DTO: unknown fields are refused.
        if (Object.keys(payload).some(key => !RESULT_FIELDS.includes(key))) { rejected.push(payload); return json(response, { success: false, error: { message: 'property should not exist' } }, 400); }
        reports.push({ jobId, ...payload });
        return json(response, { success: true, data: {} });
      }
      return json(response, { success: true, data: {} });
    });

    context = await chromium.launchPersistentContext(path.join(workspace, 'profile'), {
      executablePath: chromium.executablePath(), headless: true,
      args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
    });
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const controller = await context.newPage();
    await controller.goto(`chrome-extension://${new URL(worker.url()).host}/diagnostics.html`);
    await worker.evaluate(apiUrl => chrome.storage.local.set({ apiUrl, token: 'local-only' }), apiUrl);
    for (let i = 0; i < 120 && reports.length < 2; i++) {
      await controller.evaluate(() => chrome.runtime.sendMessage({ type: 'tick-now' }));
      await new Promise(resolve => setTimeout(resolve, 500));
    }

    assert.deepEqual(rejected, [], 'every report has only accepted fields');
    assert.equal(reports.length, 2, JSON.stringify(reports));
    const ai = reports.find(report => report.jobId === 'lemmy-ai');
    assert.deepEqual([ai.outcome, ai.url], ['PUBLISHED', `${origins[0]}/post/123`]);
    const unsure = reports.find(report => report.jobId === 'lemmy-unsure');
    assert.deepEqual([unsure.outcome, unsure.reason, unsure.message], ['NEEDS_ACTION', 'WAITING_USER', 'AI chưa điền chắc chắn các mục bắt buộc; mở tab để kiểm và bấm Đăng.']);

    assert.deepEqual(posted, [{ id: 'lemmy-ai', title: 'Self-hosting notes lemmy-ai', body: 'Run the service behind Nginx and keep backups.\n\nSecond paragraph with the details for this post.', community: 'technology', language: '37', rules: true }]);
    assert.ok(claimRequests[1].excludeOrigins.includes(origins[0]), 'the second site was claimed while the first flow ran');
    assert.deepEqual(formFillRequests.map(request => request.jobId).sort(), ['lemmy-ai', 'lemmy-unsure']);
    for (const request of formFillRequests) {
      const text = JSON.stringify(request.controls);
      assert.ok(!text.includes('csrf-secret') && !text.includes('Self-hosting notes'), 'no hidden values or post text are described');
      assert.ok(request.controls.length >= 3 && request.controls.length <= 60);
      assert.equal(request.url, `${request.jobId === 'lemmy-ai' ? origins[0] : origins[1]}/create_post`);
    }
    const { tasks } = await worker.evaluate(() => chrome.storage.session.get('tasks'));
    const left = Object.values(tasks);
    assert.deepEqual(left.map(task => [task.job.jobId, task.phase]), [['lemmy-unsure', 'waitingUser']], 'the uncertain draft waits for the operator');
    assert.equal(left[0].formFillRounds, 1);
  } finally {
    await context?.close();
    for (const server of servers) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    const resolved = path.resolve(workspace);
    assert.ok(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep + 'social-formfill-test-'));
    fs.rmSync(resolved, { recursive: true, force: true });
  }
});
