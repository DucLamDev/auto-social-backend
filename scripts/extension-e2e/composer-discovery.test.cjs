// Intercept all traffic: exercise composer discovery without publishing to real accounts.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const { EXTENSION_RECIPES } = require('../../src/connectors/extension/extension-delivery.ts');
let browser, fill;
const post = { title: 'Approved title', body: 'Approved content' };
before(async () => {
  const source = fs.readFileSync(path.join(__dirname, '../../browser-extension/social-actions.js'), 'utf8');
  fill = (await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)).fillSocialAndSubmit;
  browser = await chromium.launch();
});
after(async () => browser?.close());
async function fixture(t, engine, html) {
  const page = await browser.newPage();
  t.after(() => page.close());
  await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: html }));
  await page.goto('https://composer.test/new');
  await page.evaluate(() => {
    window.sent = [];
    document.addEventListener('click', event => { if (event.target.matches('button')) window.sent.push(event.target.id); });
  });
  return { page, job: { recipe: EXTENSION_RECIPES[engine], targetOrigin: 'https://composer.test', openUrl: page.url(), post, autoSubmit: true } };
}

test('Bluesky fills the active dialog without overwriting the feed reply editor', async t => {
  const { page, job } = await fixture(t, 'bluesky', '<div id="reply" class="tiptap" contenteditable="true" role="textbox">My unfinished reply</div><div role="dialog"><div id="body" class="tiptap" contenteditable="true" role="textbox"></div><button id="publish">Post</button></div>');
  assert.equal((await page.evaluate(fill, job)).status, 'submitted');
  assert.equal(await page.locator('#body').innerText(), post.body);
  assert.equal(await page.locator('#reply').innerText(), 'My unfinished reply');
  assert.deepEqual(await page.evaluate(() => window.sent), ['publish']);
});

test('DEV waits for a delayed title before filling the article', async t => {
  const { page, job } = await fixture(t, 'devto', '<form id="article-form"><textarea id="article_body_markdown"></textarea><button type="button" data-testid="publish-button" id="publish">Publish</button></form>');
  await page.evaluate(() => setTimeout(() => document.querySelector('form').insertAdjacentHTML('afterbegin', '<textarea id="article-form-title"></textarea>'), 300));
  assert.equal((await page.evaluate(fill, job)).status, 'submitted');
  assert.equal(await page.locator('#article-form-title').inputValue(), post.title);
});

test('Mastodon waits until its composer becomes writable', async t => {
  const { page, job } = await fixture(t, 'mastodon', '<textarea id="composer-text" readonly></textarea><button id="publish">Post</button>');
  await page.evaluate(() => {
    window.readonlyWrites = 0;
    const body = document.querySelector('textarea');
    body.addEventListener('input', () => { if (body.readOnly) window.readonlyWrites++; });
    setTimeout(() => { body.readOnly = false; }, 300);
  });
  assert.equal((await page.evaluate(fill, job)).status, 'submitted');
  assert.equal(await page.evaluate(() => window.readonlyWrites), 0);
});

test('Reddit selects the text tab before waiting for its editor', async t => {
  const { page, job } = await fixture(t, 'reddit', '<input name="title"><button role="tab" aria-selected="false" id="text">Text</button><button id="publish">Post</button>');
  await page.evaluate(() => document.querySelector('#text').onclick = event => {
    event.target.setAttribute('aria-selected', 'true');
    document.body.insertAdjacentHTML('beforeend', '<textarea name="text"></textarea>');
  });
  assert.equal((await page.evaluate(fill, job)).status, 'submitted');
  assert.equal(await page.locator('textarea').inputValue(), post.body);
  assert.deepEqual(await page.evaluate(() => window.sent), ['text', 'publish']);
});

test('A disabled composer submit does not fall back to a feed Post button', async t => {
  const { page, job } = await fixture(t, 'bluesky', '<button id="feed">Post</button><div role="dialog"><div data-testid="composerTextInput" contenteditable="true"></div><button data-testid="composerPublishBtn" id="publish" disabled>Post</button></div>');
  await page.evaluate(() => setTimeout(() => { document.querySelector('#publish').disabled = false; }, 900));
  assert.equal((await page.evaluate(fill, job)).status, 'submitted');
  assert.deepEqual(await page.evaluate(() => window.sent), ['publish']);
});

test('Submit lookup prefers its composer form over another form', async t => {
  const { page, job } = await fixture(t, 'reddit', '<form><input name="title"><textarea name="text"></textarea><button type="button" id="publish">Post</button></form><form><button type="button" id="reply">Post</button></form>');
  assert.equal((await page.evaluate(fill, job)).status, 'submitted');
  assert.deepEqual(await page.evaluate(() => window.sent), ['publish']);
});

test('A known disabled submit does not use another Post action in the same dialog', async t => {
  const { page, job } = await fixture(t, 'bluesky', '<div role="dialog"><div data-testid="composerTextInput" contenteditable="true"></div><button id="other">Post</button><button data-testid="composerPublishBtn" id="publish" disabled>Publish</button></div>');
  await page.evaluate(() => setTimeout(() => { document.querySelector('#publish').disabled = false; }, 900));
  assert.equal((await page.evaluate(fill, job)).status, 'submitted');
  assert.deepEqual(await page.evaluate(() => window.sent), ['publish']);
});

test('Ambiguous editors are not resolved through a broader fallback selector', async t => {
  const { page, job } = await fixture(t, 'bluesky', '<div data-testid="composerTextInput" contenteditable="true" role="textbox" id="body"></div><div data-testid="composerTextInput" contenteditable="true" id="other"></div><button id="publish">Post</button>');
  await page.evaluate(() => {
    window.earlyWrites = 0;
    document.querySelector('#body').addEventListener('input', () => { if (document.querySelector('#other')) window.earlyWrites++; });
    setTimeout(() => document.querySelector('#other').remove(), 300);
  });
  assert.equal((await page.evaluate(fill, job)).status, 'submitted');
  assert.equal(await page.evaluate(() => window.earlyWrites), 0);
});

test('Dry run fills the scoped composer without submitting', async t => {
  const { page, job } = await fixture(t, 'bluesky', '<div contenteditable="true" role="textbox">Existing reply</div><div role="dialog"><div id="body" contenteditable="true" role="textbox"></div><button id="publish">Post</button></div>');
  assert.equal((await page.evaluate(fill, { ...job, autoSubmit: false })).status, 'filled');
  assert.equal(await page.locator('#body').innerText(), post.body);
  assert.deepEqual(await page.evaluate(() => window.sent), []);
});

for (const [engine, html, selector] of [
  ['mastodon', '<textarea id="composer-text">Existing draft</textarea><button>Post</button>', '#composer-text'],
  ['bluesky', '<div contenteditable="true" data-testid="composerTextInput">Existing draft</div><button>Post</button>', '[contenteditable]'],
  ['devto', '<form id="article-form"><textarea id="article-form-title">Existing draft</textarea><textarea id="article_body_markdown"></textarea><button>Publish</button></form>', '#article-form-title'],
]) test(`${engine} preserves existing drafts before writing any field`, async t => {
  const { page, job } = await fixture(t, engine, html);
  assert.equal((await page.evaluate(fill, job)).status, 'notReady');
  assert.equal(await page.locator(selector).evaluate(node => node.value ?? node.innerText), 'Existing draft');
  assert.deepEqual(await page.evaluate(() => window.sent), []);
});

test('Editor and submit inside a shadow dialog take precedence over the page', async t => {
  const { page, job } = await fixture(t, 'bluesky', '<div contenteditable="true" role="textbox">Existing reply</div><div id="host"></div>');
  await page.evaluate(() => {
    const shadow = document.querySelector('#host').attachShadow({ mode: 'open' });
    shadow.innerHTML = '<div role="dialog"><div contenteditable="true" role="textbox"></div><button>Post</button></div>';
    shadow.querySelector('button').onclick = () => window.sent.push('shadow-publish');
  });
  assert.equal((await page.evaluate(fill, job)).status, 'submitted');
  assert.deepEqual(await page.evaluate(() => window.sent), ['shadow-publish']);
});
