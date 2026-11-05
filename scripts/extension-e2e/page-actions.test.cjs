// Run: node --import tsx --test scripts/extension-e2e/page-actions.test.cjs
// All forum navigation is intercepted locally; these tests never publish online.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { before, after, test } = require('node:test');
const { chromium } = require('playwright');
const { EXTENSION_RECIPES } = require('../../src/connectors/extension/extension-delivery.ts');

let browser;
let fillAndSubmit;
let canFillPage;
let readModeration;
let readPublishedPost;
const editor = '<div id="reply-control"><input id="reply-title"><textarea class="d-editor-input"></textarea><button class="create" onclick="window.submits++">Create Topic</button></div>';
const task = {
  recipe: EXTENSION_RECIPES.discourse,
  autoSubmit: false,
  post: { title: 'A community topic', body: 'The complete body of the community topic.' },
};

before(async () => {
  const source = fs.readFileSync(path.join(__dirname, '../../browser-extension/page-actions.js'), 'utf8');
  ({ fillAndSubmit, canFillPage, readModeration, readPublishedPost } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`));
  browser = await chromium.launch({ headless: true });
});
after(async () => { await browser?.close(); });

for (const [engine, topicUrl, titleHtml, bodyHtml] of [
  ['discourse', '/t/new-topic/123', '<div id="topic-title"><h1>__TITLE__</h1></div>', '<div class="topic-post"><div class="cooked">__BODY__</div></div>'],
  ['xenforo', '/threads/new-topic.123/', '<h1 class="p-title-value">__TITLE__</h1>', '<article class="message--post"><div class="message-body"><div class="bbWrapper">__BODY__</div></div></article>'],
  ['phpbb', '/viewtopic.php?t=123', '<h2 class="topic-title">__TITLE__</h2>', '<div class="post"><div class="content">__BODY__</div></div>'],
  ['vanilla', '/discussion/123/a-community-topic/p1?new=1', '<div class="PageTitle"><h1>__TITLE__</h1></div>', '<div id="Discussion_123" class="Item ItemDiscussion"><div class="Message userContent">__BODY__</div></div>'],
]) test(`verifies ${engine} title and posted content before accepting a topic URL`, async () => {
  const page = await browser.newPage();
  try {
    const origin = 'http://forum.test';
    await page.route(`${origin}/**`, route => route.fulfill({ contentType: 'text/html', body: '<main></main>' }));
    await page.goto(origin + topicUrl);
    const candidate = { job: { recipe: EXTENSION_RECIPES[engine], targetOrigin: origin, post: task.post } };
    await page.setContent(titleHtml.replace('__TITLE__', 'Welcome to the forum') + bodyHtml.replace('__BODY__', task.post.body));
    assert.equal(await page.evaluate(readPublishedPost, candidate), null);
    await page.setContent(titleHtml.replace('__TITLE__', task.post.title) + bodyHtml.replace('__BODY__', 'An unrelated first post'));
    assert.equal(await page.evaluate(readPublishedPost, candidate), null);
    await page.setContent(titleHtml.replace('__TITLE__', task.post.title) + bodyHtml.replace('__BODY__', task.post.body));
    assert.equal(await page.evaluate(readPublishedPost, candidate), origin + topicUrl);
    candidate.job.targetOrigin = 'http://other.test';
    assert.equal(await page.evaluate(readPublishedPost, candidate), null);
  } finally { await page.close(); }
});

test('recognizes the received-post moderation dialog but not a quoted notice in the composer', async () => {
  const page = await browser.newPage();
  const notice = '<h2>Post Needs Approval</h2><p>We\'ve received your new post but it needs to be approved by a moderator before it will appear.</p><p>You have 1 post pending.</p>';
  try {
    await page.setContent(`<div id="reply-control" role="dialog">${notice}</div>`);
    assert.equal(await page.evaluate(readModeration, task.recipe), null);
    await page.setContent(`<div class="d-modal__container">${notice}</div>`);
    assert.match(await page.evaluate(readModeration, task.recipe), /quản trị viên duyệt/);
    await page.setContent(`<div class="d-modal__container" hidden>${notice}</div>`);
    assert.equal(await page.evaluate(readModeration, task.recipe), null);
  } finally { await page.close(); }
});

async function runForum(html, currentTask = task) {
  const page = await browser.newPage();
  try {
    await page.route('http://forum.test/**', (route) => route.fulfill({
      contentType: 'text/html',
      body: `<script>window.opens=0;window.submits=0;history.replaceState({},'', '/community/forums/categories');</script>${html}`,
    }));
    await page.goto('http://forum.test/community/forums/new-topic');
    const result = await page.evaluate(fillAndSubmit, currentTask);
    const state = await page.evaluate(() => ({
      opens: window.opens,
      submits: window.submits,
      title: document.querySelector('#reply-title, .reply-area .title-input input, #reply-control .title-input input')?.value,
      body: document.querySelector('.d-editor-input')?.value,
      ...(window.model ? { model: window.model } : {}),
      ...(window.tagSelections ? { tags: window.tagSelections } : {}),
      ...(document.querySelector('#unrelated-title') ? { unrelatedTitle: document.querySelector('#unrelated-title').value } : {}),
    }));
    return { result, state };
  } finally { await page.close(); }
}

test('Vanilla (Linux Foundation Forum): fills the classic discussion form, waits while the draft autosave disables Post Discussion, never presses Save Draft or Preview', async () => {
  const page = await browser.newPage();
  const form = `<div id="DiscussionForm"><form method="post" action="/post/discussion/system-management">
    <input type="hidden" name="TransientKey" value="t"><input type="hidden" name="CategoryID" value="1258"><input type="hidden" name="DraftID" value="">
    <label for="Form_Name">Discussion Title</label><input id="Form_Name" name="Name" class="InputBox BigInput" maxlength="250">
    <div class="bodybox-wrap"><div class="editor editor-format-markdown"></div><textarea id="Form_Body" name="Body" class="TextBox BodyBox js-bodybox" placeholder="Type your message"></textarea><input type="hidden" id="Form_Format" name="Format" value="Markdown"></div>
    <div class="Buttons"><a class="Button Cancel" href="/">Cancel</a><input type="submit" id="Form_Preview" name="Preview" value="Preview" class="Button PreviewButton"><input type="submit" id="Form_SaveDraft" name="Save Draft" value="Save Draft" class="Button DraftButton"><input type="submit" id="Form_PostDiscussion" name="Post Discussion" value="Post Discussion" class="Button Primary DiscussionButton"></div>
  </form></div>`;
  try {
    await page.route('https://forum.linuxfoundation.org/**', route => route.fulfill({ contentType: 'text/html', body: form }));
    await page.goto('https://forum.linuxfoundation.org/post/discussion/system-management');
    await page.evaluate(() => {
      window.pressed = [];
      const post = document.querySelector('#Form_PostDiscussion');
      // The draft autosave runs on input and disables Post Discussion for a moment.
      document.querySelector('#Form_Body').addEventListener('input', () => { post.disabled = true; setTimeout(() => { post.disabled = false; }, 1500); });
      document.querySelector('form').addEventListener('submit', event => { event.preventDefault(); window.pressed.push(event.submitter.value); window.sent = { name: document.querySelector('#Form_Name').value, body: document.querySelector('#Form_Body').value }; });
    });
    const job = { recipe: EXTENSION_RECIPES.vanilla, autoSubmit: true, post: { title: 'Keeping a small VPS patched without breaking services', body: '## What we do\n\n- `unattended-upgrades` for security only\n- reboot window on Sunday' } };
    assert.equal((await page.evaluate(fillAndSubmit, job)).status, 'submitted');
    assert.deepEqual(await page.evaluate(() => window.pressed), ['Post Discussion']);
    assert.deepEqual(await page.evaluate(() => window.sent), { name: job.post.title, body: job.post.body });
    // A held discussion replaces the form with Vanilla's notice.
    await page.setContent('<div id="Content"><div class="Info">Your discussion will appear after it is approved.</div></div>');
    assert.match(await page.evaluate(readModeration, EXTENSION_RECIPES.vanilla), /chờ quản trị viên duyệt/);
  } finally { await page.close(); }
});

test('opens a redirected Discourse composer once and waits for both fields', async () => {
  const { result, state } = await runForum(`
    <button id="create-topic">New Topic</button><main></main>
    <script>
      document.querySelector('#create-topic').onclick = () => {
        window.opens++;
        document.querySelector('main').innerHTML = '<div id="reply-control"><input id="reply-title"></div>';
        setTimeout(() => {
          document.querySelector('#reply-control').insertAdjacentHTML('beforeend', '<textarea class="d-editor-input"></textarea><button class="create" onclick="window.submits++">Create Topic</button>');
        }, 700);
      };
    </script>`);
  assert.equal(result.status, 'filled');
  assert.deepEqual(state, { opens: 1, submits: 0, title: task.post.title, body: task.post.body });
});

test('keeps an automatically opened composer and does not click New Topic again', async () => {
  const { result, state } = await runForum(`
    <button id="create-topic" onclick="window.opens++">New Topic</button><main></main>
    <script>setTimeout(() => { document.querySelector('main').innerHTML = ${JSON.stringify(editor)}; }, 300);</script>`);
  assert.equal(result.status, 'filled');
  assert.deepEqual(state, { opens: 0, submits: 0, title: task.post.title, body: task.post.body });
});

test('stops at a login prompt before opening or submitting anything', async () => {
  const { result, state } = await runForum('<header><button class="login-button">Log In</button></header><button id="create-topic" onclick="window.opens++">New Topic</button>');
  assert.equal(result.status, 'login');
  assert.equal(state.opens, 0);
  assert.equal(state.submits, 0);
});

test('does not click a disabled New Topic button', async () => {
  const { result, state } = await runForum('<button id="create-topic" aria-disabled="true" onclick="window.opens++">New Topic</button>');
  assert.equal(result.status, 'notReady');
  assert.equal(state.opens, 0);
  assert.equal(state.submits, 0);
});

test('submits the populated composer exactly once when auto-submit is enabled', async () => {
  const { result, state } = await runForum(editor, { ...task, autoSubmit: true });
  assert.equal(result.status, 'submitted');
  assert.deepEqual(state, { opens: 0, submits: 1, title: task.post.title, body: task.post.body });
});

test('fills a title with a generated ID inside the legacy composer and leaves unrelated inputs alone', async () => {
  const html = '<input id="unrelated-title" placeholder="Title" value="Keep this search">'
    + editor.replace('<input id="reply-title">', '<div class="title-input"><input id="ember139" placeholder="Title"></div>');
  const { result, state } = await runForum(html, { ...task, autoSubmit: true });
  assert.equal(result.status, 'submitted');
  assert.equal(state.title, task.post.title);
  assert.equal(state.body, task.post.body);
  assert.equal(state.unrelatedTitle, 'Keep this search');
  assert.equal(state.submits, 1);
});

test('does not combine a title outside the composer with its body or submit', async () => {
  const html = '<div class="title-input"><input id="unrelated-title" placeholder="Title" value="Keep this search"></div>'
    + '<div class="reply-area" role="dialog"><textarea class="d-editor-input">Category template</textarea><button class="create" onclick="window.submits++">Create Topic</button></div>';
  const { result, state } = await runForum(html, { ...task, autoSubmit: true });
  assert.equal(result.status, 'notReady');
  assert.equal(state.unrelatedTitle, 'Keep this search');
  assert.equal(state.body, 'Category template');
  assert.equal(state.submits, 0);
});

const tags = `
  <div class="mini-tag-chooser">
    <button class="select-kit-header" aria-expanded="false" type="button">select at least 1 tag...</button>
    <div class="select-kit-body" hidden><div class="select-kit-filter"><input></div><ul></ul></div>
  </div>
  <script>
    window.tagSelections = [];
    const chooser = document.querySelector('.mini-tag-chooser');
    const header = chooser.querySelector('.select-kit-header');
    const panel = chooser.querySelector('.select-kit-body');
    header.onclick = () => { panel.hidden = !panel.hidden; header.setAttribute('aria-expanded', String(!panel.hidden)); };
    chooser.querySelector('input').oninput = (event) => {
      const value = event.target.value;
      setTimeout(() => {
        chooser.querySelector('ul').innerHTML = value === 'nginx-open-source'
          ? '<li class="select-kit-row tag-chooser-row" data-name="nginx-open-source" data-value="42"><span class="discourse-tag">nginx-open-source</span></li>'
          : '<li class="select-kit-row is-create" data-name="' + value + '">Create tag</li>';
        const row = chooser.querySelector('.tag-chooser-row');
        if (row) row.onclick = () => {
          window.tagSelections.push('nginx-open-source');
          header.innerHTML = '<span class="selected-name" data-name="nginx-open-source">nginx-open-source</span>';
        };
      }, 200);
    };
  </script>`;

test('fills a dialog without legacy IDs, switches to Markdown and selects tags before submitting', async () => {
  const { result, state } = await runForum(`
    <div class="reply-area" role="dialog">
      <div class="title-input"><input id="ember142" placeholder="Title"></div>
      <button class="composer-toggle-switch" data-rich-editor="true" aria-checked="true" type="button">Markdown</button>
      <div class="ProseMirror" contenteditable="true"><p>Category troubleshooting template</p></div>
      <button class="create" onclick="window.submits++;window.model.submittedBody=window.model.body;">Create Topic</button>
      ${tags}
    </div>
    <script>
      window.model={body:'Category troubleshooting template'};
      const toggle=document.querySelector('.composer-toggle-switch');
      toggle.onclick=()=>{
        toggle.setAttribute('aria-checked','false'); toggle.setAttribute('data-rich-editor','false');
        setTimeout(()=>{
          const textarea=document.createElement('textarea'); textarea.className='d-editor-input';
          textarea.value=window.model.body;
          textarea.oninput=()=>{window.model.body=textarea.value;};
          document.querySelector('.ProseMirror').replaceWith(textarea);
        },100);
      };
    </script>`, { ...task, autoSubmit: true, openUrl: 'http://forum.test/new-topic?category=projects/nginx&tags=nginx-open-source' });
  assert.equal(result.status, 'submitted');
  assert.equal(state.title, task.post.title);
  assert.equal(state.body, task.post.body);
  assert.equal(state.model.body, task.post.body);
  assert.equal(state.model.submittedBody, task.post.body);
  assert.deepEqual(state.tags, ['nginx-open-source']);
  assert.equal(state.submits, 1);
});

test('uses an AI suggested tag the category lists when no tag was configured, skipping one it does not list', async () => {
  const { result, state } = await runForum(editor.replace('</div>', `${tags}</div>`),
    { ...task, autoSubmit: true, options: { tags: [], suggestedTags: ['made-up', 'nginx-open-source'] } });
  assert.equal(result.status, 'submitted', JSON.stringify(result));
  assert.deepEqual(state.tags, ['nginx-open-source']);
  assert.equal(state.submits, 1);
});

test('never creates a tag from an AI suggestion; a required tag still waits for the operator', async () => {
  const { result, state } = await runForum(editor.replace('</div>', `${tags}</div>`),
    { ...task, autoSubmit: true, options: { tags: [], suggestedTags: ['made-up'] } });
  assert.equal(result.status, 'filled');
  assert.match(result.message, /tag AI gợi ý \(made-up\) không có trong danh sách/);
  assert.deepEqual(state.tags, []);
  assert.equal(state.submits, 0);
});

test('fills the post but waits for a required tag when none was configured', async () => {
  const { result, state } = await runForum(editor.replace('</div>', `${tags}</div>`), { ...task, autoSubmit: true });
  assert.equal(result.status, 'filled');
  assert.match(result.message, /tag/);
  assert.equal(state.body, task.post.body);
  assert.equal(state.submits, 0);
});

test('does not create an unknown tag or submit when the requested tag is unavailable', async () => {
  const { result, state } = await runForum(editor.replace('</div>', `${tags}</div>`), {
    ...task, autoSubmit: true, openUrl: 'http://forum.test/new-topic?tags=unknown-tag',
  });
  assert.equal(result.status, 'filled');
  assert.match(result.message, /unknown-tag/);
  assert.deepEqual(state.tags, []);
  assert.equal(state.submits, 0);
});

test('selects configured tags while respecting auto-submit being disabled', async () => {
  const { result, state } = await runForum(editor.replace('</div>', `${tags}</div>`), {
    ...task, openUrl: 'http://forum.test/new-topic?tags=nginx-open-source',
  });
  assert.equal(result.status, 'filled');
  assert.deepEqual(state.tags, ['nginx-open-source']);
  assert.equal(state.submits, 0);
});

test('recognizes preselected URL tags without adding or selecting them again', async () => {
  const selected = tags.replace('select at least 1 tag...', '<span class="selected-name" data-name="nginx-open-source">nginx-open-source</span>');
  const { result, state } = await runForum(editor.replace('</div>', `${selected}</div>`), {
    ...task, autoSubmit: true, openUrl: 'http://forum.test/new-topic?tags=nginx-open-source',
  });
  assert.equal(result.status, 'submitted');
  assert.deepEqual(state.tags, []);
  assert.equal(state.submits, 1);
});

test('recognizes comma-separated formatted-selection tags before searching for tags already excluded from results', async () => {
  const selected = tags.replace('select at least 1 tag...', '<span class="formatted-selection"> config, web-server </span>');
  const { result, state } = await runForum(editor.replace('</div>', `${selected}</div>`), {
    ...task, autoSubmit: true, openUrl: 'http://forum.test/new-topic?tags=web-server,config',
  });
  assert.equal(result.status, 'submitted');
  assert.deepEqual(state.tags, []);
  assert.equal(state.submits, 1);
});

test('selects the modern tag-row option and verifies formatted-selection before submitting', async () => {
  const modern = tags.replaceAll('nginx-open-source', 'web-server')
    .replaceAll('tag-chooser-row', 'tag-row')
    .replace('<span class="selected-name" data-name="web-server">web-server</span>', '<span class="formatted-selection">web-server</span>');
  const { result, state } = await runForum(editor.replace('</div>', `${modern}</div>`), {
    ...task, autoSubmit: true, openUrl: 'http://forum.test/new-topic?tags=web-server',
  });
  assert.equal(result.status, 'submitted');
  assert.deepEqual(state.tags, ['web-server']);
  assert.equal(state.submits, 1);
});

test('does not submit if selecting a tag changes the body to another template', async () => {
  const changed = tags.replace("window.tagSelections.push('nginx-open-source');", "window.tagSelections.push('nginx-open-source');document.querySelector('.d-editor-input').value='Another category template';");
  const { result, state } = await runForum(editor.replace('</div>', `${changed}</div>`), {
    ...task, autoSubmit: true, openUrl: 'http://forum.test/new-topic?tags=nginx-open-source',
  });
  assert.equal(result.status, 'filled');
  assert.equal(state.submits, 0);
});

test('detects an editable composer before slow resources finish loading and rejects a different origin', async () => {
  const page = await browser.newPage();
  try {
    await page.route('http://forum.test/slow.png', () => {});
    await page.route('http://forum.test/new-topic', route => route.fulfill({ contentType: 'text/html', body: editor + '<img src="/slow.png">' }));
    await page.goto('http://forum.test/new-topic', { waitUntil: 'domcontentloaded' });
    assert.notEqual(await page.evaluate(() => document.readyState), 'complete');
    await page.addScriptTag({ content: `window.canFillPage = ${canFillPage.toString()};` });
    assert.equal(await page.evaluate(recipe => window.canFillPage(recipe, 'http://forum.test'), task.recipe), true);
    assert.equal(await page.evaluate(recipe => window.canFillPage(recipe, 'http://other.test'), task.recipe), false);
  } finally { await page.close(); }
});

test('detects a shadow DOM composer while other resources are still loading', async () => {
  const page = await browser.newPage();
  try {
    await page.route('http://forum.test/slow.png', () => {});
    await page.route('http://forum.test/new-topic', route => route.fulfill({ contentType: 'text/html', body: '<div id="host"></div><img src="/slow.png">' }));
    await page.goto('http://forum.test/new-topic', { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => { document.querySelector('#host').attachShadow({ mode: 'open' }).innerHTML = '<textarea name="title"></textarea>'; });
    assert.notEqual(await page.evaluate(() => document.readyState), 'complete');
    await page.addScriptTag({ content: `window.canFillPage = ${canFillPage.toString()};` });
    assert.equal(await page.evaluate(recipe => window.canFillPage(recipe, 'http://forum.test'), EXTENSION_RECIPES.reddit), true);
    assert.equal(await page.evaluate(recipe => window.canFillPage(recipe, 'http://other.test'), EXTENSION_RECIPES.reddit), false);
  } finally { await page.close(); }
});

test('recognizes a social "submitted to moderation" toast but not help text about a future review', async () => {
  const page = await browser.newPage();
  const recipe = EXTENSION_RECIPES.dzone;
  try {
    await page.setContent('<div class="toast">Thank you! Your article has been submitted to moderation.</div>');
    assert.match(await page.evaluate(readModeration, recipe), /quản trị viên duyệt/);
    await page.setContent('<div role="status">Bài viết của bạn đang chờ kiểm duyệt.</div>');
    assert.match(await page.evaluate(readModeration, recipe), /quản trị viên duyệt/);
    await page.setContent('<div role="status">Your article will be submitted for review once you click Submit.</div>');
    assert.equal(await page.evaluate(readModeration, recipe), null);
    await page.setContent('<div class="alert">Saving draft…</div>');
    assert.equal(await page.evaluate(readModeration, recipe), null);
  } finally { await page.close(); }
});

// ---- 1.12.0: a found editor is never reported as "editor not found" ---------
test('a forum editor that loses part of the post is a content mismatch, never submitted', async () => {
  // The editor keeps only the first 20 characters of whatever is typed.
  const mangled = editor.replace('<textarea class="d-editor-input"></textarea>', '<textarea class="d-editor-input" oninput="this.value = this.value.slice(0, 20)"></textarea>');
  const { result, state } = await runForum(mangled, { ...task, autoSubmit: true });
  assert.equal(result.status, 'contentMismatch');
  assert.equal(state.submits, 0);
});

test('a filled forum post whose Post button is disabled waits for the operator instead of failing', async () => {
  const locked = editor.replace('<button class="create"', '<button class="create" disabled');
  const { result, state } = await runForum(locked, { ...task, autoSubmit: true });
  assert.equal(result.status, 'filled');
  assert.deepEqual(result.missing, ['submit']);
  assert.equal(state.body, task.post.body);
  assert.equal(state.submits, 0);
});

test('a forum post over the destination limit is not typed', async () => {
  const { result, state } = await runForum(editor, { ...task, autoSubmit: true, post: { ...task.post, maxChars: 20, length: 42 } });
  assert.deepEqual(result, { status: 'tooLong', message: 'Nội dung dài 42/20 ký tự, vượt giới hạn của kênh này. Cần rút gọn trên web.' });
  assert.equal(state.body, '');
  assert.equal(state.submits, 0);
});

test('the forum content check accepts an editor that renders the Markdown (same words, no symbols or URLs)', async () => {
  const markdownTask = { ...task, recipe: { ...EXTENSION_RECIPES.xenforo }, autoSubmit: false,
    post: { title: 'Rendered Markdown topic', body: '## Setup\n\n- Install the package\n- Run `nginx -t`\n\nSee [the docs](https://nginx.org/) first.' } };
  const page = await browser.newPage();
  try {
    await page.route('http://forum.test/**', route => route.fulfill({ contentType: 'text/html', body: '<form action="/forums/general.1/post-thread"><input name="title"><div class="fr-element fr-view" contenteditable="true"></div><button type="submit" class="button--primary">Post</button></form>'
      // The editor renders the Markdown it receives (heading, list, inline code, link text only).
      + '<script>document.querySelector(".fr-element").addEventListener("input", event => { event.target.innerHTML = "<h2>Setup</h2><ul><li>Install the package</li><li>Run <code>nginx -t</code></li></ul><p>See <a href=\\"https://nginx.org/\\">the docs</a> first.</p>"; });</script>' }));
    await page.goto('http://forum.test/forums/general.1/post-thread');
    const result = await page.evaluate(fillAndSubmit, markdownTask);
    assert.equal(result.status, 'filled', JSON.stringify(result));
    assert.match(await page.locator('.fr-element').innerHTML(), /<h2>Setup<\/h2>/);
  } finally { await page.close(); }
});
