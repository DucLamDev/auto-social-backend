// All requests are intercepted locally, including POST. Never publishes online.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require('playwright');
let browser, submit, showNotice, readNotice;
const job = { jobId: 'test-job', targetOrigin: 'https://forum.test', openUrl: 'https://forum.test/community/new-topic', autoSubmit: true,
  recipe: { engine: 'discourse', captchaSelectors: ['.captcha'], successUrlPattern: '/t/[^/]+/\\d+$' },
  auth: { expectedUsername: 'alice' }, post: { title: 'A technical question', body: '## Context\n\nExact Markdown with `code`.' } };
before(async () => {
  const source = fs.readFileSync('browser-extension/discourse-session.js', 'utf8');
  submit = (await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)).submitDiscoursePost;
  const notice = await import(`data:text/javascript;base64,${Buffer.from(fs.readFileSync('browser-extension/publish-notice.js', 'utf8')).toString('base64')}`);
  showNotice = notice.showPublishNotice; readNotice = notice.readDiscourseReceiptNotice;
  browser = await chromium.launch();
});
after(async () => browser?.close());
async function fixture(overrides = {}) {
  const page = await browser.newPage(); const posts = [];
  const current = { id: 7, username: 'alice', can_create_topic: true, ...overrides.user };
  await page.route('**/*', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/posts.json')) {
      posts.push(new URLSearchParams(route.request().postData()));
      if (overrides.networkFailure) return route.abort();
      return route.fulfill({ status: overrides.status ?? 200, json: overrides.result ?? { success: true, post: { id: 101, topic_id: 42, post_number: 1 } } });
    }
    if (path.endsWith('/session/current.json')) return route.fulfill({ json: { current_user: current } });
    if (path.endsWith('/session/csrf.json')) return route.fulfill({ json: { csrf: 'test-only-token' } });
    if (path.endsWith('/site.json')) return route.fulfill({ json: { categories: overrides.categories ?? [{ id: 2, slug: 'general', name: 'General', permission: 1 }] } });
    if (path.endsWith('/posts/101.json')) return route.fulfill({ json: { id: 101, topic_id: 42, post_number: 1, username: 'alice', raw: overrides.savedBody ?? job.post.body } });
    if (path.endsWith('/t/42.json')) return route.fulfill({ json: { id: 42, slug: 'a-technical-question', title: job.post.title } });
    await route.fulfill({ contentType: 'text/html', body: overrides.html || '<main>No composer required</main>' });
  });
  await page.goto(job.openUrl);
  return { page, posts };
}

test('accepted receipt displays a dismissible result without changing the draft, clicking Post or sending network writes', async () => {
  const { page, posts } = await fixture({ html: '<input id="title" value="My unsent draft"><button id="post">Post</button>' });
  try {
    await page.evaluate(() => {
      document.getElementById('post').onclick = () => { window.clicked = true; };
      sessionStorage.setItem('vpsttt:discourse-submit:test-job', JSON.stringify({ status: 'moderation' }));
    });
    assert.equal(await page.evaluate(readNotice, ['other-job']), null);
    const notice = await page.evaluate(readNotice, [job.jobId]);
    assert.equal(await page.evaluate(showNotice, { ...notice, targetOrigin: 'https://other.test' }), false);
    await page.evaluate(showNotice, { ...notice, title: '<img src=x onerror=alert(1)>' });
    await page.evaluate(showNotice, notice);
    assert.equal(await page.locator('#vpsttt-publish-notice').count(), 1);
    assert.match(await page.getByRole('status').innerText(), /chờ diễn đàn duyệt/);
    assert.equal(await page.locator('#vpsttt-publish-notice img').count(), 0);
    assert.equal(await page.locator('#title').inputValue(), 'My unsent draft');
    assert.equal(await page.evaluate(() => !!window.clicked), false);
    assert.equal(posts.length, 0);
    await page.getByRole('button', { name: 'Đóng thông báo' }).click();
    assert.equal(await page.locator('#vpsttt-publish-notice').count(), 0);
  } finally { await page.close(); }
});
test('uses the current session, exact Markdown and allowed general category; verifies the published URL', async () => {
  const { page, posts } = await fixture();
  try {
    const result = await page.evaluate(submit, job);
    assert.deepEqual(result, { status: 'published', url: 'https://forum.test/community/t/a-technical-question/42' });
    assert.equal(posts.length, 1); assert.equal(posts[0].get('raw'), job.post.body); assert.equal(posts[0].get('category'), '2');
    assert.equal(posts[0].get('nested_post'), 'true');
    await page.evaluate(submit, job); assert.equal(posts.length, 1);
  } finally { await page.close(); }
});
test('requires the configured category and tags and does not silently substitute another category', async () => {
  const { page, posts } = await fixture({ categories: [{ id: 9, slug: 'projects', name: 'Projects', permission: 1 }, { id: 23, parent_category_id: 9, slug: 'nginx', name: 'NGINX', permission: 1, minimum_required_tags: 1 }] });
  try {
    const scoped = { ...job, options: { category: 'projects/nginx', tags: [] } };
    assert.equal((await page.evaluate(submit, scoped)).status, 'filled'); assert.equal(posts.length, 0);
    scoped.options.tags = ['web-server'];
    assert.equal((await page.evaluate(submit, scoped)).status, 'published');
    assert.equal(posts[0].get('category'), '23'); assert.deepEqual(posts[0].getAll('tags[]'), ['web-server']);
  } finally { await page.close(); }
});
for (const [name, overrides, status] of [
  ['moderation', { result: { success: true, action: 'enqueued' } }, 'moderation'],
  ['network lost after send', { networkFailure: true }, 'uncertain'],
  ['server error after send', { status: 500, result: { errors: ['Internal server error'] } }, 'uncertain'],
  ['unrelated saved content', { savedBody: 'Someone else wrote this' }, 'uncertain'],
  ['server validation', { status: 422, result: { errors: ['Category is invalid'] } }, 'rejected'],
  ['rate limit', { status: 429, result: { errors: ['Wait before posting again'] } }, 'rejected'],
]) test(`${name}: never falls back to clicking Post`, async () => {
  const { page, posts } = await fixture(overrides);
  try {
    assert.equal((await page.evaluate(submit, job)).status, status); assert.equal(posts.length, 1);
    if (status !== 'rejected') { assert.equal((await page.evaluate(submit, job)).status, status === 'moderation' ? 'moderation' : 'uncertain'); assert.equal(posts.length, 1); }
  } finally { await page.close(); }
});
for (const [name, overrides, patch, expected] of [
  ['account changed', { user: { username: 'bob' } }, {}, 'filled'],
  ['cannot create topics', { user: { can_create_topic: false } }, {}, 'restricted'],
  ['read-only category', { categories: [{ id: 2, name: 'General', permission: 2 }] }, { options: { category: '2' } }, 'restricted'],
  ['missing category', {}, { options: { category: 'unavailable' } }, 'filled'],
  ['manual mode', {}, { autoSubmit: false }, 'fallback'],
  ['captcha', { html: '<div class="captcha">Verify</div>' }, {}, 'captcha'],
]) test(`${name}: sends no POST`, async () => {
  const { page, posts } = await fixture(overrides);
  try { assert.equal((await page.evaluate(submit, { ...job, ...patch })).status, expected); assert.equal(posts.length, 0); }
  finally { await page.close(); }
});
test('parallel injections cannot send the same job twice', async () => {
  const { page, posts } = await fixture();
  try { await Promise.all([page.evaluate(submit, job), page.evaluate(submit, job)]); assert.equal(posts.length, 1); }
  finally { await page.close(); }
});
