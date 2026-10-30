// All requests are intercepted fixtures; this suite never posts to live sites.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { before, after, test } = require('node:test');
const { chromium } = require('playwright');
const { EXTENSION_RECIPES } = require('../../src/connectors/extension/extension-delivery.ts');
let browser, fillSocialAndSubmit, readSocialPublishedPost;
const post = { title: 'Approved article title', body: 'Approved body from the web.\n\nA second paragraph with useful details.', summary: 'A useful summary.' };
before(async () => {
  const source = fs.readFileSync(path.join(__dirname, '../../browser-extension/social-actions.js'), 'utf8');
  ({ fillSocialAndSubmit, readSocialPublishedPost } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`));
  browser = await chromium.launch({ headless: true });
});
after(async () => browser?.close());

async function fixture(engine, tweaks = {}) {
  const origins = { medium: 'https://medium.com', substack: 'https://example.substack.com', quora: tweaks.personal ? 'https://www.quora.com' : 'https://example.quora.com', reddit: 'https://www.reddit.com', slideshare: 'https://www.slideshare.net', 'aws-builder': 'https://builder.aws.com', tinhte: 'https://tinhte.vn', pixelfed: 'https://pixelfed.social' };
  const publishedPaths = { medium: '/@writer/approved-article-ab1234567890', substack: '/p/approved-article', quora: tweaks.personal ? '/profile/writer/Approved-article' : '/Approved-article', reddit: '/r/example/comments/abc123/approved_article/', slideshare: '/slideshow/approved-article/12345', 'aws-builder': '/content/abc123/approved-article', tinhte: '/thread/approved-article.12345/', pixelfed: '/p/writer/12345' };
  const page = await browser.newPage();
  await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: '<main></main>' }));
  await page.goto(origins[engine] + '/fixture-compose');
  await page.evaluate(({ engine, post, publishedPath, tweaks }) => {
    window.records = []; window.uploads = []; window.post = post; window.steps = [];
    const input = '<input name="title" placeholder="Title">';
    const editable = '<div class="ProseMirror tiptap" contenteditable="true" role="textbox"></div>';
    const category = '<select name="category"><option value="">Choose category</option><option value="technology">Technology</option></select>';
    const renderPublished = (record) => {
      window.records.push(record);
      const nodes = {
        medium: '<article><h1></h1><div class="section-inner"></div></article>',
        substack: '<article><h1 class="post-title"></h1><div class="body markup"></div></article>',
        quora: '<article class="feed-card"><div class="q-text"></div><a class="q-box">Open post</a></article>',
        reddit: '<shreddit-post><h1></h1><div slot="text-body"></div></shreddit-post>',
        slideshare: '<h1></h1><div data-testid="slideshow-description"></div>',
        'aws-builder': '<h1></h1><article></article>',
        tinhte: '<h1></h1><article itemprop="articleBody"></article>',
        pixelfed: '<article class="status"><div class="post-caption"></div><a>Open photo</a></article>',
      };
      document.body.innerHTML = nodes[engine];
      const title = document.querySelector('h1'); if (title) title.textContent = record.title;
      const body = document.querySelector('.section-inner, .body.markup, .q-text, [slot="text-body"], [data-testid="slideshow-description"], .post-caption') ?? document.querySelector('article');
      body.textContent = record.body;
      const link = document.querySelector('a'); if (link) link.href = publishedPath;
      if (!['quora', 'pixelfed'].includes(engine)) history.pushState({}, '', publishedPath);
    };
    const recordEditor = (root = document) => ({ title: root.querySelector('input[name="title"], textarea.title-input')?.value ?? post.title,
      body: root.querySelector('[contenteditable]')?.innerText ?? root.querySelector('textarea')?.value,
      category: root.querySelector('select')?.value, tags: root.querySelector('input[name="tags"]')?.value });
    if (engine === 'medium') {
      document.body.innerHTML = '<article class="postArticle-content"><div class="section-inner" contenteditable="true"><h3 data-placeholder="Title"></h3><p data-placeholder="Tell your story"></p></div></article><button>Publish</button>';
      document.querySelector('button').onclick = () => {
        const record = { title: document.querySelector('h3').innerText, body: [...document.querySelector('.section-inner').children].filter(node => node.tagName !== 'H3').map(node => node.innerText).filter(text => text.trim()).join('\n\n') };
        const dialog = document.createElement('div'); dialog.setAttribute('role', 'dialog');
        dialog.innerHTML = '<label><input type="checkbox" checked>Email a link to my subscribers</label><button>Publish now</button>';
        document.body.append(dialog);
        dialog.querySelector('button').onclick = () => renderPublished({ ...record, email: dialog.querySelector('input').checked });
      };
    } else if (engine === 'substack') {
      document.body.innerHTML = `<section>${input}${editable}<button>Continue</button></section>`;
      document.querySelector('button').onclick = () => {
        const record = recordEditor(); document.querySelector('section').hidden = true;
        const dialog = document.createElement('div'); dialog.setAttribute('role', 'dialog');
        dialog.innerHTML = (tweaks.noEmailControl ? '' : '<label><input type="checkbox" checked>Send via email and Substack app inbox</label>') + '<button>Publish</button>';
        document.body.append(dialog);
        dialog.querySelector('button').onclick = () => renderPublished({ ...record, email: dialog.querySelector('input')?.checked });
      };
    } else if (engine === 'quora' && tweaks.personal) {
      document.body.innerHTML = '<button aria-label="Add question">Add question</button><button aria-label="Add question" aria-haspopup="menu">Add question</button><button id="feed-post">Post</button>';
      document.querySelector('[aria-haspopup]').onclick = () => window.steps.push('wrong-dropdown');
      document.querySelector('#feed-post').onclick = () => window.steps.push('wrong-feed-post');
      document.querySelector('button').onclick = () => {
        window.steps.push('open-question');
        const dialog = document.createElement('div'); dialog.setAttribute('role', 'dialog');
        dialog.innerHTML = `<button>${tweaks.wrongAudience ? 'Followers' : 'Everyone'}</button><button class="puppeteer_test_modal_submit" disabled>Add Question</button><div role="tab">Add Question</div><div role="tab" id="post-tab">Create Post</div><div class="editor"><textarea placeholder="Start your question"></textarea></div>`;
        document.body.append(dialog);
        dialog.querySelector('#post-tab').onclick = () => {
          window.steps.push('create-post');
          dialog.querySelector('.editor').innerHTML = '<div class="doc" contenteditable="true" data-placeholder="Say something..."></div>';
          const submit = dialog.querySelector('.puppeteer_test_modal_submit'); submit.textContent = 'Post';
          const editor = dialog.querySelector('.doc');
          editor.textContent = tweaks.existingDraft ? 'My unrelated draft' : '';
          editor.oninput = () => { submit.disabled = !editor.innerText.trim(); };
          submit.onclick = () => renderPublished(recordEditor(dialog));
        };
      };
    } else if (engine === 'quora') {
      document.body.innerHTML = '<button>Add a post</button>';
      document.querySelector('button').onclick = () => {
        document.body.innerHTML = '<div role="dialog"><div class="ql-editor" contenteditable="true"></div><button>Post</button></div>';
        document.querySelector('button').onclick = () => renderPublished(recordEditor());
      };
    } else if (engine === 'reddit') {
      document.body.innerHTML = '<shreddit-composer></shreddit-composer>';
      const root = document.querySelector('shreddit-composer').attachShadow({ mode: 'open' });
      root.innerHTML = `<textarea name="title"></textarea>${editable}<button>Post</button>`;
      root.querySelector('button').onclick = () => renderPublished({ title: root.querySelector('textarea').value, body: root.querySelector('[contenteditable]').innerText });
    } else if (engine === 'slideshare') {
      if (tweaks.outage) { document.body.textContent = 'SlideShare presentation uploads are unavailable right now.'; return; }
      document.body.innerHTML = '<input type="file" accept="application/pdf">';
      document.querySelector('input').onchange = async event => {
        window.uploads.push({ name: event.target.files[0].name, type: event.target.files[0].type, bytes: await event.target.files[0].text() });
        document.body.innerHTML = `${input}<textarea name="description"></textarea>${category}<input name="tags"><button>Publish</button>`;
        document.querySelector('button').onclick = () => renderPublished(recordEditor());
      };
    } else if (engine === 'aws-builder') {
      document.body.innerHTML = `${input}<textarea name="summary"></textarea><div data-slate-editor="true" contenteditable="true" role="textbox"></div><button>Publish</button>`;
      document.querySelector('[data-slate-editor]').onpaste = event => { event.preventDefault(); event.currentTarget.innerText = event.clipboardData.getData('text/plain'); window.steps.push('slate-paste'); };
      document.querySelector('button').onclick = () => {
        const record = recordEditor();
        const dialog = document.createElement('div'); dialog.setAttribute('role', 'dialog');
        dialog.innerHTML = `<h2>Publish article</h2><p>${record.title}</p><button>Publish article</button>`; document.body.append(dialog);
        dialog.querySelector('button').onclick = () => renderPublished(record);
      };
    } else if (engine === 'tinhte') {
      document.body.innerHTML = '<textarea class="title-input" placeholder="Nhập tiêu đề bài viết..."></textarea><div class="ck-editor__editable" contenteditable="true" role="textbox"></div><button>Đăng</button>';
      document.querySelector('[contenteditable]').onpaste = event => { event.preventDefault(); event.currentTarget.innerText = event.clipboardData.getData('text/plain'); window.steps.push('ckeditor-paste'); };
      document.querySelector('button').onclick = () => renderPublished(recordEditor());
    } else if (engine === 'pixelfed') {
      document.body.innerHTML = '<button>New Post</button><input type="file" hidden id="home-upload">';
      document.querySelector('button').onclick = () => {
        document.body.innerHTML = '<div class="compose-modal-component"><input type="file" id="pf-dz" hidden></div>';
        document.querySelector('input').oninput = async event => {
          window.uploads.push({ name: event.target.files[0].name, type: event.target.files[0].type, bytes: await event.target.files[0].text() });
          const next = document.createElement('button'); next.textContent = 'Next'; document.querySelector('.compose-modal-component').append(next);
          next.onclick = () => {
            document.querySelector('.compose-modal-component').innerHTML = '<textarea placeholder="Write a caption..."></textarea><button>Post</button>';
            document.querySelector('button').onclick = () => renderPublished(recordEditor());
          };
        };
      };
    }
  }, { engine, post, publishedPath: publishedPaths[engine], tweaks });
  const job = { jobId: `fixture-${engine}`, targetOrigin: origins[engine], openUrl: page.url(), recipe: EXTENSION_RECIPES[engine], post, autoSubmit: true,
    options: { tags: engine === 'slideshare' ? ['nginx', 'web server'] : [], category: engine === 'slideshare' ? 'Technology' : '', flair: '', sendEmail: false } };
  if (job.recipe.requiredMedia) job.attachments = [{ name: engine === 'slideshare' ? 'deck.pdf' : 'photo.png', mimeType: engine === 'slideshare' ? 'application/pdf' : 'image/png', base64: Buffer.from(engine === 'slideshare' ? '%PDF-1.4\nFixture presentation' : 'fixture image bytes').toString('base64') }];
  return { page, job, publishedUrl: origins[engine] + publishedPaths[engine] };
}

for (const engine of ['medium', 'substack', 'quora', 'reddit', 'slideshare', 'aws-builder', 'tinhte', 'pixelfed']) {
  test(`${engine}: fills the approved web content, completes all publish steps and verifies its permalink`, { timeout: 30_000 }, async () => {
    const { page, job, publishedUrl } = await fixture(engine);
    try {
      const result = await page.evaluate(fillSocialAndSubmit, job);
      assert.equal(result.status, 'submitted', result.message);
      const { records, uploads } = await page.evaluate(() => ({ records: window.records, uploads: window.uploads }));
      assert.equal(records.length, 1);
      assert.equal(records[0].title, post.title);
      // Native rich editors represent paragraph gaps with two or three newlines
      // in innerText. Verify every paragraph, rather than browser layout spacing.
      assert.equal(records[0].body.replace(/\n{2,}/g, '\n\n'), engine === 'quora' ? `${post.title}\n\n${post.body}` : post.body);
      if (['medium', 'substack'].includes(engine)) assert.equal(records[0].email, false);
      if (engine === 'slideshare') assert.equal(records[0].tags, 'nginx, web server');
      if (job.recipe.requiredMedia) { assert.equal(uploads.length, 1); assert.equal(uploads[0].name, job.attachments[0].name); }
      const task = { job, beforeUrls: result.beforeUrls };
      assert.equal(await page.evaluate(readSocialPublishedPost, task), publishedUrl);
      assert.equal(await page.evaluate(readSocialPublishedPost, { ...task, beforeUrls: [publishedUrl] }), null);
    } finally { await page.close(); }
  });
}

test('Quora personal post switches from Add Question, uses the document editor and submits only the modal Post', async () => {
  const { page, job, publishedUrl } = await fixture('quora', { personal: true });
  try {
    const result = await page.evaluate(fillSocialAndSubmit, job);
    assert.equal(result.status, 'submitted', result.message);
    assert.deepEqual(await page.evaluate(() => window.steps), ['open-question', 'create-post']);
    const records = await page.evaluate(() => window.records);
    assert.equal(records.length, 1);
    assert.equal(records[0].body.replace(/\n{2,}/g, '\n\n'), `${post.title}\n\n${post.body}`);
    const task = { job, beforeUrls: result.beforeUrls };
    assert.equal(await page.evaluate(readSocialPublishedPost, task), publishedUrl);
    assert.equal(await page.evaluate(readSocialPublishedPost, { ...task, beforeUrls: [publishedUrl] }), null);
  } finally { await page.close(); }
});

test('Quora personal dry run fills the actual editor and enables Post without submitting', async () => {
  const { page, job } = await fixture('quora', { personal: true });
  try {
    const result = await page.evaluate(fillSocialAndSubmit, { ...job, autoSubmit: false });
    assert.equal(result.status, 'filled', result.message);
    assert.equal(await page.locator('[role="dialog"] button.puppeteer_test_modal_submit').isEnabled(), true);
    assert.equal(await page.evaluate(() => window.records.length), 0);
  } finally { await page.close(); }
});

for (const tweaks of [{ wrongAudience: true }, { existingDraft: true }]) {
  test(`Quora does not overwrite a draft or use a different audience: ${Object.keys(tweaks)[0]}`, async () => {
    const { page, job } = await fixture('quora', { personal: true, ...tweaks });
    try {
      assert.equal((await page.evaluate(fillSocialAndSubmit, job)).status, 'notReady');
      assert.equal(await page.evaluate(() => window.records.length), 0);
      assert.equal(await page.locator('.doc').innerText(), tweaks.existingDraft ? 'My unrelated draft' : '');
    } finally { await page.close(); }
  });
}

test('Substack refuses to publish when the web-only delivery control cannot be verified', async () => {
  const { page, job } = await fixture('substack', { noEmailControl: true });
  try {
    const result = await page.evaluate(fillSocialAndSubmit, job);
    assert.equal(result.status, 'filled');
    assert.match(result.message, /chỉ đăng web/);
    assert.equal(await page.evaluate(() => window.records.length), 0);
  } finally { await page.close(); }
});

test('SlideShare reports the current upload outage without trying to attach or publish', async () => {
  const { page, job } = await fixture('slideshare', { outage: true });
  try {
    assert.equal((await page.evaluate(fillSocialAndSubmit, job)).status, 'unavailable');
    assert.deepEqual(await page.evaluate(() => window.uploads), []);
    assert.deepEqual(await page.evaluate(() => window.records), []);
  } finally { await page.close(); }
});

test('missing media stops before a file upload or final submit', async () => {
  const { page, job } = await fixture('slideshare'); delete job.attachments;
  try {
    assert.equal((await page.evaluate(fillSocialAndSubmit, job)).status, 'mediaRequired');
    assert.equal(await page.evaluate(() => window.records.length), 0);
  } finally { await page.close(); }
});

test('same title with different content is not a successful publish', async () => {
  const { page, job } = await fixture('substack');
  try {
    const result = await page.evaluate(fillSocialAndSubmit, job);
    await page.locator('.body.markup').evaluate(node => { node.textContent = 'An unrelated post'; });
    assert.equal(await page.evaluate(readSocialPublishedPost, { job, beforeUrls: result.beforeUrls }), null);
  } finally { await page.close(); }
});
