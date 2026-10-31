const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require('playwright');
const { EXTENSION_RECIPES } = require('../../src/connectors/extension/extension-delivery.ts');
let browser, fill, read;
before(async () => {
  ({ fillSocialAndSubmit: fill, readSocialPublishedPost: read } = await import(`data:text/javascript;base64,${Buffer.from(fs.readFileSync('browser-extension/social-actions.js', 'utf8')).toString('base64')}`));
  browser = await chromium.launch({ headless: true });
});
after(async () => browser?.close());
async function pageAt(url) {
  const page = await browser.newPage();
  await page.route('**/*', r => r.fulfill({ contentType: 'text/html', body: '<main></main>' }));
  await page.goto(url); return page;
}
const post = { title: 'A specific technical question', body: 'Approved content from the web, with a reproducible problem and expected result.' };
test('Minds opens Compose, keeps My Channel, submits once and finds the new matching permalink', async () => {
  const page = await pageAt('https://www.minds.com/newsfeed/subscriptions');
  await page.evaluate(() => {
    window.submits = 0;
    document.body.innerHTML = '<button>Create</button><a href="/newsfeed/10">Old post</a>';
    document.querySelector('button').onclick = () => {
      document.body.insertAdjacentHTML('beforeend', '<m-composer__modal><span>My Channel</span><m-composer__textarea><textarea class="m-composerTextarea__message"></textarea></m-composer__textarea><button disabled>Post</button></m-composer__modal>');
      const modal = document.querySelector('m-composer__modal'), body = modal.querySelector('textarea'), submit = modal.querySelector('button');
      body.oninput = () => { submit.disabled = !body.value.trim(); };
      submit.onclick = () => { window.submits++; const text = body.value; modal.remove(); document.body.insertAdjacentHTML('beforeend', '<m-activity><m-activity__content></m-activity__content><a href="/newsfeed/123456">Open post</a></m-activity>'); document.querySelector('m-activity__content').textContent = text; };
    };
  });
  const job = { recipe: EXTENSION_RECIPES.minds, targetOrigin: 'https://www.minds.com', openUrl: page.url(), post, autoSubmit: true };
  const result = await page.evaluate(fill, job);
  assert.equal(result.status, 'submitted', JSON.stringify(result)); assert.equal(await page.evaluate(() => window.submits), 1);
  assert.equal(await page.evaluate(read, { job, beforeUrls: result.beforeUrls }), 'https://www.minds.com/newsfeed/123456');
  await page.close();
});
test('Minds refuses a group destination and preserves existing drafts', async () => {
  const page = await pageAt('https://www.minds.com/newsfeed/subscriptions');
  const job = { recipe: EXTENSION_RECIPES.minds, targetOrigin: 'https://www.minds.com', openUrl: page.url(), post, autoSubmit: true };
  await page.setContent('<m-composer__modal>Another Group<m-composer__textarea><textarea class="m-composerTextarea__message">Existing draft</textarea></m-composer__textarea><button>Post</button></m-composer__modal>');
  assert.equal((await page.evaluate(fill, job)).status, 'notReady');
  assert.equal(await page.locator('textarea').inputValue(), 'Existing draft');
  await page.close();
});
test('Stack Exchange fills tags, reviews, then submits exactly once', async () => {
  const page = await pageAt('https://serverfault.com/questions/ask');
  await page.evaluate(() => {
    window.steps = []; document.body.innerHTML = '<input id="title"><textarea id="wmd-input"></textarea><input id="tagnames"><button>Review your question</button><button id="final" hidden>Post your question</button>';
    document.querySelector('button').onclick = event => { window.steps.push('review'); event.target.hidden = true; document.querySelector('#final').hidden = false; };
    document.querySelector('#final').onclick = () => window.steps.push('post');
  });
  const result = await page.evaluate(fill, { recipe: EXTENSION_RECIPES.stackexchange, targetOrigin: 'https://serverfault.com', openUrl: page.url(), post, autoSubmit: true, options: { tags: ['nginx', 'linux'] } });
  assert.equal(result.status, 'submitted', JSON.stringify(result)); assert.deepEqual(await page.evaluate(() => window.steps), ['review', 'post']);
  assert.equal(await page.locator('#tagnames').inputValue(), 'nginx linux');
  assert.equal(await page.locator('#wmd-input').inputValue(), post.body);
  await page.close();
});
test('Stack Exchange does not publish without required tags', async () => {
  const page = await pageAt('https://serverfault.com/questions/ask');
  await page.setContent('<input id="title"><textarea id="wmd-input"></textarea><input id="tagnames"><button>Post your question</button>');
  const result = await page.evaluate(fill, { recipe: EXTENSION_RECIPES.stackexchange, targetOrigin: 'https://serverfault.com', openUrl: page.url(), post, autoSubmit: true });
  assert.equal(result.status, 'filled'); assert.match(result.message, /tag/); await page.close();
});

test('DZone opens More and submits to moderation without saving a draft or publishing directly', async () => {
  const page = await pageAt('https://dzone.com/content/article/post.html');
  await page.evaluate(() => {
    window.sent = 0; window.drafts = 0;
    document.body.innerHTML = '<textarea class="article-title" name="title"></textarea><textarea name="subtitle"></textarea><textarea id="meta-description-textarea"></textarea><div class="fr-element fr-view" contenteditable="true"></div><button id="draft">Save draft</button><button class="dropdown-toggle">More</button><ul class="dropdown-menu" hidden><li ng-click="s.save(true, false, false, true)">Submit to Moderation</li></ul>';
    document.querySelector('#draft').onclick = () => window.drafts++;
    document.querySelector('.dropdown-toggle').onclick = () => document.querySelector('ul').hidden = false;
    document.querySelector('li').onclick = () => window.sent++;
  });
  const result = await page.evaluate(fill, { recipe: EXTENSION_RECIPES.dzone, targetOrigin: 'https://dzone.com', post, autoSubmit: true });
  assert.equal(result.status, 'submitted', JSON.stringify(result));
  assert.deepEqual(await page.evaluate(() => [window.sent, window.drafts]), [1, 0]);
  await page.close();
});

test('Differ selects a keyword chip and clicks its unique Publish control', async () => {
  const page = await pageAt('https://differ.blog/new-story');
  await page.evaluate(() => {
    window.sent = 0;
    document.body.innerHTML = '<textarea name="title"></textarea><div contenteditable="true" aria-label="editable markdown"></div><input class="rs__input" role="combobox"><button>Publish</button><button id="post-submit-button">Publish</button>';
    document.querySelector('input').oninput = () => { const option = document.createElement('div'); option.setAttribute('role', 'option'); option.textContent = 'nginx'; document.body.append(option); option.onclick = () => { option.removeAttribute('role'); option.className = 'rs__multi-value'; }; };
    document.querySelector('#post-submit-button').onclick = () => window.sent++;
  });
  const result = await page.evaluate(fill, { recipe: EXTENSION_RECIPES.differ, targetOrigin: 'https://differ.blog', post, autoSubmit: true, options: { tags: ['nginx'] } });
  assert.equal(result.status, 'submitted', JSON.stringify(result)); assert.equal(await page.evaluate(() => window.sent), 1); await page.close();
});

for (const engine of ['lemmy', 'discuit']) test(`${engine} selects the configured community before publishing`, async () => {
  const origin = engine === 'lemmy' ? 'https://lemmy.world' : 'https://discuit.org';
  const page = await pageAt(origin + (engine === 'lemmy' ? '/create_post' : '/new'));
  await page.evaluate(engine => {
    window.sent = 0;
    document.body.innerHTML = engine === 'lemmy'
      ? '<form><textarea id="post-title"></textarea><textarea id="markdown-textarea-test"></textarea><button type="button" id="post-community">Choose community</button><div class="dropdown-menu" hidden><input><button type="button" class="dropdown-item">technology</button></div><button type="submit">Create</button></form>'
      : '<form class="page-new-form"><textarea class="page-new-post-title"></textarea><textarea class="page-new-post-body"></textarea><div class="page-new-select"><input></div><div class="page-new-select-suggest-item" hidden><div class="page-new-select-suggest-name">technology</div><div>10.6K members</div></div><button type="submit">Post</button></form>';
    document.querySelector('form').onsubmit = e => { e.preventDefault(); window.sent++; };
    if (engine === 'lemmy') { document.querySelector('#post-community').onclick = () => document.querySelector('.dropdown-menu').hidden = false; document.querySelector('.dropdown-item').onclick = () => { document.querySelector('#post-community').textContent = 'technology'; document.querySelector('.dropdown-menu').hidden = true; }; }
    else { document.querySelector('input').oninput = () => document.querySelector('.page-new-select-suggest-item').hidden = false; document.querySelector('.page-new-select-suggest-item').onclick = () => { document.querySelector('input').value = 'technology'; document.querySelector('.page-new-select-suggest-item').hidden = true; }; }
  }, engine);
  const result = await page.evaluate(fill, { recipe: EXTENSION_RECIPES[engine], targetOrigin: origin, post, autoSubmit: true, options: { category: 'technology' } });
  assert.equal(result.status, 'submitted', JSON.stringify(result)); assert.equal(await page.evaluate(() => window.sent), 1); await page.close();
});

test('LinkedIn supports its current ProseMirror composer and Vietnamese publish label', async () => {
  const page = await pageAt('https://www.linkedin.com/sharing/compose');
  await page.evaluate(() => { window.sent = 0; document.body.innerHTML = '<div class="tiptap ProseMirror" contenteditable="true" role="textbox"></div><button>Đăng bài</button>'; document.querySelector('button').onclick = () => window.sent++; });
  const result = await page.evaluate(fill, { recipe: EXTENSION_RECIPES.linkedin, targetOrigin: 'https://www.linkedin.com', post, autoSubmit: true });
  assert.equal(result.status, 'submitted', JSON.stringify(result)); assert.equal(await page.evaluate(() => window.sent), 1); await page.close();
});
