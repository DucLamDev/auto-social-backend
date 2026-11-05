// Composers rebuilt from public web bundles / open-source markup (Ubiquiti Community,
// Linux Foundation Forum, Blogger, Hugging Face). Every request is intercepted; these
// tests never reach the real services.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const { EXTENSION_RECIPES } = require('../../src/connectors/extension/extension-delivery.ts');

let browser, fill, read;
before(async () => {
  const source = fs.readFileSync(path.join(__dirname, '../../browser-extension/social-actions.js'), 'utf8');
  const actions = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
  fill = actions.fillSocialAndSubmit; read = actions.readSocialPublishedPost;
  browser = await chromium.launch();
});
after(async () => browser?.close());

async function open(page, url, body) {
  await page.route('**/*', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body }));
  await page.goto(url);
}
const beforeUrls = page => page.evaluate(() => [...document.querySelectorAll('a[href]')].map(node => node.href));

// community.ui.com/questions/create: title (10-200), TipTap body (>= 25 characters of
// text), one required topic button; Publish replaces the URL with /questions/<slug>/<uuid>.
const ubiquitiPage = `<!doctype html><body><main><h1>Ask a question</h1>
<div data-uic-component="TextInput.Root"><input data-uic-component="TextInput.Field" placeholder="Start with a descriptive title"></div>
<div class="topics">${['Network', 'Protect', 'General', 'UISP'].map(name => `<button type="button"><span data-uic-component="Text">${name}</span></button>`).join('')}</div>
<div class="tiptap-text-block"><div class="ProseMirror" contenteditable="true" role="textbox"><p class="is-empty" data-placeholder="Please describe your issue in detail"><br></p></div></div>
<button type="button" aria-label="Images">Images</button><button type="button">Cancel</button>
<button type="button" data-uic-component="Button">Publish</button></main>
<script>
  window.publishes = 0;
  for (const button of document.querySelectorAll('.topics button')) button.addEventListener('click', () => { window.topic = button.innerText; });
  document.querySelector('[data-uic-component=Button]').addEventListener('click', () => {
    window.publishes++;
    const title = document.querySelector('input').value.trim(), body = document.querySelector('.ProseMirror').innerText.trim();
    if (title.length < 10 || title.length > 200 || body.length < 25 || !window.topic) return;
    window.created = { title, body, html: document.querySelector('.ProseMirror').innerHTML, topic: window.topic };
    history.replaceState({}, '', '/questions/' + title.replace(/[.:/]/g, '-').replace(/[^A-Za-z0-9-]/g, '').slice(0, 99) + '/0b8f2f7e-4a1c-4f7a-9a51-3d2c6b7e9f10');
    document.querySelector('main').innerHTML = '<span data-uic-component="Text" style="font-weight:bold"></span><div class="question-body"></div>';
    document.querySelector('main span').textContent = title; document.querySelector('.question-body').textContent = body;
  });
</script></body>`;
const ubiquitiJob = (page, extra = {}) => ({
  targetOrigin: 'https://community.ui.com', openUrl: page.url(), autoSubmit: true, recipe: EXTENSION_RECIPES.ubiquiti,
  post: { title: 'Hosting the UniFi Network Server on a small VPS', body: 'We moved our UniFi Network Server to a 2 GB VPS.\n\n- Adoption over L3 with set-inform\n- Port 8080 and 3478 open', bodyHtml: '<p>We moved our UniFi Network Server to a 2 GB VPS.</p><ul><li>Adoption over L3 with set-inform</li><li>Port 8080 and 3478 open</li></ul>' },
  options: { tags: ['unifi'], suggestedTags: [], category: '' }, ...extra,
});

test('Ubiquiti Community: picks the General topic by default, writes title and formatted body, publishes once and confirms the new question', async () => {
  const page = await browser.newPage();
  try {
    await open(page, 'https://community.ui.com/questions/create', ubiquitiPage);
    const job = ubiquitiJob(page);
    const urls = await beforeUrls(page);
    const result = await page.evaluate(fill, job);
    assert.equal(result.status, 'submitted', result.message);
    assert.equal(await page.evaluate(() => window.publishes), 1);
    const created = await page.evaluate(() => window.created);
    assert.equal(created.topic, 'General');
    assert.equal(created.title, job.post.title);
    assert.match(created.html, /<li>Adoption over L3 with set-inform<\/li>/);
    assert.equal(await page.evaluate(read, { job, beforeUrls: urls }), 'https://community.ui.com/questions/HostingtheUniFiNetworkServeronasmallVPS/0b8f2f7e-4a1c-4f7a-9a51-3d2c6b7e9f10');
  } finally { await page.close(); }
});

test('Ubiquiti Community: uses the configured topic, and stops before writing when that topic does not exist', async () => {
  const page = await browser.newPage();
  try {
    await open(page, 'https://community.ui.com/questions/create', ubiquitiPage);
    let result = await page.evaluate(fill, ubiquitiJob(page, { options: { tags: [], suggestedTags: [], category: 'network' } }));
    assert.equal(result.status, 'submitted', result.message);
    assert.equal((await page.evaluate(() => window.created)).topic, 'Network');

    await open(page, 'https://community.ui.com/questions/create', ubiquitiPage);
    result = await page.evaluate(fill, ubiquitiJob(page, { options: { tags: [], suggestedTags: [], category: 'Wireless' } }));
    assert.equal(result.status, 'filled');
    assert.match(result.message, /chủ đề “Wireless”/);
    assert.equal(await page.locator('input').inputValue(), '');
    assert.equal(await page.evaluate(() => window.publishes), 0);
  } finally { await page.close(); }
});

// huggingface.co/posts?post=true: the "New Post" dialog posts its form to /posts and
// the browser lands on /posts/<user>/<id>. /api/posts/can-post says who may post.
const hfPage = `<!doctype html><body><main><h1>Posts</h1><button class="btn">New Post</button>
<dialog open><h2>New Post</h2><a href="/new-blog">Write an Article</a><form method="post" action="/posts"><input type="hidden" name="csrf" value="token">
<textarea name="content" maxlength="2000" placeholder="Share an update with the community..."></textarea><input type="file" multiple hidden>
<button type="submit" class="btn">Post</button></form></dialog></main>
<script>
  window.posts = 0;
  document.querySelector('form').addEventListener('submit', event => {
    event.preventDefault(); window.posts++;
    const text = document.querySelector('textarea').value;
    history.pushState({}, '', '/posts/vpsttt/859068804838402');
    document.body.innerHTML = '<main><div data-target="SocialPost"><div class="break-words px-4"></div></div><a href="/posts/someone/123456789012345">Other post</a></main>';
    document.querySelector('.break-words').textContent = text;
  });
</script></body>`;
async function openHf(page, canPost) {
  await page.route('**/*', route => new URL(route.request().url()).pathname === '/api/posts/can-post'
    ? route.fulfill({ json: canPost }) : route.fulfill({ contentType: 'text/html; charset=utf-8', body: hfPage }));
  await page.goto('https://huggingface.co/posts?post=true');
}
const hfJob = (page, extra = {}) => ({
  targetOrigin: 'https://huggingface.co', openUrl: page.url(), autoSubmit: true, recipe: EXTENSION_RECIPES.huggingface,
  post: { title: '', body: 'Serving a 7B model on a 16 GB VPS: 4-bit weights and `--max-model-len 4096` kept it under 11 GB.' }, options: {}, ...extra,
});

test('Hugging Face Posts: checks the right to post, writes the post in the New Post dialog, posts once and confirms it', async () => {
  const page = await browser.newPage();
  try {
    await openHf(page, { canPost: true });
    const job = hfJob(page);
    const urls = await beforeUrls(page);
    const result = await page.evaluate(fill, job);
    assert.equal(result.status, 'submitted', result.message);
    assert.equal(await page.evaluate(() => window.posts), 1);
    assert.equal(await page.evaluate(read, { job, beforeUrls: urls }), 'https://huggingface.co/posts/vpsttt/859068804838402');
  } finally { await page.close(); }
});

test('Hugging Face Posts: an account Hugging Face does not let post is reported with its reason, nothing is written', async () => {
  const page = await browser.newPage();
  try {
    await openHf(page, { canPost: false, reason: 'Posts are available to PRO users' });
    const result = await page.evaluate(fill, hfJob(page));
    assert.equal(result.status, 'restricted');
    assert.match(result.message, /Posts are available to PRO users/);
    assert.equal(await page.locator('textarea').inputValue(), '');
  } finally { await page.close(); }
});

// www.blogger.com: "New Post" creates a draft and opens /blog/post/edit/<blog>/<post>
// with a designMode iframe; Publish ("Đăng") asks to confirm, then the post list shows
// a "View" link to the post on <blog>.blogspot.com.
const bloggerPage = `<!doctype html><body><nav><div jsname="UOx8F" role="button" aria-label="Tạo bài đăng mới">Bài đăng mới</div></nav>
<main id="list"><div class="row"><span>An older post</span><a jsname="X9tL0d" target="_blank" href="https://vpsttt.blogspot.com/2026/10/an-older-post.html">Xem</a></div></main>
<script>
  window.created = [];
  const list = () => document.querySelector('#list');
  document.querySelector('[jsname=UOx8F]').addEventListener('click', () => {
    history.pushState({}, '', '/blog/post/edit/6753539875398087695/111');
    list().innerHTML = '<div jsname="r4nke"><input jsname="YPqjbf" type="text" aria-label="Tiêu đề"></div><iframe class="editable" style="width:600px;height:300px"></iframe>'
      + '<div jsname="TKrYR" role="button" aria-label="Preview post">Xem trước</div><div jsname="vdQQuc" role="button" aria-label="Publish">Đăng</div>';
    const doc = document.querySelector('iframe').contentDocument;
    doc.open(); doc.write('<!doctype html><html><body class="editable" g_editable="true"><br></body></html>'); doc.close(); doc.designMode = 'on';
    document.querySelector('[jsname=TKrYR]').addEventListener('click', () => { window.preview = true; });
    document.querySelector('[jsname=vdQQuc]').addEventListener('click', () => {
      document.body.insertAdjacentHTML('beforeend', '<div role="dialog"><h2>Xuất bản bài đăng?</h2><div jsname="LgbsSe" data-id="IbE0S" role="button">Hủy</div><div jsname="LgbsSe" data-id="EBS5u" role="button">Xác nhận</div></div>');
      document.querySelector('[data-id=EBS5u]').addEventListener('click', () => {
        window.created.push({ title: document.querySelector('[jsname=r4nke] input').value, html: document.querySelector('iframe').contentDocument.body.innerHTML });
        document.querySelector('[role=dialog]').remove();
        history.pushState({}, '', '/blog/posts/6753539875398087695');
        list().innerHTML = '<div class="row"><span></span><a jsname="X9tL0d" target="_blank" href="https://vpsttt.blogspot.com/2026/11/keeping-small-vps-patched.html">Xem</a></div>'
          + '<div class="row"><span>An older post</span><a jsname="X9tL0d" target="_blank" href="https://vpsttt.blogspot.com/2026/10/an-older-post.html">Xem</a></div>';
        list().querySelector('span').textContent = window.created[0].title;
      });
    });
  });
</script></body>`;
const bloggerJob = (page, extra = {}) => ({
  targetOrigin: 'https://www.blogger.com', openUrl: page.url(), autoSubmit: true, recipe: EXTENSION_RECIPES.blogger,
  post: { title: 'Keeping a small VPS patched', body: 'Security updates daily, kernel reboots on Sunday.\n\n- unattended-upgrades\n- needrestart', bodyHtml: '<p>Security updates daily, kernel reboots on Sunday.</p><ul><li>unattended-upgrades</li><li>needrestart</li></ul>' },
  options: {}, ...extra,
});

test('Blogger: opens New Post, writes title and HTML body in the editor iframe, publishes and confirms once, then finds the new post link', async () => {
  const page = await browser.newPage();
  try {
    await open(page, 'https://www.blogger.com/blog/posts/_', bloggerPage);
    const job = bloggerJob(page);
    const result = await page.evaluate(fill, job);
    assert.equal(result.status, 'submitted', result.message);
    const created = await page.evaluate(() => window.created);
    assert.equal(created.length, 1);
    assert.equal(created[0].title, job.post.title);
    assert.match(created[0].html, /<li>unattended-upgrades<\/li>/);
    assert.equal(await page.evaluate(() => window.preview), undefined);
    assert.ok(result.beforeUrls.includes('https://vpsttt.blogspot.com/2026/10/an-older-post.html'));
    assert.equal(await page.evaluate(read, { job, beforeUrls: result.beforeUrls }), 'https://vpsttt.blogspot.com/2026/11/keeping-small-vps-patched.html');
  } finally { await page.close(); }
});

test('Blogger: stops before Publish when auto-submit is off', async () => {
  const page = await browser.newPage();
  try {
    await open(page, 'https://www.blogger.com/blog/posts/_', bloggerPage);
    const result = await page.evaluate(fill, bloggerJob(page, { autoSubmit: false }));
    assert.equal(result.status, 'filled');
    assert.deepEqual(await page.evaluate(() => window.created), []);
    assert.equal(await page.locator('[jsname=r4nke] input').inputValue(), 'Keeping a small VPS patched');
  } finally { await page.close(); }
});
