// Discuss Disqus and MeWe composers rebuilt from their public web bundles. Every
// request is intercepted; these tests never reach the real services.
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

const DISQUS_URL = 'https://disqus.com/home/discuss/channel-discussdisqus/';
// The form keeps its own model: jQuery reads the title, the editor and the topics on
// focusout only; a category radio's change writes "<Category>: " into the title.
const disqusPage = ({ checked = '', title = '', verified = true } = {}) => `<!doctype html><body>
${verified ? '' : '<div class="alert -warning">Verify your email <a data-action="verify-email" href="#">Resend</a></div>'}
<form class="form--discussion">
  <div data-role="channel-categories">
    ${['Community Growth', 'Reveal', 'Installation', 'Embed'].map(name => `<label><input type="radio" name="category" value="${name}" ${checked === name ? 'checked' : ''}> ${name}</label>`).join('')}
  </div>
  <div class="form-attribute-input" data-attribute="title"><input name="title" class="text-semibold" placeholder="Headline for your discussion" value="${title}" ${verified ? '' : 'disabled'}></div>
  <div data-role="topic-input"><input name="topics" placeholder="Add topics here, separate with commas."></div><div data-role="topics"></div>
  <div data-role="postbox"><div class="textarea" data-role="editable" contenteditable="plaintext-only" role="textbox" aria-label="Tell people"></div></div>
  <label><input type="checkbox" name="subscribe" checked> Subscribe for email updates to this discussion</label>
  <button type="button" id="cancel-button" data-action="cancel-create">Cancel</button>
  <button type="submit" id="submit-button" class="button--discussion-form" ${verified ? '' : 'disabled'}>Create Discussion</button>
</form>
<script>
  const model = { title: document.querySelector('input[name=title]').value, message: '', topics: [], category: '${checked}' };
  window.submits = 0;
  const title = document.querySelector('input[name=title]');
  for (const radio of document.querySelectorAll('input[name=category]')) radio.addEventListener('change', () => {
    model.category = radio.value;
    title.value = radio.value + ': ' + title.value.replace(/^[^:]*:\\s*/, '');
    model.title = title.value;
  });
  title.addEventListener('focusout', () => { model.title = title.value; });
  const editor = document.querySelector('[data-role=editable]');
  editor.addEventListener('focusout', () => { model.message = editor.innerText; });
  const topics = document.querySelector('input[name=topics]');
  topics.addEventListener('focusout', () => {
    for (const topic of topics.value.split(',').map(item => item.trim()).filter(Boolean)) {
      model.topics.push(topic);
      const chip = document.createElement('span'); chip.className = 'tag__item'; chip.textContent = topic;
      document.querySelector('[data-role=topics]').append(chip);
    }
    topics.value = '';
  });
  document.querySelector('form').addEventListener('submit', event => {
    event.preventDefault();
    window.submits++;
    if (!model.category || !model.title.replace(/^[^:]*:\\s*/, '') || model.message.trim().length < 2) { window.rejected = JSON.parse(JSON.stringify(model)); return; }
    window.created = JSON.parse(JSON.stringify(model));
    history.pushState({}, '', '/channel/discussdisqus/discussion/channel-discussdisqus/my-first-discussion/');
    document.body.innerHTML = '<header data-role="title-area"><h1 class="text-title"></h1></header><div class="reading-block" data-role="message"></div>';
    document.querySelector('h1').textContent = model.title.replace(/^[^:]*:\\s*/, '');
    document.querySelector('.reading-block').textContent = model.message;
  });
</script></body>`;

const disqusJob = (page, extra = {}) => ({
  targetOrigin: 'https://disqus.com', openUrl: page.url(), autoSubmit: true, recipe: EXTENSION_RECIPES.disqus,
  post: { title: 'How do you keep comment threads friendly on a small blog?', body: 'We moderate about 40 comments a day.\n\nPre-moderation for first-time commenters cut spam by half. What works for you?' },
  options: { tags: ['comments'], suggestedTags: ['moderation', 'Community Growth', 'x', 'comments', 'audience growth'], category: '' },
  ...extra,
});

async function openDisqus(page, options) {
  await page.route('**/*', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: disqusPage(options) }));
  await page.goto(DISQUS_URL);
}

test('Discuss Disqus: chooses Community Growth, writes the prefixed title, topics and body, commits them on focusout and creates the discussion once', async () => {
  const page = await browser.newPage();
  try {
    await openDisqus(page);
    const job = disqusJob(page);
    const beforeUrls = await page.evaluate(() => [...document.querySelectorAll('a[href]')].map(node => node.href));
    const result = await page.evaluate(fill, job);
    assert.equal(result.status, 'submitted', result.message);
    assert.equal(await page.evaluate(() => window.submits), 1);
    const created = await page.evaluate(() => window.created);
    assert.equal(created.category, 'Community Growth');
    assert.equal(created.title, `Community Growth: ${job.post.title}`);
    assert.match(created.message, /We moderate about 40 comments a day\.\s+Pre-moderation for first-time commenters/);
    // Fixed tag first, then AI tags; too short, duplicate or category-named topics are left out.
    assert.deepEqual(created.topics, ['comments', 'moderation', 'audience growth']);
    assert.equal(await page.evaluate(read, { job, beforeUrls }), 'https://disqus.com/channel/discussdisqus/discussion/channel-discussdisqus/my-first-discussion/');
  } finally { await page.close(); }
});

test('Discuss Disqus: a title holding only the prefix of an already checked category is not a draft, and the chosen category is used', async () => {
  const page = await browser.newPage();
  try {
    await openDisqus(page, { checked: 'Community Growth', title: 'Community Growth: ' });
    const job = disqusJob(page, { options: { tags: [], suggestedTags: [], category: 'Installation' } });
    const result = await page.evaluate(fill, job);
    assert.equal(result.status, 'submitted', result.message);
    const created = await page.evaluate(() => window.created);
    assert.equal(created.category, 'Installation');
    assert.equal(created.title, `Installation: ${job.post.title}`);
    assert.deepEqual(created.topics, []);
  } finally { await page.close(); }
});

test('Discuss Disqus: stops before writing for an unknown category, an unverified email or another draft; stops before Create when auto-submit is off', async () => {
  const page = await browser.newPage();
  try {
    await openDisqus(page);
    let result = await page.evaluate(fill, disqusJob(page, { options: { tags: [], suggestedTags: [], category: 'Marketing' } }));
    assert.equal(result.status, 'filled');
    assert.match(result.message, /không có chuyên mục “Marketing”/);
    assert.equal(await page.locator('input[name=title]').inputValue(), '');

    await openDisqus(page, { verified: false });
    result = await page.evaluate(fill, disqusJob(page));
    assert.equal(result.status, 'restricted');
    assert.match(result.message, /xác minh email/);

    await openDisqus(page, { checked: 'Embed', title: 'Embed: my own question' });
    result = await page.evaluate(fill, disqusJob(page));
    assert.equal(result.status, 'draft');

    await openDisqus(page);
    result = await page.evaluate(fill, disqusJob(page, { autoSubmit: false }));
    assert.equal(result.status, 'filled');
    assert.equal(await page.evaluate(() => window.submits), 0);
    assert.match(await page.locator('input[name=title]').inputValue(), /^Community Growth: How do you keep/);
  } finally { await page.close(); }
});

const MEWE_URL = 'https://mewe.com/myworld';
// /myworld: the placeholder opens #c-postbox-dialog (Quill editor, hidden photo input,
// Post disabled until there is text and the photo finished uploading). On Post the
// dialog closes and the post is added on top of the feed, without a link.
const mewePage = ({ draft = '', loggedOut = false } = {}) => loggedOut
  ? '<!doctype html><body><form><input name="username"><input type="password" name="password"><button>Log in</button></form></body>'
  : `<!doctype html><head><style>.d-none{display:none}</style></head><body>
<div class="c-mw-postbox-placeholder"><div class="c-mw-avatar"></div><div class="postbox-placeholder_text" data-testid="post-placeholder">How is your day going?</div></div>
<div class="c-mw-posts-feed">
  <div class="c-mw-post"><div class="c-mw-post-header" data-postid="old1"></div><div class="post_text" data-testid="post-text">Queue stuck? Restart Horizon and check the logs. #Pixelfed</div><button data-testid="share-btn">Share</button></div>
</div>
<script>
  window.shared = []; window.uploads = [];
  const open = () => {
    if (document.querySelector('#c-postbox-dialog')) return;
    document.body.insertAdjacentHTML('beforeend', '<div id="c-postbox-dialog" class="dialog_wrapper c-postbox-dialog"><div class="postbox-dialog_inner"><div class="c-mw-postbox" data-test-postbox>'
      + '<div class="postbox_editor_textarea c-mw-text-editor"><div class="quill-editor"><div class="ql-editor ql-blank" contenteditable="true" data-placeholder="How is your day going?"></div></div></div>'
      + '<div class="d-none"><input type="file" id="fake-upload-photo" data-testid="postbox-upload-photo" multiple name="files[]" accept="image/png, image/x-png, image/gif, image/jpeg"></div>'
      + '<div class="postbox_media"></div>'
      + '<div class="postbox_submit-wrapper"><button class="c-mw-button" data-testid="share-btn" disabled><span class="btn-inner-text">Post</span></button></div>'
      + '</div></div></div>');
    const editor = document.querySelector('.ql-editor'), post = document.querySelector('#c-postbox-dialog [data-testid=share-btn]');
    editor.textContent = ${JSON.stringify(draft)};
    let uploading = false;
    const refresh = () => { post.disabled = uploading || !editor.innerText.trim(); };
    editor.addEventListener('input', refresh); refresh();
    document.querySelector('#fake-upload-photo').addEventListener('change', event => {
      const file = event.target.files[0];
      window.uploads.push(file.type);
      if (!/^image\\/(gif|jpeg|png|bmp)$/.test(file.type)) return; // MeWe would attach it as a document
      uploading = true; refresh();
      document.querySelector('.postbox_media').innerHTML = '<div class="c-mw-postbox-photo postbox_media_photo_wrapper--loading" data-id="p1"><img class="postbox-photo_img" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" width="40" height="40"><div class="m-progress"><div class="m-progress_bar"></div></div></div>';
      setTimeout(() => { const photo = document.querySelector('.c-mw-postbox-photo'); photo.classList.remove('postbox_media_photo_wrapper--loading'); photo.querySelector('.m-progress').remove(); uploading = false; refresh(); }, 400);
    });
    post.addEventListener('click', () => {
      window.shared.push({ text: editor.innerText, photos: document.querySelectorAll('.c-mw-postbox-photo').length });
      document.querySelector('#c-postbox-dialog').remove();
      const item = document.createElement('div'); item.className = 'c-mw-post';
      item.innerHTML = '<div class="c-mw-post-header" data-postid="new123"></div><div class="post_text" data-testid="post-text"></div>';
      item.querySelector('.post_text').textContent = window.shared.at(-1).text;
      document.querySelector('.c-mw-posts-feed').prepend(item);
    });
  };
  document.querySelector('.c-mw-postbox-placeholder').addEventListener('click', open);
  ${draft ? 'open();' : ''}
</script></body>`;

async function openMewe(page, options) {
  await page.route('**/*', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: mewePage(options) }));
  await page.goto(MEWE_URL);
}
const meweJob = (page, extra = {}) => ({
  targetOrigin: 'https://mewe.com', openUrl: page.url(), autoSubmit: true, recipe: EXTENSION_RECIPES.mewe,
  post: { title: '', body: 'Queue stuck? Restart Horizon and check the logs. #Pixelfed' }, options: {}, ...extra,
});

test('MeWe: opens the composer, writes the post, attaches a WebP image as PNG, waits for the upload, posts once and finds the new post', async () => {
  const page = await browser.newPage();
  try {
    const webp = await page.evaluate(() => { const canvas = document.createElement('canvas'); canvas.width = 8; canvas.height = 8; canvas.getContext('2d').fillRect(0, 0, 8, 8); return canvas.toDataURL('image/webp').split(',')[1]; });
    await openMewe(page);
    const job = meweJob(page, { attachments: [{ name: 'cover.webp', mimeType: 'image/webp', base64: webp, altText: '' }] });
    const result = await page.evaluate(fill, job);
    assert.equal(result.status, 'submitted', result.message);
    assert.deepEqual(await page.evaluate(() => window.uploads), ['image/png']);
    const shared = await page.evaluate(() => window.shared);
    assert.equal(shared.length, 1);
    assert.equal(shared[0].text.trim(), job.post.body);
    assert.equal(shared[0].photos, 1);
    // The feed shows an older post with the same text: only the new post's id counts.
    assert.ok(result.beforeUrls.includes('https://mewe.com/post/show/old1'));
    assert.equal(await page.evaluate(read, { job, beforeUrls: result.beforeUrls }), 'https://mewe.com/post/show/new123');
  } finally { await page.close(); }
});

test('MeWe: keeps another draft, asks to sign in when logged out, and never presses a feed post\'s Share', async () => {
  const page = await browser.newPage();
  try {
    await openMewe(page, { draft: 'My own unfinished thought' });
    let result = await page.evaluate(fill, meweJob(page));
    assert.equal(result.status, 'draft');
    assert.equal(await page.evaluate(() => window.shared.length), 0);

    await openMewe(page, { loggedOut: true });
    result = await page.evaluate(fill, meweJob(page));
    assert.equal(result.status, 'login');

    await openMewe(page);
    result = await page.evaluate(fill, meweJob(page, { autoSubmit: false }));
    assert.equal(result.status, 'filled');
    assert.equal(await page.evaluate(() => window.shared.length), 0);
  } finally { await page.close(); }
});
