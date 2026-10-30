// Run: node --import tsx --test scripts/extension-e2e/loaded-extension.test.cjs
// Runs the actual MV3 worker, permissions and script injection against localhost.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { chromium } = require('playwright');
const { EXTENSION_RECIPES } = require('../../src/connectors/extension/extension-delivery.ts');

for (const tagAlreadySelected of [true, false]) {
test(`without opening the popup, the extension ${tagAlreadySelected ? 'takes a waiting post immediately after pairing' : 'polls a post launched from the web'}`, { timeout: 60_000 }, async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'social-extension-test-'));
  const extensionPath = path.join(workspace, 'extension');
  fs.cpSync(path.join(__dirname, '../../browser-extension'), extensionPath, { recursive: true });
  const manifestPath = path.join(extensionPath, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  // Only the test copy receives localhost permissions automatically.
  manifest.host_permissions = ['http://127.0.0.1/*'];
  delete manifest.optional_host_permissions;
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));

  const post = {
    title: 'Hướng dẫn NGINX cơ bản & reverse proxy',
    body: 'Nội dung đã duyệt trên web.\n\nserver {\n  listen 80;\n}\n\nSecond paragraph.',
  };
  const reports = [];
  const published = [];
  let receivedParams;
  let claimed = false;
  let queued = tagAlreadySelected;
  let heartbeats = 0;
  let baseUrl;
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, baseUrl);
    // This fixture specifically exercises the DOM fallback, not the session API.
    if (['/session/current.json', '/session/csrf.json', '/site.json'].includes(url.pathname)) {
      response.writeHead(404, { 'content-type': 'application/json' }); response.end('{}'); return;
    }
    if (url.pathname === '/slow.png') return; // never reaches a load-complete event
    if (url.pathname.startsWith('/api/')) {
      let body = '';
      for await (const chunk of request) body += chunk;
      let data = {};
      if (url.pathname.endsWith('/heartbeat')) { heartbeats++; data = { device: { name: 'Test Chrome' }, waiting: queued && !claimed ? 1 : 0, origins: [baseUrl] }; }
      if (url.pathname.endsWith('/claim')) {
        data = { task: claimed || !queued ? null : {
          jobId: 'approved-web-post', account: { name: 'Test account', platform: 'Discourse' },
          targetOrigin: baseUrl, openUrl: `${baseUrl}/new-topic?category=projects/nginx&tags=web-server`,
          autoSubmit: true, post, recipe: EXTENSION_RECIPES.discourse,
        } };
        claimed = true;
      }
      if (url.pathname.endsWith('/result')) reports.push(JSON.parse(body));
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ success: true, data }));
      return;
    }
    if (url.pathname === '/dashboard') {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end('<button id="publish" onclick="fetch(\'/publish-from-web\', {method:\'POST\'})">Launch campaign</button>');
      return;
    }
    if (url.pathname === '/publish-from-web') {
      queued = true;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{}');
      return;
    }
    if (url.pathname === '/submitted') {
      let body = '';
      for await (const chunk of request) body += chunk;
      published.push(JSON.parse(body));
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{}');
      return;
    }
    if (url.pathname === '/forum.js') {
      response.writeHead(200, { 'content-type': 'application/javascript' });
      response.end(`
        const title = document.querySelector('.reply-area .title-input input');
        const body = document.querySelector('.d-editor-input');
        // Simulate a restored draft ignoring the native URL prefill. Injection
        // must still transfer the approved title and body from the web task.
        title.value = '';
        body.value = 'Category template';
        const model = { title: title.value, body: body.value };
        const selectedTags = ${JSON.stringify(tagAlreadySelected ? ['web-server'] : [])};
        title.addEventListener('input', () => { model.title = title.value; });
        body.addEventListener('input', () => { model.body = body.value; });
        const chooser = document.querySelector('.mini-tag-chooser');
        const header = chooser.querySelector('.select-kit-header');
        const panel = chooser.querySelector('.select-kit-body');
        header.onclick = () => { panel.hidden = !panel.hidden; header.setAttribute('aria-expanded', String(!panel.hidden)); };
        chooser.querySelector('input').oninput = (event) => {
          const query = event.target.value;
          setTimeout(() => {
            chooser.querySelector('ul').replaceChildren();
            // Discourse excludes already-selected tags from its search results.
            if (query !== 'web-server' || selectedTags.includes(query)) return;
            const row = document.createElement('li');
            row.className = 'select-kit-row tag-row';
            row.dataset.name = 'web-server'; row.dataset.value = '47';
            row.textContent = 'web-server';
            row.onclick = () => {
              selectedTags.push('web-server');
              header.querySelector('.formatted-selection').textContent = selectedTags.join(', ');
            };
            chooser.querySelector('ul').append(row);
          }, 100);
        };
        history.replaceState({}, '', '/c/23');
        document.querySelector('button.create').onclick = async () => {
          await fetch('/submitted', { method: 'POST', body: JSON.stringify({ ...model, tags: selectedTags, readyState: document.readyState, unrelatedTitle: document.querySelector('#unrelated-title').value }) });
          const topic = document.createElement('div'); topic.id = 'topic-title';
          const heading = document.createElement('h1'); heading.textContent = model.title; topic.append(heading);
          const article = document.createElement('div'); article.className = 'topic-post';
          const cooked = document.createElement('div'); cooked.className = 'cooked'; cooked.textContent = model.body; article.append(cooked);
          document.querySelector('.reply-area').remove(); document.body.append(topic, article);
          history.pushState({}, '', '/t/approved-web-post/123');
        };
      `);
      return;
    }
    receivedParams = Object.fromEntries(url.searchParams);
    response.writeHead(200, {
      'content-type': 'text/html',
      'content-security-policy': "script-src 'self'; object-src 'none'; require-trusted-types-for 'script'",
    });
    response.end(`<!doctype html><input id="unrelated-title" placeholder="Title" value="Keep this search"><div class="reply-area" role="dialog">
      <div class="title-input"><input id="ember142" placeholder="Title"></div><textarea class="d-editor-input"></textarea>
      <div class="mini-tag-chooser"><button type="button" class="select-kit-header" aria-expanded="false"><span class="formatted-selection">${tagAlreadySelected ? 'web-server' : 'select at least 1 tag...'}</span></button>
        <div class="select-kit-body" hidden><div class="select-kit-filter"><input></div><ul></ul></div>
      </div>
      <button class="create">Create Topic</button>
    </div><script src="/forum.js" defer></script><img src="/slow.png">`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  let context;
  try {
    context = await chromium.launchPersistentContext(path.join(workspace, 'profile'), {
      executablePath: chromium.executablePath(), headless: true,
      args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
    });
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    await worker.evaluate(apiUrl => chrome.storage.local.set({ apiUrl, token: 'local-fixture-only' }), baseUrl);
    if (!tagAlreadySelected) {
      // Let the initial empty poll finish, then launch from the web. Only the
      // normal Chrome alarm may discover this newly queued job.
      for (let attempt = 0; attempt < 40 && !heartbeats; attempt++) await new Promise(resolve => setTimeout(resolve, 100));
      assert.ok(heartbeats > 0);
      const dashboard = await context.newPage();
      await dashboard.goto(`${baseUrl}/dashboard`);
      await dashboard.click('#publish');
    }
    for (let attempt = 0; attempt < 90 && !reports.some(report => report.outcome === 'PUBLISHED'); attempt++) {
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    assert.ok(reports.some(report => report.outcome === 'PUBLISHED'), 'automatic polling did not publish the queued web post');
    assert.equal(receivedParams.title, post.title);
    assert.equal(receivedParams.body, post.body);
    assert.equal(receivedParams.category, 'projects/nginx');
    assert.equal(receivedParams.tags, 'web-server');
    assert.deepEqual(published, [{ ...post, tags: ['web-server'], readyState: 'interactive', unrelatedTitle: 'Keep this search' }]);
    assert.equal(reports.filter(report => report.outcome === 'PUBLISHED').length, 1);
    assert.ok(context.pages().every(page => !page.url().includes('/popup.html')));
    assert.equal(published.length, 1);
    const { history } = await worker.evaluate(() => chrome.storage.local.get('history'));
    assert.ok(history.some(entry => entry.outcome === 'RECEIVED' && entry.message.includes(post.title)));
  } finally {
    await context?.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    const resolved = path.resolve(workspace);
    assert.ok(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep + 'social-extension-test-'));
    fs.rmSync(resolved, { recursive: true, force: true });
  }
});
}
