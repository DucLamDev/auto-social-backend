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
  // A wrong destination waits for the operator (NEEDS_ACTION); the editor itself was found.
  assert.equal((await page.evaluate(fill, job)).status, 'filled');
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

test('Differ pastes a multi-line Markdown post as rich content, opens its publish dialog, selects the configured keyword and publishes there', async () => {
  const page = await pageAt('https://differ.blog/new-story');
  // Differ's editor is MDXEditor (Lexical): it builds headings, lists and code
  // blocks from pasted HTML, while typed text would stay raw Markdown on one line.
  const body = '## Bước 1: cài Nginx\n\nCài gói từ kho chính thức rồi bật dịch vụ.\n\n- Mở cổng 80 và 443\n- Kiểm tra bằng `nginx -t`\n\n```bash\nsudo systemctl enable --now nginx\n```\n\nĐọc thêm [hướng dẫn](https://nginx.org/en/docs/) khi cần.';
  const bodyHtml = '<h2>Bước 1: cài Nginx</h2><p>Cài gói từ kho chính thức rồi bật dịch vụ.</p><ul><li>Mở cổng 80 và 443</li><li>Kiểm tra bằng <code>nginx -t</code></li></ul>'
    + '<pre><code class="language-bash">sudo systemctl enable --now nginx\n</code></pre><p>Đọc thêm <a href="https://nginx.org/en/docs/">hướng dẫn</a> khi cần.</p>';
  await page.evaluate(() => {
    window.sent = [];
    // The toolbar Publish only opens <dialog id="modal-submit">; its own submit button publishes.
    document.body.innerHTML = '<textarea name="title"></textarea><div contenteditable="true" aria-label="editable markdown"></div><button id="post-submit-button">Publish</button>'
      + '<dialog id="modal-submit" class="modal"><div class="rs__control"><div class="rs__placeholder">Select...</div><input class="rs__input" role="combobox"></div><div class="slot"></div><button type="submit">Publish</button></dialog>';
    const editor = document.querySelector('[contenteditable]');
    const dialog = document.querySelector('dialog');
    editor.addEventListener('paste', event => { event.preventDefault(); editor.innerHTML = event.clipboardData.getData('text/html'); });
    dialog.querySelector('.rs__control').addEventListener('mousedown', () => {
      const option = document.createElement('div'); option.className = 'rs__option'; option.textContent = 'nginx';
      option.onclick = () => { dialog.querySelector('.rs__placeholder').outerHTML = '<div class="rs__single-value">nginx</div>'; option.remove(); };
      dialog.querySelector('.slot').append(option);
    });
    document.querySelector('#post-submit-button').onclick = () => dialog.showModal();
    dialog.querySelector('button[type="submit"]').onclick = () => window.sent.push({ html: editor.innerHTML, keyword: dialog.querySelector('.rs__single-value')?.textContent ?? null });
  });
  const result = await page.evaluate(fill, { recipe: { ...EXTENSION_RECIPES.differ, inputMode: 'pasteHtml' }, targetOrigin: 'https://differ.blog', autoSubmit: true, options: { tags: ['nginx'] },
    post: { title: 'Cài Nginx trên Ubuntu 24.04', body, bodyHtml, maxChars: null, length: body.length, language: 'vi' } });
  assert.equal(result.status, 'submitted', JSON.stringify(result));
  const sent = await page.evaluate(() => window.sent);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].html, bodyHtml, 'the editor holds the rendered post, not raw Markdown');
  assert.equal(sent[0].keyword, 'nginx');
  await page.close();
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

test('Minds posts from the inline "Speak your mind" newsfeed composer without a Create button or audience picker', async () => {
  const page = await pageAt('https://www.minds.com/newsfeed/subscriptions/latest');
  await page.evaluate(() => {
    window.submits = 0;
    document.body.innerHTML = '<m-composer><m-composer__textarea><textarea class="m-composerTextarea__message" placeholder="Speak your mind..."></textarea></m-composer__textarea><m-composer__postbutton><button disabled>Post</button><button aria-label="More options"></button></m-composer__postbutton></m-composer>';
    const body = document.querySelector('textarea'), submit = document.querySelector('m-composer__postbutton button');
    body.oninput = () => { submit.disabled = !body.value.trim(); };
    submit.onclick = () => { window.submits++; };
  });
  const job = { recipe: EXTENSION_RECIPES.minds, targetOrigin: 'https://www.minds.com', openUrl: 'https://www.minds.com/newsfeed/subscriptions', post, autoSubmit: true };
  const result = await page.evaluate(fill, job);
  assert.equal(result.status, 'submitted', JSON.stringify(result));
  assert.equal(await page.evaluate(() => window.submits), 1);
  assert.equal(await page.locator('textarea').inputValue(), post.body);
  await page.close();
});

test('Stack Overflow accepts a tag shown as an ".s-tag" chip and commits a typed tag with Enter when no suggestion matches', async () => {
  const page = await pageAt('https://stackoverflow.com/questions/ask');
  await page.evaluate(() => {
    window.steps = [];
    document.body.innerHTML = '<input id="title"><textarea id="wmd-input"></textarea><div class="tag-editor"><span class="chips"></span><input id="filterInput" aria-label="tags"></div><ul role="listbox"></ul><button>Review your question</button><button id="final" hidden>Post your question</button>';
    const input = document.querySelector('#filterInput'), chips = document.querySelector('.chips'), list = document.querySelector('[role="listbox"]');
    const add = name => { chips.insertAdjacentHTML('beforeend', `<span class="s-tag">${name}<button aria-label="Remove tag">×</button></span>`); input.value = ''; list.innerHTML = ''; };
    // Suggestions carry counts; "nginx" is suggested, "proxy-pass" only commits on Enter.
    input.oninput = () => { list.innerHTML = input.value === 'nginx' ? '<li role="option"><span class="s-tag">nginx</span> × 51234</li>' : ''; const row = list.querySelector('li'); if (row) row.onclick = () => add('nginx'); };
    input.onkeydown = event => { if (event.key === 'Enter' && input.value) add(input.value); };
    document.querySelector('button:not(#final)').onclick = event => { window.steps.push('review'); event.target.hidden = true; document.querySelector('#final').hidden = false; };
    document.querySelector('#final').onclick = () => window.steps.push('post');
  });
  const result = await page.evaluate(fill, { recipe: EXTENSION_RECIPES.stackexchange, targetOrigin: 'https://stackoverflow.com', openUrl: page.url(), post, autoSubmit: true, options: { tags: ['nginx', 'proxy-pass'] } });
  assert.equal(result.status, 'submitted', JSON.stringify(result));
  assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll('.chips .s-tag')].map(node => node.firstChild.textContent)), ['nginx', 'proxy-pass']);
  assert.deepEqual(await page.evaluate(() => window.steps), ['review', 'post']);
  await page.close();
});

function stackOverflowEditor() {
  return known => {
    window.steps = []; window.enters = 0;
    document.body.innerHTML = '<input id="title"><textarea id="wmd-input"></textarea><div class="tag-editor"><span class="chips"></span><input id="filterInput" aria-label="tags"></div><ul role="listbox"></ul><button>Review your question</button><button id="final" hidden>Post your question</button>';
    const input = document.querySelector('#filterInput'), chips = document.querySelector('.chips'), list = document.querySelector('[role="listbox"]');
    const add = name => { chips.insertAdjacentHTML('beforeend', `<span class="s-tag">${name}<button aria-label="Remove tag">×</button></span>`); input.value = ''; list.innerHTML = ''; };
    input.oninput = () => { list.innerHTML = known.includes(input.value) ? `<li role="option"><span class="s-tag">${input.value}</span> × 120</li>` : ''; const row = list.querySelector('li'); if (row) { const name = input.value; row.onclick = () => add(name); } };
    input.onkeydown = event => { if (event.key === 'Enter' && input.value) { window.enters++; add(input.value); } };
    document.querySelector('button:not(#final)').onclick = event => { window.steps.push('review'); event.target.hidden = true; document.querySelector('#final').hidden = false; };
    document.querySelector('#final').onclick = () => window.steps.push('post');
  };
}

test('Stack Exchange posts with the AI suggested tags the site has, skipping unknown ones without creating them', async () => {
  const page = await pageAt('https://unix.stackexchange.com/questions/ask');
  await page.evaluate(stackOverflowEditor(), ['curl', 'dns']);
  const result = await page.evaluate(fill, { recipe: EXTENSION_RECIPES.stackexchange, targetOrigin: 'https://unix.stackexchange.com', openUrl: page.url(), post, autoSubmit: true, options: { tags: [], suggestedTags: ['curl', 'socks5-proxy', 'dns'] } });
  assert.equal(result.status, 'submitted', JSON.stringify(result));
  assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll('.chips .s-tag')].map(node => node.firstChild.textContent)), ['curl', 'dns']);
  assert.equal(await page.evaluate(() => window.enters), 0);
  assert.equal(await page.locator('#filterInput').inputValue(), '');
  assert.deepEqual(await page.evaluate(() => window.steps), ['review', 'post']);
  await page.close();
});

test('Stack Exchange stops before posting when none of the AI tags exist on the site, naming them', async () => {
  const page = await pageAt('https://unix.stackexchange.com/questions/ask');
  await page.evaluate(stackOverflowEditor(), []);
  const result = await page.evaluate(fill, { recipe: EXTENSION_RECIPES.stackexchange, targetOrigin: 'https://unix.stackexchange.com', openUrl: page.url(), post, autoSubmit: true, options: { tags: [], suggestedTags: ['made-up'] } });
  assert.equal(result.status, 'filled');
  assert.match(result.message, /tag có trên unix\.stackexchange\.com; các tag AI gợi ý \(made-up\)/);
  assert.deepEqual(await page.evaluate(() => window.steps), []);
  await page.close();
});

test('DEV fills the AI tags when the account has none configured, and keeps configured tags first', async () => {
  const page = await pageAt('https://dev.to/new');
  const form = '<form id="article-form" onsubmit="event.preventDefault();window.submits=(window.submits||0)+1"><textarea id="article-form-title"></textarea><input id="tag-input"><textarea id="article_body_markdown"></textarea><button type="submit">Publish</button></form>';
  const job = { recipe: EXTENSION_RECIPES.devto, targetOrigin: 'https://dev.to', openUrl: page.url(), post, autoSubmit: true };
  await page.setContent(form);
  const result = await page.evaluate(fill, { ...job, options: { tags: [], suggestedTags: ['vps', 'selfhosting'] } });
  assert.equal(result.status, 'submitted', JSON.stringify(result));
  assert.equal(await page.locator('#tag-input').inputValue(), 'vps, selfhosting');
  assert.equal(await page.evaluate(() => window.submits), 1);
  await page.setContent(form);
  await page.evaluate(fill, { ...job, options: { tags: ['webdev'], suggestedTags: ['vps'] } });
  assert.equal(await page.locator('#tag-input').inputValue(), 'webdev');
  await page.close();
});

test('a tag the site refuses is reported with that site name and nothing is posted', async () => {
  const page = await pageAt('https://serverfault.com/questions/ask');
  await page.evaluate(() => {
    window.steps = [];
    document.body.innerHTML = '<input id="title"><textarea id="wmd-input"></textarea><input id="filterInput" aria-label="tags"><button>Post your question</button>';
    document.querySelector('button').onclick = () => window.steps.push('post');
  });
  const result = await page.evaluate(fill, { recipe: EXTENSION_RECIPES.stackexchange, targetOrigin: 'https://serverfault.com', openUrl: page.url(), post, autoSubmit: true, options: { tags: ['not-a-real-tag'] } });
  assert.equal(result.status, 'filled');
  assert.match(result.message, /not-a-real-tag trên serverfault\.com/);
  assert.deepEqual(await page.evaluate(() => window.steps), []);
  await page.close();
});

test('a suspended account is reported as restricted before anything is filled', async () => {
  const page = await pageAt('https://discuit.org/new');
  await page.setContent('<textarea class="page-new-post-title"></textarea><textarea class="page-new-post-body"></textarea><div class="form-error">@vpsttt is suspended.</div>');
  const result = await page.evaluate(fill, { recipe: EXTENSION_RECIPES.discuit, targetOrigin: 'https://discuit.org', openUrl: page.url(), post, autoSubmit: true, options: { category: 'technology' } });
  assert.equal(result.status, 'restricted');
  assert.match(result.message, /đình chỉ/);
  assert.equal(await page.locator('.page-new-post-title').inputValue(), '');
  await page.close();
});
// Markup mirrors daily.dev's SmartComposerModal (dailydotdev/apps): a dialog with
// form#smart_composer, a title textarea, a TipTap body and a submit button bound
// to the form. Posting navigates to /posts/<slug>, which renders an h1 and the
// Markdown container (CSS-module class "markdown_…").
async function dailyDevComposer(page, draftTitle = '') {
  await page.evaluate(draftTitle => {
    window.submits = [];
    document.body.innerHTML = '<a href="/posts/an-older-post-xyz">Older post</a><div role="dialog"><form id="smart_composer">'
      + '<button type="button">Your profile</button><textarea name="title" aria-label="Post title" placeholder="Post title…"></textarea>'
      + '<button type="button" aria-label="Add a cover image">Add cover</button><div class="tiptap ProseMirror" contenteditable="true" role="textbox"></div>'
      + '<button type="button">Schedule</button><button form="smart_composer" type="submit" disabled>Post</button></form></div>';
    const form = document.querySelector('form'), title = form.querySelector('textarea'), body = form.querySelector('[contenteditable]'), submit = form.querySelector('[type="submit"]');
    title.value = draftTitle;
    const sync = () => { submit.disabled = !title.value.trim() || !body.innerText.trim(); };
    title.oninput = sync; body.oninput = sync;
    form.onsubmit = event => {
      event.preventDefault();
      const record = { title: title.value, body: body.innerText };
      window.submits.push(record);
      document.body.innerHTML = '<main><h1></h1><div class="markdown_markdown__a1B2c"></div></main>';
      document.querySelector('h1').textContent = record.title; document.querySelector('.markdown_markdown__a1B2c').textContent = record.body;
      history.pushState({}, '', '/posts/a-specific-technical-question-abc123');
    };
  }, draftTitle);
}
test('daily.dev fills the composer dialog, posts once and confirms the new post page', async () => {
  const page = await pageAt('https://daily.dev/squads/create');
  await dailyDevComposer(page);
  const job = { recipe: EXTENSION_RECIPES.dailydev, targetOrigin: 'https://daily.dev', openUrl: 'https://daily.dev/squads/create', post, autoSubmit: true };
  const result = await page.evaluate(fill, job);
  assert.equal(result.status, 'submitted', JSON.stringify(result));
  assert.deepEqual(await page.evaluate(() => window.submits), [{ title: post.title, body: post.body }]);
  assert.equal(await page.evaluate(read, { job, beforeUrls: result.beforeUrls }), 'https://daily.dev/posts/a-specific-technical-question-abc123');
  await page.close();
});
test('daily.dev keeps a saved draft and stops before Post when auto-submit is off', async () => {
  const page = await pageAt('https://daily.dev/squads/create');
  await dailyDevComposer(page, 'My own unfinished draft');
  const job = { recipe: EXTENSION_RECIPES.dailydev, targetOrigin: 'https://daily.dev', openUrl: 'https://daily.dev/squads/create', post, autoSubmit: true };
  assert.equal((await page.evaluate(fill, job)).status, 'draft');
  assert.equal(await page.locator('textarea').inputValue(), 'My own unfinished draft');
  await dailyDevComposer(page);
  assert.equal((await page.evaluate(fill, { ...job, autoSubmit: false })).status, 'filled');
  assert.equal(await page.locator('textarea').inputValue(), post.title);
  assert.deepEqual(await page.evaluate(() => window.submits), []);
  await page.close();
});

// Product Hunt "Start new thread" (producthunt.com/p/new) as in the operator's screenshot: the
// header has its own "Submit" (launch a product), the sidebar links read "p/general"…, the forum
// is picked in "Search for a product" (rows without roles; product forums appear when searched),
// then Title, a ProseMirror-like Body that takes pasted HTML, and the form's "Submit".
function productHuntPage() {
  {
    window.sent = []; window.launches = 0;
    document.body.innerHTML = '<header><a href="/">P</a><button type="button" id="launch">Submit</button></header>'
      + '<aside><a href="/p/general">p/general</a><a href="/p/self-promotion">p/self-promotion</a><a href="/p/google-cloud-platform">p/google-cloud-platform</a></aside>'
      + '<main><h1>Start new thread</h1><div class="picker"><div class="box"><svg></svg><input placeholder="Search for a product"></div><div class="menu"></div></div>'
      + '<p class="desc">Discuss anything: tips, startups, or product recommendations.</p><input placeholder="Title">'
      + '<div class="ProseMirror" contenteditable="true"></div><button type="button" id="send">Submit</button></main>';
    const input = document.querySelector('.box input'), menu = document.querySelector('.menu'), editor = document.querySelector('.ProseMirror');
    const topics = ['General', 'Vibecoding', 'Introduce yourself', 'Self-Promotion'], products = ['Google Cloud Platform', 'Nitrosend'];
    const render = query => {
      const names = query ? [...topics, ...products].filter(name => name.toLowerCase().includes(query.toLowerCase())) : topics;
      menu.innerHTML = names.map(name => `<div class="row"><svg></svg><span>${name}</span></div>`).join('');
      for (const row of menu.querySelectorAll('.row')) row.addEventListener('click', () => {
        window.forum = row.textContent;
        menu.innerHTML = '';
        input.remove();
        document.querySelector('.box').insertAdjacentHTML('beforeend', `<span class="chosen">${row.textContent}</span>`);
      });
    };
    input.addEventListener('focus', () => render(''));
    input.addEventListener('input', () => render(input.value));
    editor.addEventListener('paste', event => { event.preventDefault(); editor.innerHTML = event.clipboardData.getData('text/html'); });
    document.querySelector('#launch').onclick = () => { window.launches++; };
    document.querySelector('#send').onclick = () => window.sent.push({ forum: window.forum ?? null, title: document.querySelector('input[placeholder="Title"]').value, html: editor.innerHTML });
  }
}
const phPost = { title: 'How do you test a proxy before trusting it?', body: '## What I check\n\n- The exit IP\n- DNS leaks\n\nWhat do you check first?',
  bodyHtml: '<h2>What I check</h2><ul><li>The exit IP</li><li>DNS leaks</li></ul><p>What do you check first?</p>', maxChars: null, language: 'en' };

test('Product Hunt picks the configured forum (Self-Promotion when none) before writing, then clicks the form Submit, never the header one', async () => {
  for (const [category, expected] of [['', 'Self-Promotion'], ['General', 'General'], ['Google Cloud Platform', 'Google Cloud Platform']]) {
    const page = await pageAt('https://www.producthunt.com/p/new');
    try {
      await page.evaluate(productHuntPage);
      const result = await page.evaluate(fill, { recipe: EXTENSION_RECIPES.producthunt, targetOrigin: 'https://www.producthunt.com', openUrl: page.url(), autoSubmit: true,
        options: { tags: [], category }, post: { ...phPost, length: phPost.body.length } });
      assert.equal(result.status, 'submitted', `${category}: ${JSON.stringify(result)}`);
      const [sent, launches] = await page.evaluate(() => [window.sent, window.launches]);
      assert.equal(launches, 0, 'the header Submit (product launch) is never clicked');
      assert.equal(sent.length, 1);
      assert.equal(sent[0].forum, expected);
      assert.equal(sent[0].title, phPost.title);
      assert.equal(sent[0].html, phPost.bodyHtml);
    } finally { await page.close(); }
  }
});

test('Product Hunt stops before writing anything when the configured forum is not in the picker', async () => {
  const page = await pageAt('https://www.producthunt.com/p/new');
  try {
    await page.evaluate(productHuntPage);
    const result = await page.evaluate(fill, { recipe: EXTENSION_RECIPES.producthunt, targetOrigin: 'https://www.producthunt.com', openUrl: page.url(), autoSubmit: true,
      options: { tags: [], category: 'Not A Forum' }, post: { ...phPost, length: phPost.body.length } });
    assert.equal(result.status, 'filled', JSON.stringify(result));
    assert.match(result.message, /Không thấy forum \/ product “Not A Forum”/);
    assert.deepEqual(await page.evaluate(() => [document.querySelector('input[placeholder="Title"]').value, document.querySelector('.ProseMirror').innerHTML, window.sent.length, window.launches]), ['', '', 0, 0]);
  } finally { await page.close(); }
});

test('Product Hunt recognises the new thread at /p/<forum>/<slug> and not the composer page', () => {
  const pattern = new RegExp(EXTENSION_RECIPES.producthunt.successUrlPattern);
  assert.equal(pattern.test('https://www.producthunt.com/p/self-promotion/how-do-you-test-a-proxy'), true);
  assert.equal(pattern.test('https://www.producthunt.com/p/new'), false);
  assert.equal(pattern.test('https://www.producthunt.com/p/new/whatever'), false);
  assert.equal(pattern.test('https://www.producthunt.com/p/general'), false);
});
