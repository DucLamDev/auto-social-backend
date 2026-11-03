const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require('playwright');
const { EXTENSION_RECIPES } = require('../../src/connectors/extension/extension-delivery.ts');

// Simulated composers of the four destinations that take one planned image.
let browser, fill;
before(async () => {
  ({ fillSocialAndSubmit: fill } = await import(`data:text/javascript;base64,${Buffer.from(fs.readFileSync('browser-extension/social-actions.js', 'utf8')).toString('base64')}`));
  browser = await chromium.launch({ headless: true });
});
after(async () => browser?.close());

const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const image = { name: 'photo.png', mimeType: 'image/png', sizeBytes: png.length, base64: png.toString('base64'), altText: 'Bảng điều khiển VPS' };
const post = { title: '', body: 'VPS NVMe triển khai trong 60 giây, có người hỗ trợ bằng tiếng Việt.' };

async function pageAt(url, html, script) {
  const page = await browser.newPage();
  await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: '<main></main>' }));
  await page.goto(url);
  await page.setContent(html);
  await page.evaluate(script);
  return page;
}
const job = (engine, origin, url, extra = {}) => ({ recipe: { ...EXTENSION_RECIPES[engine], ...extra.recipe }, targetOrigin: origin, openUrl: url, post, autoSubmit: true, attachments: [image], ...extra.job });

test('Mastodon puts the image in the hidden upload input, waits for the upload, then publishes once', async () => {
  const page = await pageAt('https://mastodon.social/publish',
    '<form class="compose-form"><textarea id="composer-text"></textarea><label><input type="file" accept="image/*" style="display:none"></label><div class="compose-form__publish"><button type="button">Publish</button></div></form>',
    () => {
      window.submits = 0;
      const form = document.querySelector('.compose-form');
      form.querySelector('input[type=file]').onchange = event => {
        window.attached = event.target.files[0]?.name;
        form.insertAdjacentHTML('beforeend', '<div class="compose-form__upload"><div class="upload-progress">Uploading…</div></div>');
        setTimeout(() => form.querySelector('.upload-progress').remove(), 400);
      };
      form.querySelector('.compose-form__publish button').onclick = () => { window.submits++; window.uploading = Boolean(form.querySelector('.upload-progress')); };
    });
  const result = await page.evaluate(fill, job('mastodon', 'https://mastodon.social', page.url()));
  assert.equal(result.status, 'submitted', JSON.stringify(result));
  assert.deepEqual(await page.evaluate(() => [window.attached, window.submits, window.uploading]), ['photo.png', 1, false]);
  await page.close();
});

test('Bluesky receives the image as a paste into its editor', async () => {
  const page = await pageAt('https://bsky.app/intent/compose',
    '<div role="dialog"><div data-testid="composerTextInput" contenteditable="true"></div><button data-testid="composerPublishBtn">Post</button></div>',
    () => {
      window.submits = 0;
      const dialog = document.querySelector('[role=dialog]');
      dialog.querySelector('[contenteditable]').addEventListener('paste', event => {
        const file = event.clipboardData?.files?.[0];
        if (!file) return;
        event.preventDefault(); window.pasted = file.type;
        dialog.insertAdjacentHTML('beforeend', `<div data-testid="composerImageGallery"><img style="width:40px;height:40px" src="${URL.createObjectURL(file)}"></div>`);
      });
      dialog.querySelector('button').onclick = () => window.submits++;
    });
  const result = await page.evaluate(fill, job('bluesky', 'https://bsky.app', page.url()));
  assert.equal(result.status, 'submitted', JSON.stringify(result));
  assert.deepEqual(await page.evaluate(() => [window.pasted, window.submits]), ['image/png', 1]);
  assert.equal(await page.locator('[contenteditable]').innerText(), post.body);
  await page.close();
});

test('LinkedIn opens Add media, confirms the image step with Next and fills the alt text', async () => {
  const page = await pageAt('https://www.linkedin.com/feed/',
    '<div role="dialog"><div class="ql-editor" contenteditable="true"></div><button type="button">Add media</button><button type="button" class="share-actions__primary-action">Post</button></div>',
    () => {
      window.submits = 0;
      const dialog = document.querySelector('[role=dialog]');
      dialog.querySelector('button').onclick = () => {
        dialog.insertAdjacentHTML('beforeend', '<input type="file" accept="image/*" hidden>');
        dialog.querySelector('input[type=file]').onchange = () => {
          dialog.insertAdjacentHTML('beforeend', '<button type="button" id="next">Next</button>');
          dialog.querySelector('#next').onclick = event => {
            event.target.remove();
            dialog.insertAdjacentHTML('beforeend', '<div class="share-creation-state__media"><img style="width:40px;height:40px" src="blob:https://www.linkedin.com/1"></div><textarea name="alt-text"></textarea>');
          };
        };
      };
      dialog.querySelector('.share-actions__primary-action').onclick = () => window.submits++;
    });
  const result = await page.evaluate(fill, job('linkedin', 'https://www.linkedin.com', page.url()));
  assert.equal(result.status, 'submitted', JSON.stringify(result));
  assert.equal(await page.evaluate(() => window.submits), 1);
  assert.equal(await page.locator('textarea[name="alt-text"]').inputValue(), image.altText);
  await page.close();
});

test('Tumblr opens its photo block and posts once the image shows in the editor', async () => {
  const page = await pageAt('https://www.tumblr.com/new/text',
    '<div><div contenteditable="true" data-placeholder="Title"></div><div contenteditable="true" data-placeholder="Your text here"></div><button type="button">Photo</button><button type="button" aria-label="Post">Post</button></div>',
    () => {
      window.submits = 0;
      document.querySelector('button').onclick = () => {
        document.body.insertAdjacentHTML('beforeend', '<input type="file" accept="image/*" hidden>');
        document.querySelector('input[type=file]').onchange = () => document.body.insertAdjacentHTML('beforeend', '<figure><img style="width:40px;height:40px" src="blob:https://www.tumblr.com/1"></figure>');
      };
      document.querySelector('[aria-label=Post]').onclick = () => window.submits++;
    });
  const result = await page.evaluate(fill, job('tumblr', 'https://www.tumblr.com', page.url(), { job: { post: { ...post, title: 'VPS NVMe cho lập trình viên' } } }));
  assert.equal(result.status, 'submitted', JSON.stringify(result));
  assert.equal(await page.evaluate(() => window.submits), 1);
  await page.close();
});

test('a composer that never shows the image is filled but never submitted', async () => {
  const page = await pageAt('https://mastodon.social/publish',
    '<form class="compose-form"><textarea id="composer-text"></textarea><input type="file" style="display:none"><div class="compose-form__publish"><button type="button">Publish</button></div></form>',
    () => { window.submits = 0; document.querySelector('.compose-form__publish button').onclick = () => window.submits++; });
  const result = await page.evaluate(fill, job('mastodon', 'https://mastodon.social', page.url(), { recipe: { mediaWaitMs: 300 } }));
  assert.equal(result.status, 'filled');
  assert.match(result.message, /chưa gắn được ảnh/);
  assert.equal(await page.evaluate(() => window.submits), 0);
  assert.equal(await page.locator('textarea').inputValue(), post.body);
  await page.close();
});

test('a text-only post on the same composer skips the image step', async () => {
  const page = await pageAt('https://mastodon.social/publish',
    '<form class="compose-form"><textarea id="composer-text"></textarea><input type="file" style="display:none"><div class="compose-form__publish"><button type="button">Publish</button></div></form>',
    () => { window.submits = 0; document.querySelector('.compose-form__publish button').onclick = () => window.submits++; });
  const result = await page.evaluate(fill, job('mastodon', 'https://mastodon.social', page.url(), { job: { attachments: undefined } }));
  assert.equal(result.status, 'submitted', JSON.stringify(result));
  assert.equal(await page.evaluate(() => window.submits), 1);
  await page.close();
});
