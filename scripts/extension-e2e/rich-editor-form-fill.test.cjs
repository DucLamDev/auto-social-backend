// Fixture pages only (every request is intercepted); nothing is posted anywhere. Run:
//   node --import tsx --test scripts/extension-e2e/rich-editor-form-fill.test.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { before, after, test } = require('node:test');
const { chromium } = require('playwright');
const { EXTENSION_RECIPES } = require('../../src/connectors/extension/extension-delivery.ts');

let browser, fill, collectFormControls, applyFormActions;
const load = async file => import(`data:text/javascript;base64,${Buffer.from(fs.readFileSync(path.join(__dirname, '../../browser-extension', file), 'utf8')).toString('base64')}`);
before(async () => {
  ({ fillSocialAndSubmit: fill } = await load('social-actions.js'));
  ({ collectFormControls, applyFormActions } = await load('form-fill.js'));
  browser = await chromium.launch({ headless: true });
});
after(async () => browser?.close());

async function pageAt(url, html = '') {
  const page = await browser.newPage();
  await page.route('**/*', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<main></main>' }));
  await page.goto(url);
  if (html) await page.evaluate(markup => { document.body.innerHTML = markup; }, html);
  return page;
}

// A realistic Markdown post with its rendered HTML, as the backend sends for `pasteHtml`.
const markdown = [
  '## Vì sao cần reverse proxy',
  '',
  'Nginx đứng trước ứng dụng Node.js, nhận HTTPS rồi chuyển tiếp request vào cổng nội bộ.',
  '',
  '- Ẩn cổng 3000 khỏi Internet',
  '- Bật gzip và cache tệp tĩnh',
  '- Gia hạn chứng chỉ tự động',
  '',
  '```nginx',
  'location / {',
  '  proxy_pass http://127.0.0.1:3000;',
  '}',
  '```',
  '',
  'Xem thêm [tài liệu chính thức](https://nginx.org/en/docs/) trước khi đổi cấu hình.',
].join('\n');
const html = '<h2>Vì sao cần reverse proxy</h2><p>Nginx đứng trước ứng dụng Node.js, nhận HTTPS rồi chuyển tiếp request vào cổng nội bộ.</p>'
  + '<ul><li>Ẩn cổng 3000 khỏi Internet</li><li>Bật gzip và cache tệp tĩnh</li><li>Gia hạn chứng chỉ tự động</li></ul>'
  + '<pre><code class="language-nginx">location / {\n  proxy_pass http://127.0.0.1:3000;\n}\n</code></pre>'
  + '<p>Xem thêm <a href="https://nginx.org/en/docs/">tài liệu chính thức</a> trước khi đổi cấu hình.</p>';
const richPost = { title: 'Cấu hình Nginx reverse proxy cho Node.js', body: markdown, bodyHtml: html, summary: '', maxChars: null, length: markdown.length, language: 'vi' };

// A Lexical-like editor: it handles paste itself (HTML first) and ignores the event's default.
function richEditor(mangle) {
  {
    window.sent = [];
    document.body.innerHTML = '<form><textarea name="title"></textarea><div contenteditable="true" aria-label="editable markdown" class="rich"></div><button id="post-submit-button" type="button">Publish</button></form>';
    const editor = document.querySelector('.rich');
    editor.addEventListener('paste', event => {
      event.preventDefault();
      const pasted = event.clipboardData.getData('text/html');
      // A broken editor keeps only the first block of what was pasted.
      editor.innerHTML = mangle ? pasted.replace(/^(<h2>.*?<\/h2>).*$/s, '$1') : pasted;
    });
    document.querySelector('#post-submit-button').onclick = () => window.sent.push({ title: document.querySelector('textarea').value, html: editor.innerHTML, text: editor.innerText });
  }
}

// Differ's real publish flow (differ.blog/new-story): the toolbar #post-submit-button only opens
// <dialog id="modal-submit"> holding a react-dropzone (hidden file input, preview <img alt="preview">),
// a react-select Keyword picker (classNamePrefix "rs", one topic from Differ's list) and the
// dialog's own <button type="submit">Publish</button>, which is what really publishes.
function differDialog(topics) {
  {
    const editor = document.querySelector('[contenteditable]');
    const dialog = document.createElement('dialog');
    dialog.id = 'modal-submit';
    dialog.className = 'modal';
    dialog.innerHTML = '<div class="modal-box"><label>Featured Image</label><div class="dropzone"><input type="file" accept="image/*" style="display:none"></div>'
      + '<label>Keyword</label><div class="rs-container"><div class="rs__control"><div class="rs__value-container"><div class="rs__placeholder">Select...</div>'
      + '<div class="rs__input-container"><input class="rs__input" role="combobox" aria-expanded="false"></div></div></div><div class="rs__menu-slot"></div></div>'
      + '<button type="submit">Publish</button></div>';
    document.body.append(dialog);
    window.keyword = null; window.image = null;
    const file = dialog.querySelector('input[type="file"]');
    file.addEventListener('change', () => {
      const img = document.createElement('img');
      img.alt = 'preview'; img.style.cssText = 'display:block;width:20px;height:20px';
      img.src = URL.createObjectURL(file.files[0]);
      dialog.querySelector('.dropzone').append(img);
      window.image = file.files[0].name;
    });
    const open = () => {
      if (dialog.querySelector('.rs__menu')) return;
      const menu = document.createElement('div');
      menu.className = 'rs__menu';
      menu.innerHTML = topics.map(topic => `<div class="rs__option" role="option">${topic}</div>`).join('');
      dialog.querySelector('.rs__menu-slot').append(menu);
      for (const option of menu.querySelectorAll('.rs__option')) option.addEventListener('click', () => {
        window.keyword = option.textContent;
        menu.remove();
        dialog.querySelector('.rs__placeholder').outerHTML = `<div class="rs__single-value">${option.textContent}</div>`;
      });
    };
    dialog.querySelector('.rs__control').addEventListener('mousedown', open);
    dialog.querySelector('.rs__input').addEventListener('keydown', event => { if (event.key === 'ArrowDown') open(); });
    document.querySelector('#post-submit-button').onclick = () => dialog.showModal();
    dialog.querySelector('button[type="submit"]').onclick = () => {
      window.sent.push({ title: document.querySelector('textarea').value, html: editor.innerHTML, text: editor.innerText, keyword: window.keyword, image: window.image });
      dialog.close();
    };
  }
}
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const differJob = (page, extra = {}) => ({ recipe: EXTENSION_RECIPES.differ, targetOrigin: 'https://differ.blog', openUrl: page.url(), post: richPost, autoSubmit: true, options: { tags: [] }, ...extra });

test('Differ opens its publish dialog, adds the featured image, picks the Keyword matching a post tag, then publishes', async () => {
  const page = await pageAt('https://differ.blog/new-story');
  try {
    await page.evaluate(richEditor, false);
    await page.evaluate(differDialog, ['Technology', 'Linux', 'Security']);
    const result = await page.evaluate(fill, differJob(page, { options: { tags: [], suggestedTags: ['self hosting', 'linux'] },
      attachments: [{ name: 'cover.png', mimeType: 'image/png', base64: PNG }] }));
    assert.equal(result.status, 'submitted', JSON.stringify(result));
    const sent = await page.evaluate(() => window.sent);
    assert.equal(sent.length, 1, 'the toolbar button alone never publishes');
    assert.equal(sent[0].keyword, 'Linux');
    assert.equal(sent[0].image, 'cover.png');
    assert.match(sent[0].html, /<h2>Vì sao cần reverse proxy<\/h2>/);
  } finally { await page.close(); }
});

test('Differ falls back to a broad topic when no post tag is in its list, and a configured tag wins over AI tags', async () => {
  for (const [options, topics, expected] of [
    [{ tags: [], suggestedTags: ['vps'] }, ['Health', 'Technology'], 'Technology'],
    [{ tags: ['Security'], suggestedTags: ['linux'] }, ['Linux', 'Security'], 'Security'],
  ]) {
    const page = await pageAt('https://differ.blog/new-story');
    try {
      await page.evaluate(richEditor, false);
      await page.evaluate(differDialog, topics);
      const result = await page.evaluate(fill, differJob(page, { options }));
      assert.equal(result.status, 'submitted', JSON.stringify(result));
      const [sent] = await page.evaluate(() => window.sent);
      assert.equal(sent.keyword, expected);
      assert.equal(sent.image, null);
    } finally { await page.close(); }
  }
});

test('Differ leaves out a featured image it cannot take and still publishes, saying so', async () => {
  const page = await pageAt('https://differ.blog/new-story');
  try {
    await page.evaluate(richEditor, false);
    await page.evaluate(differDialog, ['Technology']);
    const result = await page.evaluate(fill, differJob(page, { attachments: [{ name: 'cover.webp', mimeType: 'image/webp', base64: PNG }] }));
    assert.equal(result.status, 'submitted', JSON.stringify(result));
    assert.match(result.message, /Ảnh bìa không gắn được/);
    const [sent] = await page.evaluate(() => window.sent);
    assert.equal(sent.image, null);
    assert.equal(sent.keyword, 'Technology');
  } finally { await page.close(); }
});

test('Differ without a fitting topic asks AI form-fill, or waits for the operator with the dialog open; nothing is published', async () => {
  for (const formFill of [{ enabled: true }, { enabled: false }]) {
    const page = await pageAt('https://differ.blog/new-story');
    try {
      await page.evaluate(richEditor, false);
      await page.evaluate(differDialog, ['Health', 'Food']);
      const result = await page.evaluate(fill, differJob(page, { options: { tags: [], suggestedTags: ['vps'] }, formFill }));
      assert.equal(result.status, formFill.enabled ? 'needsForm' : 'filled', JSON.stringify(result));
      assert.match(result.message, /Keyword/);
      assert.deepEqual(await page.evaluate(() => window.sent), []);
      assert.equal(await page.evaluate(() => document.querySelector('dialog#modal-submit').open), true);
    } finally { await page.close(); }
  }
});

test('pasteHtml: a rich editor receives the rendered HTML, keeps every block and passes the content check', async () => {
  const page = await pageAt('https://differ.blog/new-story');
  try {
    await page.evaluate(richEditor, false);
    await page.evaluate(differDialog, ['Technology']);
    const job = { recipe: { ...EXTENSION_RECIPES.differ, inputMode: 'pasteHtml' }, targetOrigin: 'https://differ.blog', openUrl: page.url(), post: richPost, autoSubmit: true, options: { tags: [] } };
    const result = await page.evaluate(fill, job);
    assert.equal(result.status, 'submitted', JSON.stringify(result));
    const [sent] = await page.evaluate(() => window.sent);
    assert.equal(sent.title, richPost.title);
    assert.match(sent.html, /<h2>Vì sao cần reverse proxy<\/h2>/);
    assert.equal((sent.html.match(/<li>/g) ?? []).length, 3);
    assert.match(sent.html, /<pre><code/);
    assert.doesNotMatch(sent.text, /##|\]\(|```/, 'no raw Markdown in the editor');
  } finally { await page.close(); }
});

test('CONTENT_MISMATCH: an editor that drops part of the post is never submitted', async () => {
  const page = await pageAt('https://differ.blog/new-story');
  try {
    await page.evaluate(richEditor, true);
    const job = { recipe: { ...EXTENSION_RECIPES.differ, inputMode: 'pasteHtml' }, targetOrigin: 'https://differ.blog', openUrl: page.url(), post: richPost, autoSubmit: true };
    const result = await page.evaluate(fill, job);
    assert.equal(result.status, 'contentMismatch', JSON.stringify(result));
    assert.match(result.message, /Editor không giữ đúng/);
    assert.deepEqual(await page.evaluate(() => window.sent), []);
  } finally { await page.close(); }
});

test('the content check refuses an editor that adds much more text than the post', async () => {
  const page = await pageAt('https://differ.blog/new-story');
  try {
    await page.evaluate(richEditor, false);
    const job = { recipe: { ...EXTENSION_RECIPES.differ, inputMode: 'pasteHtml' }, targetOrigin: 'https://differ.blog', openUrl: page.url(), post: richPost, autoSubmit: false };
    // An editor that appends a long signature after the post.
    await page.evaluate(() => {
      const editor = document.querySelector('.rich');
      editor.addEventListener('paste', () => setTimeout(() => editor.insertAdjacentHTML('beforeend', `<p>${'Chữ ký tự động thêm vào cuối mỗi bài viết mới. '.repeat(3)}</p>`), 0));
    });
    assert.equal((await page.evaluate(fill, job)).status, 'contentMismatch');
  } finally { await page.close(); }
});

test('a plain contenteditable keeps paragraphs and line breaks, with no synthetic input event (no double insert)', async () => {
  const page = await pageAt('https://www.linkedin.com/feed/', '<div class="tiptap ProseMirror" contenteditable="true" role="textbox"></div><button>Post</button>');
  try {
    await page.evaluate(() => {
      window.synthetic = 0; window.types = []; window.sent = 0;
      const editor = document.querySelector('[contenteditable]');
      editor.addEventListener('input', event => { if (!event.isTrusted) window.synthetic++; window.types.push(event.inputType); });
      document.querySelector('button').onclick = () => window.sent++;
    });
    const post = { title: '', body: 'Dòng đầu của đoạn một\nDòng hai của đoạn một\n\nĐoạn hai sau một dòng trống.', maxChars: 3000, length: 80, language: 'vi' };
    const result = await page.evaluate(fill, { recipe: EXTENSION_RECIPES.linkedin, targetOrigin: 'https://www.linkedin.com', openUrl: page.url(), post, autoSubmit: true });
    assert.equal(result.status, 'submitted', JSON.stringify(result));
    assert.equal(await page.evaluate(() => window.synthetic), 0);
    const types = await page.evaluate(() => window.types);
    assert.ok(types.includes('insertLineBreak') && types.includes('insertParagraph'), types.join());
    const text = await page.locator('[contenteditable]').innerText();
    assert.equal(text.replace(/\n{2,}/g, '\n\n'), post.body);
    assert.equal(await page.evaluate(() => window.sent), 1);
  } finally { await page.close(); }
});

test('a post longer than the destination allows is stopped before anything is typed', async () => {
  const page = await pageAt('https://bsky.app/', '<div contenteditable="true" data-testid="composerTextInput"></div><button data-testid="composerPublishBtn">Post</button>');
  try {
    const body = 'Một bài khá dài. '.repeat(25);
    const result = await page.evaluate(fill, { recipe: EXTENSION_RECIPES.bluesky, targetOrigin: 'https://bsky.app', openUrl: page.url(), autoSubmit: true,
      post: { title: '', body, maxChars: 300, length: 425, language: 'vi' } });
    assert.deepEqual(result, { status: 'tooLong', message: 'Nội dung dài 425/300 ký tự, vượt giới hạn của kênh này. Cần rút gọn trên web.' });
    assert.equal(await page.locator('[contenteditable]').innerText(), '');
  } finally { await page.close(); }
});

test('Bluesky posts within its limit no longer depend on a built-in character table', async () => {
  const page = await pageAt('https://bsky.app/', '<div contenteditable="true" data-testid="composerTextInput"></div><button data-testid="composerPublishBtn">Post</button>');
  try {
    await page.evaluate(() => { window.sent = 0; document.querySelector('button').onclick = () => window.sent++; });
    // 320 characters: over the old hard-coded 300, but the backend says this destination allows it.
    const body = 'x'.repeat(320);
    const result = await page.evaluate(fill, { recipe: EXTENSION_RECIPES.bluesky, targetOrigin: 'https://bsky.app', openUrl: page.url(), autoSubmit: true,
      post: { title: '', body, maxChars: 500, length: 320, language: 'en' } });
    assert.equal(result.status, 'submitted', JSON.stringify(result));
    assert.equal(await page.evaluate(() => window.sent), 1);
  } finally { await page.close(); }
});

test('Quora does not repeat the title when the body already starts with it', async () => {
  const page = await pageAt('https://example.quora.com/', '<div role="dialog"><div class="ql-editor" contenteditable="true"></div><button>Post</button></div>');
  try {
    await page.evaluate(() => { window.sent = []; document.querySelector('button').onclick = () => window.sent.push(document.querySelector('.ql-editor').innerText); });
    const post = { title: 'Chọn VPS cho proxy', body: 'Chọn VPS cho proxy\n\nCần xem băng thông và vị trí máy chủ.', maxChars: null, length: 50, language: 'vi' };
    const result = await page.evaluate(fill, { recipe: EXTENSION_RECIPES.quora, targetOrigin: 'https://example.quora.com', openUrl: page.url(), post, autoSubmit: true });
    assert.equal(result.status, 'submitted', JSON.stringify(result));
    const [text] = await page.evaluate(() => window.sent);
    assert.equal(text.replace(/\n{2,}/g, '\n\n'), post.body);
  } finally { await page.close(); }
});

// ---- AI form-fill, page side ------------------------------------------------
// Lemmy-like create_post: community picker, language <select>, a required rules
// checkbox and fields that must never be described to the backend.
const lemmyForm = `
  <form id="create-post">
    <div class="dropdown"><button type="button" id="post-community" role="combobox" aria-haspopup="listbox" aria-expanded="false">Select a community</button>
      <div class="dropdown-menu" hidden><input aria-label="Search communities"><button type="button" class="dropdown-item" role="option">technology</button><button type="button" class="dropdown-item" role="option">linux</button></div></div>
    <label for="post-title">Title</label><textarea id="post-title"></textarea>
    <label for="markdown-textarea-1">Body</label><textarea id="markdown-textarea-1"></textarea>
    <label for="post-language">Language</label><select id="post-language"><option value="0">Undetermined</option><option value="37">English</option><option value="96">Tiếng Việt</option></select>
    <label><input type="checkbox" id="rules" required> I have read the community rules</label>
    <label>Notify me <input type="email" name="notify_email" value="owner@example.com"></label>
    <label>Nickname <input name="nickname" value="typed-secret-value"></label>
    <input type="hidden" name="csrf" value="csrf-secret">
    <button type="submit" disabled>Create</button>
  </form>`;
function lemmyScript() {
  window.sent = [];
  const form = document.querySelector('form'), submit = form.querySelector('[type="submit"]'), picker = form.querySelector('#post-community'), menu = form.querySelector('.dropdown-menu');
  const sync = () => { submit.disabled = !(form.querySelector('#post-title').value && form.querySelector('textarea[id^="markdown"]').value && form.querySelector('#rules').checked && picker.textContent !== 'Select a community'); };
  picker.onclick = () => { menu.hidden = !menu.hidden; picker.setAttribute('aria-expanded', String(!menu.hidden)); };
  for (const option of menu.querySelectorAll('[role="option"]')) option.onclick = () => { picker.textContent = option.textContent; menu.hidden = true; picker.setAttribute('aria-expanded', 'false'); sync(); };
  form.addEventListener('input', sync); form.addEventListener('change', sync);
  form.onsubmit = event => { event.preventDefault(); window.sent.push({ community: picker.textContent, language: form.querySelector('select').value, rules: form.querySelector('#rules').checked }); };
}
const lemmyJob = (extra = {}) => ({ recipe: { ...EXTENSION_RECIPES.lemmy, languageSelectors: ['select#post-language'] }, targetOrigin: 'https://lemmy.world', openUrl: 'https://lemmy.world/create_post',
  post: { title: 'Self-hosting Lemmy behind Nginx', body: 'Short guide.\n\nSecond paragraph with the config.', maxChars: 10000, length: 48, language: 'en' },
  autoSubmit: true, formFill: { enabled: true }, options: { tags: [] }, ...extra });

test('form-fill: the composer asks for help with unknown required controls; described controls never leak values', async () => {
  const page = await pageAt('https://lemmy.world/create_post', lemmyForm);
  try {
    await page.evaluate(lemmyScript);
    const first = await page.evaluate(fill, lemmyJob());
    assert.equal(first.status, 'needsForm', JSON.stringify(first));
    assert.equal(await page.locator('#post-language').inputValue(), '37', 'the language is chosen from post.language before AI help');
    assert.equal(await page.locator('#post-title').inputValue(), 'Self-hosting Lemmy behind Nginx');

    const { controls } = await page.evaluate(collectFormControls, { recipe: lemmyJob().recipe });
    const text = JSON.stringify(controls);
    for (const secret of ['owner@example.com', 'typed-secret-value', 'csrf-secret', 'Self-hosting', 'Short guide']) assert.ok(!text.includes(secret), `${secret} must stay in the page`);
    assert.ok(!controls.some(control => ['#post-title', '#markdown-textarea-1'].includes(control.selector)), 'title/body editors are not described');
    assert.ok(!controls.some(control => ['email', 'password', 'hidden'].includes(control.type)));
    const rules = controls.find(control => control.selector === '#rules');
    assert.deepEqual([rules.kind, rules.required, rules.checked, rules.label], ['checkbox', true, false, 'I have read the community rules']);
    assert.equal(controls[0], rules, 'required controls come first');
    const community = controls.find(control => control.selector === '#post-community');
    assert.equal(community.kind, 'combobox');
    assert.deepEqual(community.options.map(option => option.label), ['technology', 'linux'], 'a custom picker is opened to read its options');
    assert.equal(await page.locator('.dropdown-menu').isHidden(), true, 'and closed again');
    const language = controls.find(control => control.selector === '#post-language');
    assert.deepEqual([language.kind, language.selected, language.options.length], ['select', 'English', 3]);
    const nickname = controls.find(control => control.name === 'nickname');
    assert.equal(nickname.kind, 'text');
    assert.ok(controls.every(control => control.index === controls.indexOf(control)));

    const { results } = await page.evaluate(applyFormActions, { actions: [
      { index: community.index, selector: community.selector, action: 'select', value: 'technology' },
      { index: rules.index, selector: rules.selector, action: 'check' },
    ] });
    assert.ok(results.every(item => item.ok), JSON.stringify(results));
    const resumed = await page.evaluate(fill, lemmyJob({ formFillResume: true, formFillRounds: 1 }));
    assert.equal(resumed.status, 'submitted', JSON.stringify(resumed));
    assert.deepEqual(await page.evaluate(() => window.sent), [{ community: 'technology', language: '37', rules: true }]);
  } finally { await page.close(); }
});

test('form-fill never describes password, email or hidden inputs, wherever they are', async () => {
  const page = await pageAt('https://forum.test/compose', `<div role="dialog"><form>
    <input type="password" name="pw" value="hunter2"><input name="user_email" value="owner@example.com"><input type="email" value="a@b.test">
    <input type="hidden" name="token" value="t0k3n"><input autocomplete="one-time-code" name="code" value="123456">
    <label><input type="checkbox" name="agree" required> Agree</label></form></div>`);
  try {
    const { controls } = await page.evaluate(collectFormControls, { recipe: {} });
    assert.deepEqual(controls.map(control => control.name), ['agree']);
    for (const secret of ['hunter2', 'owner@example.com', 'a@b.test', 't0k3n', '123456']) assert.ok(!JSON.stringify(controls).includes(secret));
  } finally { await page.close(); }
});

test('form-fill: check/uncheck only clicks when the state differs; an unknown option is reported, not guessed', async () => {
  const page = await pageAt('https://lemmy.world/create_post', lemmyForm);
  try {
    await page.evaluate(lemmyScript);
    await page.locator('#rules').check();
    const { results } = await page.evaluate(applyFormActions, { actions: [
      { index: 0, selector: '#rules', action: 'check' },
      { index: 1, selector: '#post-language', action: 'select', value: 'Klingon' },
      { index: 2, selector: '#post-community', action: 'select', value: 'not-a-community' },
    ] });
    assert.deepEqual(results.map(item => item.ok), [true, false, false]);
    assert.equal(await page.locator('#rules').isChecked(), true);
    assert.equal(await page.locator('#post-language').inputValue(), '0');
  } finally { await page.close(); }
});

test('form-fill disabled: Lemmy without a configured community stops before writing anything', async () => {
  const page = await pageAt('https://lemmy.world/create_post', lemmyForm);
  try {
    await page.evaluate(lemmyScript);
    const result = await page.evaluate(fill, lemmyJob({ formFill: { enabled: false } }));
    assert.deepEqual([result.status, result.message], ['filled', 'Cần chọn community đích trong cấu hình tài khoản trên web.']);
    assert.equal(await page.locator('#post-title').inputValue(), '');
    assert.equal(await page.locator('#markdown-textarea-1').inputValue(), '');
  } finally { await page.close(); }
});

test('form-fill: after two AI rounds a still incomplete form is left for the operator', async () => {
  const page = await pageAt('https://lemmy.world/create_post', lemmyForm);
  try {
    await page.evaluate(lemmyScript);
    const result = await page.evaluate(fill, lemmyJob({ formFillRounds: 2 }));
    assert.deepEqual([result.status, result.message], ['filled', 'AI chưa điền chắc chắn các mục bắt buộc; mở tab để kiểm và bấm Đăng.']);
    assert.deepEqual(await page.evaluate(() => window.sent), []);
  } finally { await page.close(); }
});
