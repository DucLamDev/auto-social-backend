// WordPress block editor (wp-admin/post-new.php): a stand-in for the editor's data API
// (wp.data, wp.blocks, wp.apiFetch) with the shapes Gutenberg exposes. Every request is
// intercepted; these tests never reach a real site.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

let browser, fillWordPress;
before(async () => {
  const source = fs.readFileSync(path.join(__dirname, '../../browser-extension/wordpress-actions.js'), 'utf8');
  ({ fillWordPress } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`));
  browser = await chromium.launch();
});
after(async () => browser?.close());

// canPublish: an Author/Editor post carries the publish action; a Contributor's does not.
const editorPage = ({ canPublish = true, title = '' } = {}) => `<!doctype html><body><div class="block-editor"></div><script>
  const state = { title: ${JSON.stringify(title)}, blocks: [], status: 'auto-draft', featured: 0, saved: null, saves: 0 };
  const post = () => ({ id: 41, type: 'post', status: state.saved ? state.saved.status : 'auto-draft', link: state.saved?.status === 'publish' ? location.origin + '/2026/11/keeping-a-vps-patched/' : location.origin + '/?p=41',
    _links: ${canPublish} ? { 'wp:action-publish': [{ href: 'x' }] } : {} });
  window.state = state;
  window.wp = {
    blocks: {
      rawHandler: ({ HTML }) => [...new DOMParser().parseFromString(HTML, 'text/html').body.children].map(node => ({ name: 'core/' + node.tagName.toLowerCase(), html: node.outerHTML })),
      createBlock: (name, attributes) => ({ name, html: '<figure><img src="' + attributes.url + '"></figure>' }),
    },
    apiFetch: async ({ path, method }) => (path === '/wp/v2/media' && method === 'POST' ? { id: 77, source_url: location.origin + '/wp-content/uploads/cover.png' } : null),
    data: {
      select: store => store === 'core/editor' ? {
        getCurrentPost: post,
        getEditedPostAttribute: key => (key === 'title' ? state.title : key === 'status' ? state.status : undefined),
        getEditedPostContent: () => state.blocks.map(block => block.html).join(''),
        didPostSaveRequestSucceed: () => Boolean(state.saved),
      } : { getLastEntitySaveError: () => null },
      dispatch: store => store === 'core/editor' ? {
        editPost: edits => { if ('title' in edits) state.title = edits.title; if ('status' in edits) state.status = edits.status; if ('featured_media' in edits) state.featured = edits.featured_media; },
        savePost: async () => { state.saves++; state.saved = { status: state.status }; },
      } : {
        resetBlocks: list => { state.blocks = list; },
        insertBlocks: (block, index) => { state.blocks.splice(index, 0, block); },
      },
    },
  };
</script></body>`;
async function open(body) {
  const page = await browser.newPage();
  await page.route('**/*', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body }));
  await page.goto('https://blog.vpsttt.test/wp-admin/post-new.php');
  return page;
}
const job = (extra = {}) => ({ autoSubmit: true, post: { title: 'Keeping a VPS patched', body: 'Security updates daily.\n\n- unattended-upgrades', bodyHtml: '<p>Security updates daily.</p><ul><li>unattended-upgrades</li></ul>' }, ...extra });
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMB/6XFkxkAAAAASUVORK5CYII=';

test('WordPress: writes the title and the post as blocks, adds the image as featured and first block, publishes once and returns the permalink', async () => {
  const page = await open(editorPage());
  try {
    const result = await page.evaluate(fillWordPress, job({ attachments: [{ name: 'cover.png', mimeType: 'image/png', base64: png, altText: 'A server rack' }] }));
    assert.deepEqual(result, { status: 'published', url: 'https://blog.vpsttt.test/2026/11/keeping-a-vps-patched/' });
    const state = await page.evaluate(() => ({ ...window.state, blocks: window.state.blocks.map(block => block.name) }));
    assert.equal(state.title, 'Keeping a VPS patched');
    assert.deepEqual(state.blocks, ['core/image', 'core/p', 'core/ul']);
    assert.equal(state.featured, 77);
    assert.equal(state.saves, 1);
  } finally { await page.close(); }
});

test('WordPress: a Contributor submits for review, auto-submit off only fills, and another draft is never overwritten', async () => {
  let page = await open(editorPage({ canPublish: false }));
  try {
    const result = await page.evaluate(fillWordPress, job());
    assert.equal(result.status, 'moderation');
    assert.equal(await page.evaluate(() => window.state.saved.status), 'pending');
  } finally { await page.close(); }
  page = await open(editorPage());
  try {
    assert.equal((await page.evaluate(fillWordPress, job({ autoSubmit: false }))).status, 'filled');
    assert.equal(await page.evaluate(() => window.state.saves), 0);
  } finally { await page.close(); }
  page = await open(editorPage({ title: 'My own unfinished post' }));
  try {
    assert.equal((await page.evaluate(fillWordPress, job())).status, 'draft');
    assert.equal(await page.evaluate(() => window.state.title), 'My own unfinished post');
  } finally { await page.close(); }
});
