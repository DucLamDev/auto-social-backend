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
