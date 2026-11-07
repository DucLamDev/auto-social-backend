// Fixture pages only; nothing is sent anywhere. Run:
//   node --import tsx --test scripts/extension-e2e/ui-recovery.test.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { before, after, test } = require('node:test');
const { chromium } = require('playwright');
let browser, collectUiCandidates, verifyUiSelectors, fillSocialAndSubmit;

const load = async file => import(`data:text/javascript;base64,${Buffer.from(fs.readFileSync(path.join(__dirname, '../../browser-extension', file), 'utf8')).toString('base64')}`);
before(async () => {
  ({ collectUiCandidates, verifyUiSelectors } = await load('ui-recovery.js'));
  ({ fillSocialAndSubmit } = await load('social-actions.js'));
  browser = await chromium.launch({ headless: true });
});
after(async () => browser?.close());

async function page(html, origin = 'https://social.test') {
  const tab = await browser.newPage();
  await tab.route('**/*', route => route.fulfill({ contentType: 'text/html', body: '<main></main>' }));
  await tab.goto(`${origin}/compose`);
  await tab.evaluate(markup => { document.body.innerHTML = markup; }, html);
  return tab;
}

const redesigned = `
  <header><input type="search" placeholder="Search" name="q"><a href="/new">Viết bài mới</a><button>Menu</button></header>
  <div role="dialog" aria-label="Tạo bài">
    <form>
      <input name="headline" placeholder="Tiêu đề">
      <input type="password" name="pw" value="hunter2-secret">
      <input type="hidden" name="csrf" value="csrf-secret-token">
      <label for="note">Liên hệ an.nguyen@example.com</label><input id="note" value="typed-secret-value">
      <div class="editor-v2" contenteditable="true" aria-label="Nội dung bài viết">draft-secret-content</div>
      <button type="button" class="cancel">Huỷ</button>
      <button type="submit" class="publish-v2">Đăng bài</button>
    </form>
  </div>`;

test('describes visible controls without values, passwords or personal data', async () => {
  const tab = await page(redesigned);
  const { candidates } = await tab.evaluate(collectUiCandidates, { missing: ['body', 'submit'] });
  const text = JSON.stringify(candidates);
  for (const secret of ['hunter2', 'csrf-secret', 'typed-secret', 'draft-secret', 'an.nguyen@example.com']) assert.ok(!text.includes(secret), `${secret} must not leave the page`);
  assert.ok(text.includes('[email]'));
  assert.ok(!candidates.some(candidate => candidate.type === 'password' || candidate.type === 'hidden'));
  assert.ok(candidates[0].inDialog, 'controls of the open dialog come first');
  assert.ok(!candidates.some(candidate => candidate.kind === 'link'), 'links only when the opener is missing');
  const editor = candidates.find(candidate => candidate.kind === 'contenteditable');
  assert.equal(editor.label, 'Nội dung bài viết');
  assert.equal(editor.text, undefined, 'editors never reveal their text');
  assert.equal(candidates.find(candidate => candidate.kind === 'submit').text, 'Đăng bài');
  await tab.close();
});

test('every candidate has a selector that matches exactly that element', async () => {
  const tab = await page(`${redesigned}<div id="host"></div>`);
  await tab.evaluate(() => {
    const root = document.getElementById('host').attachShadow({ mode: 'open' });
    root.innerHTML = '<div><textarea placeholder="Shadow editor"></textarea></div>';
  });
  const { candidates } = await tab.evaluate(collectUiCandidates, { missing: ['body', 'opener'] });
  assert.ok(candidates.some(candidate => candidate.placeholder === 'Shadow editor'), 'shadow DOM editors are described');
  assert.ok(candidates.some(candidate => candidate.kind === 'link' && candidate.text === 'Viết bài mới'));
  const counts = await tab.evaluate(list => list.map(candidate => {
    const roots = [document];
    for (let i = 0; i < roots.length; i++) for (const node of roots[i].querySelectorAll('*')) if (node.shadowRoot) roots.push(node.shadowRoot);
    return roots.reduce((total, root) => total + root.querySelectorAll(candidate.selector).length, 0);
  }), candidates);
  assert.deepEqual(counts, candidates.map(() => 1));
  candidates.forEach((candidate, index) => assert.equal(candidate.index, index));
  await tab.close();
});

test('stops at 60 candidates', async () => {
  const tab = await page(Array.from({ length: 90 }, (_, index) => `<button class="b">Nút ${index}</button>`).join(''));
  const { candidates } = await tab.evaluate(collectUiCandidates, { missing: ['submit'] });
  assert.equal(candidates.length, 60);
  await tab.close();
});

test('keeps only suggestions that match one visible element of the right kind', async () => {
  const tab = await page(`${redesigned}<button class="dup">Post</button><button class="dup">Post</button>`);
  const kept = await tab.evaluate(verifyUiSelectors, { selectors: { body: 'div.editor-v2', submit: 'button.dup', title: 'button.publish-v2', opener: 'invalid[[' } });
  assert.deepEqual(kept, { body: 'div.editor-v2' });
  await tab.close();
});

test('a redesigned composer is reported as missing, then filled with the AI selectors without clicking Post', async () => {
  const tab = await page(redesigned);
  await tab.evaluate(() => { window.clicked = false; document.querySelector('.publish-v2').addEventListener('click', event => { event.preventDefault(); window.clicked = true; }); });
  const job = {
    jobId: 'job-1', targetOrigin: 'https://social.test', openUrl: 'https://social.test/compose', autoSubmit: true,
    post: { title: 'Bài mới', body: 'Nội dung từ web.', summary: '' },
    recipe: { engine: 'devto', workflow: 'social', readySelectors: ['#article-title'], titleSelectors: ['#article-title'], bodySelectors: ['#article-body'], submitSelectors: ['button.old'], loginSelectors: [], errorSelectors: [], captchaSelectors: [], successUrlPattern: '(?!)', bodyFormat: 'paragraphs' },
  };
  await tab.evaluate(() => { document.querySelector('.editor-v2').textContent = ''; });
  const first = await tab.evaluate(fillSocialAndSubmit, job);
  assert.equal(first.status, 'notReady');
  assert.deepEqual(first.missing.sort(), ['body', 'title']);
  const { candidates } = await tab.evaluate(collectUiCandidates, { missing: first.missing });
  const title = candidates.find(candidate => candidate.placeholder === 'Tiêu đề').selector;
  const body = candidates.find(candidate => candidate.kind === 'contenteditable').selector;
  const override = { ...job, autoSubmit: false, recipe: { ...job.recipe, uiOverride: true, readySelectors: [title, body], titleSelectors: [title], bodySelectors: [body] } };
  const second = await tab.evaluate(fillSocialAndSubmit, override);
  assert.equal(second.status, 'filled');
  assert.equal(await tab.evaluate(() => window.clicked), false);
  assert.equal(await tab.evaluate(() => document.querySelector('[name="headline"]').value), 'Bài mới');
  assert.match(await tab.evaluate(() => document.querySelector('.editor-v2').innerText), /Nội dung từ web/);
  await tab.close();
});

test('sign-in mode describes the avatar, profile links and names with their page region, never form fields', async () => {
  const tab = await page(`<header><a href="/u/vpsttt"><img alt="VPSTTT Group" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" width="24" height="24"></a>
    <button aria-label="Account menu">▾</button></header>
    <aside><h2>VPSTTT Group</h2><span>Member since August 2026, an@example.com</span></aside>
    <main><article><a href="/u/someone">Someone</a><span>Posted by someone</span></article>
    <form><input name="q" value="secret search"><input type="password" value="hunter2"><button type="submit">Log in</button></form></main>`);
  try {
    const { candidates } = await tab.evaluate(collectUiCandidates, { mode: 'auth' });
    const summary = candidates.map(candidate => [candidate.kind, candidate.region, candidate.inArticle, candidate.label ?? candidate.text]);
    assert.deepEqual(summary.slice(0, 2), [['link', 'header', false, 'VPSTTT Group'], ['button', 'header', false, 'Account menu']]);
    assert.ok(summary.some(([kind, region, , text]) => kind === 'text' && region === 'aside' && text === 'VPSTTT Group'));
    assert.ok(summary.some(([kind, , inArticle]) => kind === 'link' && inArticle === true), 'a post author is described but marked as inside a post');
    // Never a field, a value, or text from the page body; personal data is masked.
    assert.ok(candidates.every(candidate => !['input', 'textarea', 'contenteditable'].includes(candidate.kind)));
    const all = JSON.stringify(candidates);
    assert.ok(!all.includes('hunter2') && !all.includes('secret search') && !all.includes('Posted by someone') && !all.includes('an@example.com'));
  } finally { await tab.close(); }
});
