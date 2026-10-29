// Diễn đàn giả lập cho kiểm thử tiện ích: XenForo, Discourse, phpBB tối giản.
// "Đăng nhập" bằng cookie forum_user (mở /login-as để giả lập người dùng đã đăng nhập sẵn trong Chrome).
import http from 'node:http';
import { writeFileSync } from 'node:fs';

const port = Number(process.argv[2] ?? 3922);
const statePath = process.argv[3];
const threads = [];
const page = (title, body) => `<!doctype html><html lang="vi"><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`;
const esc = (text) => String(text).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const loggedIn = (req) => /(?:^|;\s*)forum_user=demo/.test(req.headers.cookie ?? '');
const save = () => statePath && writeFileSync(statePath, JSON.stringify(threads, null, 2));

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk) => { data += chunk; });
    req.on('end', () => resolve(new URLSearchParams(data)));
  });
}

const xenforoForm = (captcha) => page('Post thread', `
  <h1>Đăng chủ đề mới</h1>
  <form action="/forums/hosting.12/post-thread" method="post">
    <input name="title" placeholder="Tiêu đề">
    <div class="js-editor"><div class="fr-wrapper"><div class="fr-element" contenteditable="true"></div></div></div>
    <textarea name="message_html" hidden></textarea>
    ${captcha ? '<div class="g-recaptcha" style="width:300px;height:70px;background:#eee">CAPTCHA</div>' : ''}
    <button type="submit" class="button--primary button--icon--write">Đăng chủ đề</button>
  </form>
  <script>
    document.querySelector('form').addEventListener('submit', () => {
      document.querySelector('[name=message_html]').value = document.querySelector('.fr-element').innerHTML;
    });
  </script>`);

const discourseApp = page('Discourse', `
  <header><span class="current-user">demo</span></header>
  <main id="app">Đang tải…</main>
  <script>
    setTimeout(() => {
      document.getElementById('app').innerHTML = '<div id="reply-control"><input id="reply-title"><textarea class="d-editor-input"></textarea><div class="save-or-cancel"><button class="btn-primary create">Tạo chủ đề</button></div></div>';
      document.querySelector('button.create').addEventListener('click', async () => {
        const response = await fetch('/discourse/posts', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ title: document.getElementById('reply-title').value, raw: document.querySelector('.d-editor-input').value }) });
        const { id, slug } = await response.json();
        history.pushState({}, '', '/t/' + slug + '/' + id);
        document.getElementById('app').innerHTML = '<h1>' + document.getElementById('reply-title')?.value + '</h1>';
      });
    }, 700);
  </script>`);

const phpbbForm = page('Post a new topic', `
  <form id="postform" method="post" action="/posting.php?mode=post&amp;f=3">
    <input name="subject"><textarea name="message"></textarea>
    <input type="submit" name="post" value="Submit">
  </form>`);

const loginPage = (engine) => page('Log in', engine === 'discourse'
  ? '<header><button class="login-button">Log In</button></header>'
  : engine === 'phpbb'
    ? '<form id="login"><input name="username"></form>'
    : '<form action="/login/login" method="post"><input name="login"></form>');

function addThread(engine, title, body) {
  const id = threads.length + 101;
  const slug = title.toLowerCase().normalize('NFD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'chu-de';
  threads.push({ id, engine, title, body, slug, at: new Date().toISOString() });
  save();
  return { id, slug };
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const send = (status, html, headers = {}) => { res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', ...headers }); res.end(html); };
  if (url.pathname === '/login-as') return send(200, page('ok', 'Đã đăng nhập demo'), { 'set-cookie': 'forum_user=demo; Path=/' });
  if (url.pathname === '/api/threads') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify(threads)); }

  // XenForo
  if (url.pathname === '/forums/hosting.12/post-thread' && req.method === 'GET') {
    return loggedIn(req) ? send(200, xenforoForm(url.searchParams.has('captcha'))) : send(200, loginPage('xenforo'));
  }
  if (url.pathname === '/forums/hosting.12/post-thread' && req.method === 'POST') {
    const form = await readBody(req);
    if (!form.get('title')?.trim()) return send(200, page('Lỗi', '<div class="blockMessage--error">Vui lòng nhập tiêu đề</div>'));
    const { id, slug } = addThread('xenforo', form.get('title'), form.get('message_html'));
    return send(303, '', { location: `/threads/${slug}.${id}/` });
  }
  const xfThread = /^\/threads\/[^/]+\.(\d+)\/$/.exec(url.pathname);
  if (xfThread) {
    const thread = threads.find((item) => item.id === Number(xfThread[1]));
    return send(200, page(thread?.title ?? '?', `<h1 class="p-title-value">${esc(thread?.title ?? '')}</h1><article>${thread?.body ?? ''}</article>`));
  }

  // Discourse
  if (url.pathname === '/discourse/new-topic' || url.pathname === '/new-topic') {
    return loggedIn(req) ? send(200, discourseApp) : send(200, loginPage('discourse'));
  }
  if (url.pathname === '/discourse/posts' && req.method === 'POST') {
    const form = await readBody(req);
    const created = addThread('discourse', form.get('title'), form.get('raw'));
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(created));
  }
  if (/^\/t\/[^/]+\/\d+/.test(url.pathname)) return send(200, discourseApp);

  // phpBB
  if (url.pathname === '/posting.php' && req.method === 'GET') return loggedIn(req) ? send(200, phpbbForm) : send(200, loginPage('phpbb'));
  if (url.pathname === '/posting.php' && req.method === 'POST') {
    const form = await readBody(req);
    const { id } = addThread('phpbb', form.get('subject'), form.get('message'));
    return send(302, '', { location: `/viewtopic.php?f=3&t=${id}` });
  }
  if (url.pathname === '/viewtopic.php') {
    const thread = threads.find((item) => item.id === Number(url.searchParams.get('t')));
    return send(200, page(thread?.title ?? '?', `<h2>${esc(thread?.title ?? '')}</h2><div>${esc(thread?.body ?? '')}</div>`));
  }
  send(404, page('404', 'Không có trang'));
}).listen(port, '127.0.0.1', () => console.log(`fake forum on ${port}`));
