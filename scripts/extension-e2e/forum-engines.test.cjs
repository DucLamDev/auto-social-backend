// Invision Community (Unraid), Flarum (aaPanel) and Zendesk community (cPanel), rebuilt
// from their public markup and open-source form helpers. Every request is intercepted;
// these tests never reach the real sites.
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
const post = { title: 'Docker containers stop after an unclean shutdown', body: 'After a power cut the array came back but two containers stayed stopped.\n\nChecking the container logs showed a stale lock file.', bodyHtml: '<p>After a power cut the array came back but two containers stayed stopped.</p><p>Checking the container logs showed a stale lock file.</p>' };
const jobFor = (page, engine, extra = {}) => ({ targetOrigin: new URL(page.url()).origin, openUrl: page.url(), autoSubmit: true, recipe: EXTENSION_RECIPES[engine], post, options: {}, ...extra });
// A topic page the forum shows once the new post exists.
const published = (path, titleHtml, bodyHtml) => `history.pushState({}, '', ${JSON.stringify(path)}); document.body.innerHTML = ${JSON.stringify(titleHtml)} + ${JSON.stringify(bodyHtml)};`
  + 'document.querySelector("[data-title]").textContent = window.sent.title; document.querySelector("[data-body]").textContent = window.sent.body;';

// forums.unraid.net/forum/55-general-support/?do=add: Invision's form (topic_title, the
// editor's contenteditable, Submit Topic). Guests get the same form with an email field.
const invisionPage = ({ guest = false } = {}) => `<!doctype html><body><form method="post" action="/forum/55-general-support/?do=add">
${guest ? '<p>You can post now and register later.</p><input type="email" name="guest_email">' : ''}
<input type="text" name="topic_title" id="elInput_topic_title" maxlength="255">
<div class="ipsComposeArea"><div class="cke_wysiwyg_div" contenteditable="true"><p><br></p></div></div>
<button type="submit" class="ipsButton ipsButton_primary">Submit Topic</button></form>
<script>
  window.sent = null;
  document.querySelector('form').addEventListener('submit', event => {
    event.preventDefault();
    window.sent = { title: document.querySelector('[name=topic_title]').value, body: document.querySelector('[contenteditable]').innerText, html: document.querySelector('[contenteditable]').innerHTML };
    ${published('/topic/200300-docker-containers-stop-after-an-unclean-shutdown/', '<h1 class="ipsType_pageTitle" data-title></h1>', '<div data-role="commentContent" data-body></div>')}
  });
</script></body>`;

test('Invision (Unraid): writes the title and the formatted body, presses Submit Topic once and finds the new topic', async () => {
  const page = await browser.newPage();
  try {
    await open(page, 'https://forums.unraid.net/forum/55-general-support/?do=add', invisionPage());
    const job = jobFor(page, 'invision');
    const result = await page.evaluate(fill, job);
    assert.equal(result.status, 'submitted', result.message);
    const sent = await page.evaluate(() => window.sent);
    assert.equal(sent.title, post.title);
    assert.match(sent.html, /<p>After a power cut/);
    assert.equal(await page.evaluate(read, { job, beforeUrls: result.beforeUrls }), 'https://forums.unraid.net/topic/200300-docker-containers-stop-after-an-unclean-shutdown/');
  } finally { await page.close(); }
});

test('Invision (Unraid): the guest form (email field) means signed out, and nothing is written', async () => {
  const page = await browser.newPage();
  try {
    await open(page, 'https://forums.unraid.net/forum/55-general-support/?do=add', invisionPage({ guest: true }));
    const result = await page.evaluate(fill, jobFor(page, 'invision'));
    assert.equal(result.status, 'login');
    assert.equal(await page.locator('[name=topic_title]').inputValue(), '');
    assert.equal(await page.evaluate(() => window.sent), null);
  } finally { await page.close(); }
});

// www.aapanel.com/forum/t/general: "Start a Discussion" opens the composer (title input,
// Markdown textarea, Post Discussion). Without a tag Flarum asks for one in a modal.
const flarumPage = ({ tagPreset = true } = {}) => `<!doctype html><body><header class="App-header"><ul class="Header-secondary"><li class="item-session"><span class="username">vpsttt</span></li></ul></header>
<main><button class="Button Button--primary IndexPage-newDiscussion" type="button">Start a Discussion</button></main>
<script>
  window.sent = null; window.tags = ${tagPreset ? "['General']" : '[]'};
  const post = () => {
    window.sent = { title: document.querySelector('.item-discussionTitle input').value, body: document.querySelector('textarea.TextEditor-editor').value, tags: window.tags };
    ${published('/forum/d/26300-docker-containers-stop-after-an-unclean-shutdown', '<h1 class="DiscussionHero-title" data-title></h1>', '<div class="PostStream-item"><div class="Post-body" data-body></div></div>')}
  };
  document.querySelector('.IndexPage-newDiscussion').addEventListener('click', () => {
    document.body.insertAdjacentHTML('beforeend', '<div class="Composer"><div class="ComposerBody"><ul class="ComposerBody-header"><li class="item-discussionTitle"><h3><input class="FormControl" placeholder="Discussion Title"></h3></li></ul>'
      + '<div class="TextEditor"><textarea class="FormControl Composer-flexible TextEditor-editor"></textarea><ul class="TextEditor-controls"><li class="item-submit"><button class="Button Button--primary" type="button">Post Discussion</button></li></ul></div></div></div>');
    document.querySelector('.item-submit button').addEventListener('click', () => {
      if (window.tags.length) return post();
      document.body.insertAdjacentHTML('beforeend', '<div class="Modal TagDiscussionModal"><form><ul class="TagSelectionModal-list"><li class="SelectTagListItem"><span class="SelectTagListItem-name">Support</span></li><li class="SelectTagListItem"><span class="SelectTagListItem-name">General</span></li></ul><button type="submit" class="Button Button--primary">Post Discussion</button></form></div>');
      for (const row of document.querySelectorAll('.SelectTagListItem')) row.addEventListener('click', () => { window.tags = [row.innerText.trim()]; });
      document.querySelector('.TagDiscussionModal form').addEventListener('submit', event => { event.preventDefault(); if (window.tags.length) { document.querySelector('.TagDiscussionModal').remove(); post(); } });
    });
  });
</script></body>`;

test('Flarum (aaPanel): opens Start a Discussion from the tag page, writes the Markdown post, posts once and finds the discussion', async () => {
  const page = await browser.newPage();
  try {
    await open(page, 'https://www.aapanel.com/forum/t/general', flarumPage());
    const job = jobFor(page, 'flarum');
    const result = await page.evaluate(fill, job);
    assert.equal(result.status, 'submitted', result.message);
    const sent = await page.evaluate(() => window.sent);
    assert.equal(sent.title, post.title);
    assert.equal(sent.body, post.body);
    assert.equal(await page.evaluate(read, { job, beforeUrls: result.beforeUrls }), 'https://www.aapanel.com/forum/d/26300-docker-containers-stop-after-an-unclean-shutdown');
  } finally { await page.close(); }
});

test('Flarum (aaPanel): when Flarum asks for a tag, picks the account category (General by default) and confirms', async () => {
  const page = await browser.newPage();
  try {
    await open(page, 'https://www.aapanel.com/forum', flarumPage({ tagPreset: false }));
    const result = await page.evaluate(fill, jobFor(page, 'flarum'));
    assert.equal(result.status, 'submitted', result.message);
    assert.deepEqual((await page.evaluate(() => window.sent)).tags, ['General']);
  } finally { await page.close(); }
});

// support.cpanel.net/hc/en-us/community/posts/new: Zendesk's form helpers (title, CKEditor 5
// details over a hidden textarea, a topic select hidden behind Zendesk's dropdown, Submit).
const zendeskPage = `<!doctype html><body><form id="new_community_post" class="new_community_post" action="/hc/en-us/community/posts" method="post">
<input type="text" name="community_post[title]" id="community_post_title">
<textarea name="community_post[details]" id="community_post_details" style="display:none"></textarea>
<div class="ck ck-editor"><div class="ck-editor__editable ck-content" contenteditable="true"><p><br></p></div></div>
<select name="community_post[topic_id]" id="community_post_topic_id" style="display:none"><option value="">-</option><option value="101">General Discussion</option><option value="102">Security</option></select>
<input type="submit" name="commit" value="Submit"></form>
<script>
  window.sent = null;
  document.querySelector('form').addEventListener('submit', event => {
    event.preventDefault();
    window.sent = { title: document.querySelector('#community_post_title').value, body: document.querySelector('[contenteditable]').innerText, topic: document.querySelector('select').value };
    ${published('/hc/en-us/community/posts/360001-docker-containers-stop', '<h1 class="post-title" data-title></h1>', '<div class="post-body" data-body></div>')}
  });
</script></body>`;

test('Zendesk (cPanel): chooses the topic by name, writes the post, presses Submit once and finds the new post', async () => {
  const page = await browser.newPage();
  try {
    await open(page, 'https://support.cpanel.net/hc/en-us/community/posts/new', zendeskPage);
    const job = jobFor(page, 'zendesk', { options: { category: 'Security' } });
    const result = await page.evaluate(fill, job);
    assert.equal(result.status, 'submitted', result.message);
    const sent = await page.evaluate(() => window.sent);
    assert.equal(sent.topic, '102');
    assert.equal(sent.title, post.title);
    assert.equal(await page.evaluate(read, { job, beforeUrls: result.beforeUrls }), 'https://support.cpanel.net/hc/en-us/community/posts/360001-docker-containers-stop');
  } finally { await page.close(); }
});

test('Zendesk (cPanel): without a topic it asks for one before writing anything', async () => {
  const page = await browser.newPage();
  try {
    await open(page, 'https://support.cpanel.net/hc/en-us/community/posts/new', zendeskPage);
    const result = await page.evaluate(fill, jobFor(page, 'zendesk'));
    assert.equal(result.status, 'filled');
    assert.match(result.message, /topic/);
    assert.equal(await page.locator('#community_post_title').inputValue(), '');
    assert.equal(await page.evaluate(() => window.sent), null);
  } finally { await page.close(); }
});
