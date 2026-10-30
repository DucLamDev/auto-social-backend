// Loads the packaged MV3 extension with localhost fixtures, never live accounts.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { test } = require('node:test');
const { chromium } = require('playwright');
const { EXTENSION_RECIPES } = require('../../src/connectors/extension/extension-delivery.ts');

test('MV3 publishes Substack web-only and transfers a managed Pixelfed image without leaking the device token', { timeout: 75_000 }, async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'social-mv3-fixture-'));
  const extensionPath = path.join(workspace, 'extension');
  fs.cpSync(path.join(__dirname, '../../browser-extension'), extensionPath, { recursive: true });
  const manifestPath = path.join(extensionPath, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.host_permissions = ['http://127.0.0.1/*']; delete manifest.optional_host_permissions;
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  const servers = [], queue = [], reports = [], posts = [], mediaRequests = [], platformHeaders = [];
  const token = 'fixture-device-token-keep-in-worker';
  const photoBytes = Buffer.from('fixture-photo-from-managed-storage');
  const serve = async handler => {
    const server = http.createServer(handler); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    servers.push(server); return `http://127.0.0.1:${server.address().port}`;
  };
  const json = (res, data) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
  let context;
  try {
    for (const engine of ['substack', 'pixelfed']) {
      const origin = await serve(async (req, res) => {
        platformHeaders.push(req.headers.authorization);
        if (req.url === '/record') {
          let body = ''; for await (const chunk of req) body += chunk;
          posts.push({ engine, ...JSON.parse(body) }); json(res, {}); return;
        }
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(`<!doctype html>${engine === 'substack'
          ? '<section id="editor"><input placeholder="Title"><div class="ProseMirror" contenteditable="true"></div><button id="continue">Continue</button></section><section id="confirmation" hidden><label><input id="email" type="checkbox" checked>Send via email and Substack app inbox</label><button id="publish">Publish</button></section>'
          : '<div class="compose-modal-component"><input type="file" id="pf-dz"><textarea placeholder="Write a caption..."></textarea><button id="publish">Post</button></div>'}
          <script>
          let model, photo;
          ${engine === 'substack' ? `document.querySelector('#continue').onclick = () => {
            model = {title:document.querySelector('input[placeholder]').value,body:document.querySelector('[contenteditable]').innerText};
            document.querySelector('#editor').hidden = true; document.querySelector('#confirmation').hidden = false;
          };` : `document.querySelector('#pf-dz').oninput = async event => { photo = await event.target.files[0].text(); };`}
          document.querySelector('#publish').onclick = async () => {
            ${engine === 'substack' ? `model.email = document.querySelector('#email').checked;` : `model = { body: document.querySelector('textarea').value, photo };`}
            await fetch('/record', { method:'POST',body:JSON.stringify(model) });
            ${engine === 'substack'
              ? `document.body.innerHTML = '<h1 class="post-title"></h1><div class="body markup"></div>'; document.querySelector('h1').textContent = model.title; document.querySelector('.body').textContent = model.body; history.pushState({},'', '/p/approved-web-post');`
              : `document.body.innerHTML = '<article class="status"><div class="post-caption"></div><a href="/p/writer/12345">Open</a></article>'; document.querySelector('.post-caption').textContent = model.body;`}
          };
          </script>`);
      });
      queue.push({ jobId: engine, targetOrigin: origin, openUrl: origin + '/compose', recipe: EXTENSION_RECIPES[engine],
        account: { name: engine, platform: engine }, autoSubmit: true, options: { tags: [], sendEmail: false },
        post: { title: `Web title ${engine}`, body: `Approved web content for ${engine}.` },
        media: engine === 'pixelfed' ? [{ id: 'photo-1', sizeBytes: photoBytes.length, mimeType: 'image/png' }] : [],
      });
    }
    const apiUrl = await serve(async (req, res) => {
      let body = ''; for await (const chunk of req) body += chunk;
      let data = {};
      if (req.url.endsWith('/heartbeat')) data = { waiting: queue.length, origins: queue.map(job => job.targetOrigin), device: { name: 'Fixture Chrome' } };
      if (req.url.endsWith('/claim')) {
        const request = JSON.parse(body); assert.ok(request.supportedEngines.includes('substack')); assert.ok(request.supportedEngines.includes('pixelfed'));
        const index = queue.findIndex(job => !request.excludeOrigins.includes(job.targetOrigin));
        data = { task: index < 0 ? null : queue.splice(index, 1)[0] };
      }
      if (req.url.includes('/media/')) {
        mediaRequests.push({ url: req.url, method: req.method, authorization: req.headers.authorization });
        data = { name: 'photo.png', mimeType: 'image/png', sizeBytes: photoBytes.length, base64: photoBytes.toString('base64') };
      }
      if (req.url.endsWith('/result')) reports.push({ jobId: req.url.split('/tasks/')[1].split('/')[0], ...JSON.parse(body) });
      json(res, { success: true, data });
    });
    context = await chromium.launchPersistentContext(path.join(workspace, 'profile'), { executablePath: chromium.executablePath(), headless: true,
      args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`] });
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    await worker.evaluate(({ apiUrl, token }) => chrome.storage.local.set({ apiUrl, token }), { apiUrl, token });
    for (let i = 0; i < 120 && reports.filter(report => report.outcome === 'PUBLISHED').length < 2; i++) await new Promise(resolve => setTimeout(resolve, 500));
    assert.deepEqual(reports.map(report => [report.jobId, report.outcome]).sort(), [['pixelfed', 'PUBLISHED'], ['substack', 'PUBLISHED']]);
    assert.equal(posts.length, 2);
    assert.equal(posts.find(post => post.engine === 'substack').email, false);
    assert.equal(posts.find(post => post.engine === 'pixelfed').photo, photoBytes.toString());
    assert.deepEqual(mediaRequests, [{ url: '/api/v1/extension/agent/tasks/pixelfed/media/photo-1', method: 'GET', authorization: `Bearer ${token}` }]);
    assert.ok(platformHeaders.every(header => header === undefined));
    const storage = await worker.evaluate(() => chrome.storage.session.get('tasks'));
    assert.equal(JSON.stringify(storage).includes(photoBytes.toString('base64')), false);
    assert.equal(JSON.stringify(posts).includes(token), false);
    assert.ok(context.pages().every(page => !page.url().includes('/popup.html')));
  } finally {
    await context?.close();
    for (const server of servers) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    assert.ok(path.resolve(workspace).startsWith(path.resolve(os.tmpdir()) + path.sep + 'social-mv3-fixture-'));
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});
