// Intercept every request; these tests never publish on public services.
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
const fixtures = {
  mastodon: ['https://mastodon.social', '/@alice/123456789', '<form class="compose-form"><textarea class="autosuggest-textarea__textarea"></textarea><div class="compose-form__publish-button-wrapper"><button>Publish!</button></div></form>', '<article class="status"><div class="status__content"></div><a class="status__relative-time"></a></article>'],
  bluesky: ['https://bsky.app', '/profile/alice.bsky.social/post/abc123', '<div contenteditable="true" data-testid="composerTextInput"></div><button data-testid="composerPublishBtn">Post</button>', '<article data-testid="post"><div data-testid="postText"></div><a></a></article>'],
  tumblr: ['https://www.tumblr.com', '/alice/123456789', '<input placeholder="Title"><div contenteditable="true" aria-label="Post body"></div><button aria-label="Post">Post</button>', '<article><h1></h1><div class="post-content"></div></article>'],
  devto: ['https://dev.to', '/alice/hello-world-abc1', '<form id="article-form"><textarea id="article-form-title"></textarea><textarea id="article_body_markdown"></textarea><button type="submit">Publish</button></form>', '<article><h1 id="main-title"></h1><div id="article-body"></div></article>'],
};

test('Mastodon redesigned Vietnamese composer is filled and submitted exactly once with an old queued recipe', async () => {
  const page = await browser.newPage();
  try {
    await page.route('**/*', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<button>Soạn tút</button><textarea id="composer-text"></textarea><button id="send">Đăng</button>' }));
    await page.goto('https://mastodon.social/publish');
    await page.evaluate(() => { window.submits = 0; document.querySelector('#send').onclick = () => window.submits++; });
    const job = { targetOrigin: 'https://mastodon.social', openUrl: page.url(), autoSubmit: true,
      recipe: { ...EXTENSION_RECIPES.mastodon, bodySelectors: ['.compose-form textarea'] }, post: { title: '', body: 'Bài viết từ giao diện web.' } };
    assert.equal((await page.evaluate(fill, job)).status, 'submitted');
    assert.equal(await page.locator('#composer-text').inputValue(), job.post.body);
    assert.equal(await page.evaluate(() => window.submits), 1);
  } finally { await page.close(); }
});

test('DEV suspended account is reported without trying an editor or submitting', async () => {
  const page = await browser.newPage();
  try {
    await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: '<main><h1>Forbidden</h1>Your account has been suspended and has limited access.</main>' }));
    await page.goto('https://dev.to/new');
    const result = await page.evaluate(fill, { targetOrigin: 'https://dev.to', recipe: EXTENSION_RECIPES.devto, autoSubmit: true, post: { title: 'Title', body: 'Body' } });
    assert.equal(result.status, 'restricted');
  } finally { await page.close(); }
});

test('Mastodon confirms a recent exact own post via its API when /publish stays open, excluding older or different posts', async () => {
  const page = await browser.newPage();
  try {
    await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: '<textarea id="composer-text"></textarea>' }));
    await page.goto('https://mastodon.social/publish');
    const submittedAt = Date.now();
    const task = { submittedAt, job: { targetOrigin: 'https://mastodon.social', openUrl: page.url(), recipe: EXTENSION_RECIPES.mastodon, auth: { expectedUsername: 'alice' }, post: { title: '', body: 'Exact original text.\n\n#server' } } };
    await page.route('**/api/v1/accounts/lookup?*', route => route.fulfill({ json: { id: '7', acct: 'alice' } }));
    let status = { id: '123', account: { id: '7' }, created_at: new Date(submittedAt).toISOString(), url: 'https://mastodon.social/@alice/123', content: '<p>Exact original text.</p><p>#server</p>' };
    await page.route('**/api/v1/accounts/7/statuses?*', route => route.fulfill({ json: [status] }));
    assert.equal(await page.evaluate(read, task), status.url);
    const original = { ...status };
    for (const patch of [{ created_at: new Date(submittedAt - 60000).toISOString() }, { content: '<p>Different text</p>' }, { account: { id: '8' } }, { url: 'https://other.test/@alice/123' }]) {
      status = { ...original, ...patch }; assert.equal(await page.evaluate(read, task), null);
    }
    status = original; assert.equal(await page.evaluate(read, { ...task, submittedAt: undefined }), null);
  } finally { await page.close(); }
});
for (const [engine, [origin, permalink, editor, published]] of Object.entries(fixtures)) test(`${engine}: publishes once with exact content and requires a matching permalink`, async () => {
  const page = await browser.newPage();
  try {
    await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: editor }));
    await page.goto(origin + '/fixture');
    const job = { targetOrigin: origin, openUrl: page.url(), recipe: EXTENSION_RECIPES[engine], autoSubmit: true, post: { title: 'Example title', body: 'An original useful post from the website.' } };
    await page.evaluate(({ job, permalink, published }) => {
      window.submits = 0;
      document.querySelector('button').onclick = event => {
        event.preventDefault(); window.submits++;
        const bodies = document.querySelectorAll('textarea, [contenteditable]');
        window.sent = bodies[bodies.length - 1].value ?? bodies[bodies.length - 1].innerText;
        document.body.innerHTML = published;
        document.querySelector('h1')?.append(job.post.title);
        document.querySelector('.status__content, [data-testid="postText"], .post-content, #article-body').textContent = window.sent;
        const link = document.querySelector('a'); if (link) link.href = permalink;
        history.pushState({}, '', permalink);
      };
    }, { job, permalink, published });
    assert.equal((await page.evaluate(fill, job)).status, 'submitted');
    assert.deepEqual(await page.evaluate(() => ({ count: window.submits, body: window.sent })), { count: 1, body: job.post.body });
    assert.equal(await page.evaluate(read, { job, beforeUrls: [] }), origin + permalink);
    await page.evaluate(() => { document.querySelector('article').textContent = 'Unrelated post'; });
    assert.equal(await page.evaluate(read, { job, beforeUrls: [] }), null);
  } finally { await page.close(); }
});
