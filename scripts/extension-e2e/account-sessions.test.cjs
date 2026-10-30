// Real MV3, two isolated Chromium profiles, one website, separate login/TOTP.
// All credentials and pages here are local fixtures; never contacts live sites.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { test } = require('node:test');
const { chromium } = require('playwright');
const { EXTENSION_RECIPES } = require('../../src/connectors/extension/extension-delivery.ts');

for (const [provider, loginOnly] of [['password', false], ['google', false], ['google', true]]) test(`two Chrome profiles use ${provider} login + TOTP, loginOnly=${loginOnly}`, { timeout: 90_000 }, async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'account-sessions-fixture-'));
  const extensionPath = path.join(workspace, 'extension');
  fs.cpSync(path.join(__dirname, '../../browser-extension'), extensionPath, { recursive: true });
  const manifestPath = path.join(extensionPath, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.host_permissions = ['http://127.0.0.1/*', 'https://accounts.google.com/*']; delete manifest.optional_host_permissions;
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  const servers = [], contexts = [], workers = [], posts = [], reports = [], authRequests = [], platformAuthorization = [];
  const passwords = { alice: 'fixture-password-a', bob: 'fixture-password-b' };
  const codes = { alice: '123456', bob: '654321' };
  const queue = new Map();
  const json = (res, data, headers = {}) => { res.writeHead(200, { 'content-type': 'application/json', ...headers }); res.end(JSON.stringify(data)); };
  const html = (res, body) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<!doctype html>' + body); };
  const serve = async handler => { const server = http.createServer((req, res) => Promise.resolve(handler(req, res)).catch(error => { res.writeHead(500); res.end(error.message); }));
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); servers.push(server); return `http://127.0.0.1:${server.address().port}`; };
  const bodyOf = async req => { let body = ''; for await (const part of req) body += part; return body ? JSON.parse(body) : {}; };
  try {
    const forum = await serve(async (req, res) => {
      platformAuthorization.push(req.headers.authorization);
      const user = /(?:^|; )user=(\w+)/.exec(req.headers.cookie ?? '')?.[1];
      const pending = /(?:^|; )pending=(\w+)/.exec(req.headers.cookie ?? '')?.[1];
      if (req.url === '/oauth-complete') {
        const body = await bodyOf(req); assert.ok(passwords[body.user]);
        json(res, {}, { 'set-cookie': `user=${body.user}; HttpOnly; SameSite=Lax; Path=/` }); return;
      }
      if (req.url === '/credentials') {
        const body = await bodyOf(req); assert.equal(body.password, passwords[body.username]);
        json(res, {}, { 'set-cookie': `pending=${body.username}; HttpOnly; SameSite=Lax; Path=/` }); return;
      }
      if (req.url === '/verify') {
        const body = await bodyOf(req); assert.equal(body.code, codes[pending]);
        json(res, {}, { 'set-cookie': `user=${pending}; HttpOnly; SameSite=Lax; Path=/` }); return;
      }
      if (req.url === '/posted') { assert.ok(user); const body = await bodyOf(req); posts.push({ user, ...body }); json(res, {}); return; }
      if (!user && req.url === '/two-step') {
        html(res, '<h1>Authenticator code</h1><form action="/two-step"><input name="code" autocomplete="one-time-code"><button type="submit">Verify</button></form><script>document.querySelector("form").onsubmit=async e=>{e.preventDefault();await fetch("/verify",{method:"POST",body:JSON.stringify({code:document.querySelector("input").value})});location.href="/";};</script>'); return;
      }
      if (!user) {
        if (provider === 'google') {
          html(res, '<button onclick="window.open(\'https://accounts.google.com/fixture/choose\',\'oauth\')">Continue with Google</button><script>window.addEventListener("message",async event=>{if(event.origin!=="https://accounts.google.com"||!event.data.verified)return;await fetch("/oauth-complete",{method:"POST",body:JSON.stringify({user:event.data.user})});location.href="/";});</script>'); return;
        }
        html(res, '<form><input name="username" autocomplete="username"><input type="password"><button type="submit">Log in</button></form><script>document.querySelector("form").onsubmit=async e=>{e.preventDefault();await fetch("/credentials",{method:"POST",body:JSON.stringify({username:document.querySelector("input[name=username]").value,password:document.querySelector("input[type=password]").value})});location.href="/two-step";};</script>'); return;
      }
      html(res, `<nav><a class="p-navgroup-link--user"><span class="p-navgroup-linkText">${user}</span></a></nav>
        <form action="/forums/general.1/post-thread"><input name="title"><textarea name="message"></textarea><button type="submit" class="button--primary">Post thread</button></form>
        <script>document.querySelector('form').onsubmit=async e=>{e.preventDefault();const post={title:document.querySelector('input').value,body:document.querySelector('textarea').value};await fetch('/posted',{method:'POST',body:JSON.stringify(post)});document.querySelector('form').remove();const article=document.createElement('article');article.innerHTML='<h1 class="p-title-value"></h1><div class="message--post"><div class="message-body"><div class="bbWrapper"></div></div></div>';article.querySelector('h1').textContent=post.title;article.querySelector('.bbWrapper').textContent=post.body;document.body.append(article);history.pushState({},'', '/t/approved.${user === 'alice' ? 1 : 2}/');};</script>`);
    });
    for (const user of Object.keys(passwords)) queue.set(`token-${user}`, { jobId: `job-${user}`, deviceId: `device-${user}`,
      ...(loginOnly ? { kind: 'LOGIN_CHECK' } : {}), targetOrigin: forum, openUrl: forum + '/forums/general.1/post-thread', recipe: EXTENSION_RECIPES.xenforo, autoSubmit: true,
      account: { id: user, name: user, platform: 'Same forum' }, post: { title: `Approved post by ${user}`, body: `Separate approved content for ${user}.` },
      auth: { deviceId: `device-${user}`, provider, origin: forum, expectedUsername: user, profileUrl: '', identitySelector: '',
        autoLogin: true, autoTotp: true, loginUsername: provider === 'google' ? `${user}@example.test` : user, loginUrl: forum + '/login' } });
    const apiUrl = await serve(async (req, res) => {
      const token = req.headers.authorization?.replace('Bearer ', ''); const user = token?.replace('token-', '');
      assert.ok(passwords[user]); const body = await bodyOf(req); let data = {};
      if (req.url.endsWith('/heartbeat')) data = { loginChecks: loginOnly, waiting: queue.has(token) ? 1 : 0, origins: [forum], device: { id: `device-${user}`, name: user } };
      if (req.url.endsWith('/claim')) { if (!loginOnly) assert.equal(body.authProtocol, 1); else assert.ok(req.url.includes('/login-checks/')); data = { task: queue.get(token) ?? null }; queue.delete(token); }
      if (req.url.endsWith('/auth')) {
        assert.ok(req.url.includes(`/${loginOnly ? 'login-checks' : 'tasks'}/job-${user}/`)); authRequests.push({ user, step: body.step });
        assert.equal(new URL(body.pageUrl).origin, provider === 'google' ? 'https://accounts.google.com' : forum);
        data = body.step === 'totp' ? { code: codes[user], expiresAt: Date.now() + 25_000 } : { username: provider === 'google' ? `${user}@example.test` : user, password: passwords[user] };
      }
      if (req.url.endsWith('/result')) { assert.ok(req.url.includes(`/${loginOnly ? 'login-checks' : 'tasks'}/job-${user}/`)); reports.push({ user, ...body }); }
      json(res, { success: true, data });
    });
    for (const user of Object.keys(passwords)) {
      const context = await chromium.launchPersistentContext(path.join(workspace, `profile-${user}`), { executablePath: chromium.executablePath(), headless: true,
        args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`] });
      // Every Google request is intercepted; no real Google login or network call.
      await context.route('https://accounts.google.com/**', route => {
        const url = new URL(route.request().url()); const selected = url.searchParams.get('user'); let body = '';
        if (url.pathname.endsWith('/choose')) body = Object.keys(passwords).map(name => `<button data-identifier="${name}@example.test" onclick="location.href='/fixture/password?user=${name}'">${name}</button>`).join('');
        if (url.pathname.endsWith('/password')) body = `<span id="profileIdentifier">${selected}@example.test</span><input type="password"><div id="passwordNext"><button onclick="if(document.querySelector('input').value===${JSON.stringify(passwords[selected]).replaceAll('"', '&quot;')})location.href='/fixture/totp?user=${selected}'">Next</button></div>`;
        if (url.pathname.endsWith('/totp')) body = `<span id="profileIdentifier">${selected}@example.test</span><input id="totpPin" name="totpPin"><div id="totpNext"><button>Next</button></div><script>document.querySelector('button').onclick=()=>{if(document.querySelector('input').value!==${JSON.stringify(codes[selected])})return;window.opener.postMessage({verified:true,user:${JSON.stringify(selected)}},${JSON.stringify(forum)});window.close();};</script>`;
        return route.fulfill({ contentType: 'text/html', body: '<!doctype html>' + body });
      });
      contexts.push(context); const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker'); workers.push(worker);
      await worker.evaluate(({ apiUrl, token, loginOnly }) => chrome.storage.local.set({ apiUrl, token, loginChecksOnly: loginOnly }), { apiUrl, token: `token-${user}`, loginOnly });
    }
    for (let i = 0; i < 120 && reports.length < 2; i++) await new Promise(resolve => setTimeout(resolve, 500));
    const diagnostics = reports.some(report => report.outcome !== 'PUBLISHED') ? { reports, authRequests,
      pages: contexts.map(context => context.pages().map(page => page.url())),
      states: await Promise.all(workers.map(worker => worker.evaluate(async () => {
        const tasks = (await chrome.storage.session.get('tasks')).tasks ?? {};
        return Object.values(tasks).map(task => ({ phase: task.phase, authTabId: task.authTabId, authSteps: task.authSteps }));
      }))) } : reports;
    assert.deepEqual(reports.map(x => [x.user, x.outcome]).sort(), [['alice', loginOnly ? 'AUTHENTICATED' : 'PUBLISHED'], ['bob', loginOnly ? 'AUTHENTICATED' : 'PUBLISHED']], JSON.stringify(diagnostics));
    assert.deepEqual(posts.sort((a,b) => a.user.localeCompare(b.user)), loginOnly ? [] : Object.keys(passwords).map(user => ({ user, title: `Approved post by ${user}`, body: `Separate approved content for ${user}.` })));
    assert.deepEqual(authRequests.sort((a,b) => (a.user+a.step).localeCompare(b.user+b.step)), [{user:'alice',step:'password'},{user:'alice',step:'totp'},{user:'bob',step:'password'},{user:'bob',step:'totp'}]);
    for (const worker of workers) {
      const stored = JSON.stringify(await worker.evaluate(async () => ({ session: await chrome.storage.session.get(null), local: await chrome.storage.local.get(null) })));
      for (const secret of [...Object.values(passwords), ...Object.values(codes)]) assert.equal(stored.includes(secret), false);
    }
    assert.ok(platformAuthorization.every(value => value === undefined));
  } finally {
    for (const context of contexts) await context.close();
    for (const server of servers) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    assert.ok(path.resolve(workspace).startsWith(path.resolve(os.tmpdir()) + path.sep + 'account-sessions-fixture-'));
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});
