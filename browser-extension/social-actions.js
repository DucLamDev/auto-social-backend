// These functions are injected by value into the signed-in destination tab.
// Keep every helper inside the function: extension modules are not in page scope.
export async function fillSocialAndSubmit(job) {
  const { recipe, post, options = {} } = job;
  const engine = recipe.engine;
  // Compatibility for already queued recipes on Mastodon's redesigned composer.
  const bodySelectors = engine === 'mastodon' ? ['textarea#composer-text', ...recipe.bodySelectors]
    : engine === 'quora' ? ['[role="dialog"] .doc[contenteditable="true"]', ...recipe.bodySelectors] : recipe.bodySelectors;
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const normalize = value => String(value ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim();
  const roots = () => {
    const result = [document];
    for (let i = 0; i < result.length; i++) for (const node of result[i].querySelectorAll('*')) if (node.shadowRoot) result.push(node.shadowRoot);
    return result;
  };
  const all = selector => roots().flatMap(root => [...root.querySelectorAll(selector)]);
  const visible = node => node && node.getClientRects().length > 0 && getComputedStyle(node).visibility !== 'hidden';
  const enabled = node => visible(node) && !node.disabled && node.getAttribute('aria-disabled') !== 'true';
  const pick = selectors => {
    for (const selector of selectors ?? []) {
      const found = all(selector).filter(visible);
      if (found.length === 1) return found[0];
    }
    return null;
  };
  const button = labels => {
    const dialogs = all('[role="dialog"], .modal.show, .compose-modal-component').filter(visible);
    const candidates = all('button, [role="button"], [role="tab"], input[type="submit"], a').filter(enabled);
    const matches = candidates.filter(node => labels.some(label => [node.innerText, node.getAttribute('aria-label'), node.value].some(text => normalize(text).toLowerCase() === label.toLowerCase())));
    const scoped = dialogs.length ? matches.filter(node => dialogs.at(-1).contains(node)) : [];
    return (scoped.length === 1 ? scoped : matches).length === 1 ? (scoped.length === 1 ? scoped[0] : matches[0]) : null;
  };
  const wait = async (find, timeout = 20_000) => {
    const end = Date.now() + timeout;
    do { const result = find(); if (result) return result; await sleep(200); } while (Date.now() < end);
    return null;
  };
  const value = node => normalize(node?.isContentEditable ? node.innerText : node?.value);
  const write = (node, text) => {
    if (!enabled(node)) return false;
    node.focus();
    if (node.isContentEditable) {
      // An empty heading/paragraph has no native caret position until it has
      // a line break (real editors normally render this placeholder themselves).
      if (!node.childNodes.length) node.append(document.createElement('br'));
      node.closest('[contenteditable="true"]')?.focus();
      const selection = window.getSelection(); const range = document.createRange();
      range.selectNodeContents(node); selection.removeAllRanges(); selection.addRange(range);
      if (node.matches('[data-slate-editor="true"], .ck-editor__editable')) {
        const data = new DataTransfer(); data.setData('text/plain', text);
        const paste = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data });
        node.dispatchEvent(paste);
        if (paste.defaultPrevented) return true;
      }
      if (!document.execCommand('insertText', false, text)) return false;
      node.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
    } else {
      const proto = node.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(node, text);
      node.dispatchEvent(new Event('input', { bubbles: true })); node.dispatchEvent(new Event('change', { bubbles: true }));
    }
    return true;
  };
  const fail = message => ({ status: 'notReady', message });
  const needs = message => ({ status: 'filled', message });
  const captcha = () => (recipe.captchaSelectors ?? []).some(selector => all(selector).some(visible));
  const expectedBody = engine === 'quora' && post.title ? `${post.title}\n\n${post.body}` : post.body;
  const beforeUrls = [...new Set(all('a[href]').map(node => node.href))].slice(0, 2000);
  if (location.origin !== job.targetOrigin) return fail('Trang đã chuyển sang tên miền khác; chưa điền hay gửi bài.');
  if (engine === 'devto' && /your account has been suspended/i.test(document.querySelector('main')?.innerText || document.body.innerText)) {
    return { status: 'restricted', message: 'DEV đã đình chỉ tài khoản này và hạn chế đăng bài. Cần giải quyết với DEV trước khi thử lại.' };
  }
  if (captcha()) return { status: 'captcha', message: 'Nền tảng yêu cầu CAPTCHA. Hoàn thành trong tab rồi tiếp tục từ web.' };
  if ((recipe.loginSelectors ?? []).some(selector => all(selector).some(visible))) return { status: 'login', message: 'Đăng nhập tài khoản trong Chrome trước khi chạy luồng.' };
  if (/you must be logged in|please sign in to continue|bạn (?:cần|phải) đăng nhập/i.test(document.body.innerText)) return { status: 'login', message: 'Nền tảng yêu cầu đăng nhập trước khi tạo bài.' };
  if (engine === 'slideshare' && /(?:uploads?|uploading).{0,80}(?:unavailable|disabled|temporarily suspended)/i.test(document.body.innerText)) {
    return { status: 'unavailable', message: 'SlideShare đang tạm ngừng nhận file upload. Bài chưa được gửi.' };
  }

  const quoraPersonal = engine === 'quora' && new URL(job.openUrl).hostname === 'www.quora.com';
  const quoraAudienceMatches = () => !quoraPersonal || all('[role="dialog"] button').some(node => visible(node) && ['everyone', 'mọi người'].includes(normalize(node.innerText).toLowerCase()));
  if (engine === 'quora') {
    if (!pick(bodySelectors)) {
      // The header has two "Add question" buttons; the second opens a menu.
      // Choose the composer button, or switch an already-open question dialog.
      let postTab = button(['Create Post', 'Tạo bài viết']);
      if (!postTab) {
        const open = await wait(() => quoraPersonal
          ? pick(['button[aria-label="Add question"]:not([aria-haspopup="menu"])']) ?? button(['Ask', 'Hỏi'])
          : button(['Add a post', 'Create post', 'Post', 'Thêm bài viết', 'Tạo bài viết']));
        if (!open) return fail('Không thấy nút mở trình soạn bài Quora. Kiểm tra đúng tài khoản và nơi đăng.');
        open.click();
        postTab = await wait(() => button(['Create Post', 'Tạo bài viết']), 1500);
      }
      postTab?.click();
    }
    if (!await wait(() => pick(bodySelectors), 10_000)) return fail('Chưa chuyển được Quora sang Create Post; chưa điền hoặc gửi bài.');
    if (!quoraAudienceMatches()) return fail('Bài cá nhân Quora chưa ở chế độ Everyone. Kiểm tra đối tượng xem bài; chưa gửi bài.');
    const current = value(pick(bodySelectors)).replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
    if (current && current !== normalize(expectedBody)) return fail('Quora đang có bản nháp khác trong khung soạn. Lưu hoặc đóng bản nháp đó trước khi chạy bài mới.');
  }
  if (engine === 'pixelfed' && !pick(['.compose-modal-component', '#composeModal', 'textarea[placeholder*="caption" i]'])) {
    const open = await wait(() => button(['New Post', 'Create new post', 'Compose', 'Create', 'New post', 'Đăng bài'])
      ?? pick(['a[href="/i/compose"]', '[data-toggle="modal"][data-target="#composeModal"]', 'button[aria-label="Create a post"]']));
    if (!open) return fail('Không tìm thấy nút tạo bài Pixelfed.');
    open.click();
    const photos = await wait(() => button(['Photos', 'Photo', 'Photo / Video', 'Ảnh']), 1500);
    photos?.click();
  }

  if (recipe.requiredMedia) {
    if (job.attachments?.length !== 1) return { status: 'mediaRequired', message: `Luồng này cần đúng một ${recipe.requiredMedia === 'image' ? 'ảnh' : 'file PDF'} đính kèm trên web.` };
    const fileInput = await wait(() => {
      const inputs = all('input[type="file"]').filter(node => !node.disabled);
      return inputs.length === 1 ? inputs[0] : inputs.find(node => node.id === 'pf-dz');
    });
    if (!fileInput) return fail('Không tìm thấy ô tải file; chưa gửi bài.');
    const asset = job.attachments[0];
    const data = Uint8Array.from(atob(asset.base64), char => char.charCodeAt(0));
    const transfer = new DataTransfer(); transfer.items.add(new File([data], asset.name, { type: asset.mimeType }));
    fileInput.files = transfer.files;
    fileInput.dispatchEvent(new Event('input', { bubbles: true })); fileInput.dispatchEvent(new Event('change', { bubbles: true }));
    if (engine === 'pixelfed') {
      // Image selection -> crop/filter -> caption. Each Next is a separate
      // screen; never use a publish label to advance past an unknown screen.
      for (let step = 0; step < 3 && !pick(recipe.bodySelectors); step++) {
        const next = await wait(() => pick(recipe.bodySelectors) ?? button(['Next', 'Tiếp theo']), 30_000);
        if (!next) return fail('Ảnh chưa tải xong hoặc không nhận diện được bước chỉnh ảnh.');
        if (next.matches('textarea, [contenteditable]')) break;
        next.click(); await sleep(500);
      }
    }
  }

  const body = await wait(() => pick(bodySelectors), recipe.requiredMedia ? 45_000 : 20_000);
  let title = pick(recipe.titleSelectors);
  if (!body) return fail('Không nhận diện được trình soạn thảo của nền tảng; chưa bấm đăng.');
  if (recipe.titleSelectors.length && !title) return fail('Không xác định được ô tiêu đề duy nhất; chưa gửi bài.');
  if (title && !write(title, post.title)) return fail('Không điền được tiêu đề.');
  if (engine === 'medium' && title && body.contains(title)) {
    // Medium's title and body share a contenteditable section. Preserve the
    // title block and write only the story paragraph below it.
    const paragraph = [...body.querySelectorAll('p')].find(node => node !== title && !title.contains(node));
    if (!paragraph || !write(paragraph, expectedBody)) return fail('Không tìm thấy đoạn nội dung riêng trong editor Medium.');
  } else if (!write(body, expectedBody)) return fail('Không điền được nội dung.');
  const summary = pick(['textarea[name="summary"]', 'input[name="summary"]', 'textarea[placeholder*="summary" i]']);
  if (summary) write(summary, post.summary || post.body.split('\n').find(line => line.trim())?.slice(0, 240) || post.title);
  await sleep(500);
  const validContent = () => {
    title = pick(recipe.titleSelectors);
    const currentBody = pick(bodySelectors);
    return (!recipe.titleSelectors.length || value(title) === normalize(post.title))
      && (engine === 'medium' ? value(currentBody).includes(normalize(expectedBody)) : value(currentBody) === normalize(expectedBody));
  };
  if (!validContent()) return fail('Editor không giữ đúng tiêu đề/nội dung từ web; chưa gửi bài.');
  const characterLimit = engine === 'bluesky' ? 300 : engine === 'mastodon' ? 500 : null;
  if (characterLimit && [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(expectedBody)].length > characterLimit) return needs(`Nội dung vượt ${characterLimit} ký tự của kênh này. Cần tạo lại bản ngắn hơn trên web.`);

  const choose = async (name, selectors, openLabels) => {
    if (!name) return true;
    let field = pick(selectors);
    if (!field) { const open = button(openLabels); if (!open) return false; open.click(); field = await wait(() => pick(selectors), 3000); }
    if (field?.tagName === 'SELECT') {
      const option = [...field.options].find(item => normalize(item.textContent).toLowerCase() === name.toLowerCase() || item.value === name);
      if (!option) return false;
      field.value = option.value; field.dispatchEvent(new Event('change', { bubbles: true }));
      return field.value === option.value;
    }
    if (field && ['INPUT', 'TEXTAREA'].includes(field.tagName)) write(field, name); else field?.click();
    const row = await wait(() => {
      const matches = all('[role="option"], [role="radio"], label, li, button').filter(enabled)
        .filter(node => normalize(node.innerText).toLowerCase() === name.toLowerCase());
      const deepest = matches.filter(node => !matches.some(other => other !== node && node.contains(other)));
      return deepest.length === 1 ? deepest[0] : null;
    }, 5000);
    if (!row) return false;
    row.click(); await sleep(300);
    const apply = button(['Apply', 'Add', 'Save', 'Áp dụng', 'Thêm']); apply?.click();
    await sleep(300);
    return all('[aria-selected="true"], [aria-checked="true"], .selected, .tag, .chip, [data-testid*="flair"], button, [role="combobox"]').some(node => visible(node) && normalize(node.innerText).toLowerCase().includes(name.toLowerCase()));
  };
  if (!await choose(options.category, ['select[name="category"]', 'select[name="node_id"]', '[role="combobox"][aria-label*="category" i]', 'input[placeholder*="chuyên mục" i]'], ['Category', 'Chuyên mục', 'Chọn chuyên mục'])) return needs('Không chọn được chuyên mục đã cấu hình. Sửa cấu hình trên web trước khi thử lại.');
  if (engine === 'reddit' && !await choose(options.flair, ['[role="dialog"] input[placeholder*="Search" i]', '[role="dialog"] input[type="search"]'], ['Add flair and tags', 'Add tags and flair', 'Add tags and flairs', 'Flair', 'Thêm flair'])) return needs('Không chọn được flair của subreddit.');

  // Stop before entering a publish confirmation if automatic submission is off.
  if (!job.autoSubmit) return { status: 'filled', beforeUrls };
  if (captcha()) return { status: 'captcha' };
  if (!validContent()) return needs('Nội dung thay đổi khi chọn chuyên mục/flair. Chưa bấm đăng.');

  if (engine === 'medium' || engine === 'substack') {
    const proceed = button(engine === 'medium' ? ['Publish', 'Xuất bản'] : ['Continue', 'Tiếp tục']);
    if (!proceed) return needs('Không thấy bước tiếp theo của màn hình xuất bản.');
    proceed.click();
    const final = await wait(() => button(['Publish now', 'Publish', 'Publish and send now', 'Send to everyone now', 'Xuất bản ngay']));
    if (!final) return needs('Không thấy màn hình xác nhận xuất bản.');
    // This workflow is explicitly web-only. Substack must expose a delivery
    // control; an unknown layout must never silently send a newsletter.
    const emailControls = all('input[type="checkbox"], [role="checkbox"], [role="switch"]').filter(visible).filter(node => {
      const label = normalize(node.getAttribute('aria-label') || [...(node.labels ?? [])].map(item => item.innerText).join(' ') || node.closest('label')?.innerText || node.parentElement?.innerText);
      return /send via email|email.*subscribers|email.*app inbox|gửi.*email/i.test(label);
    });
    if (engine === 'substack' && emailControls.length !== 1) return needs('Không xác nhận được tuỳ chọn chỉ đăng web của Substack; chưa xuất bản.');
    for (const control of emailControls) {
      if (control.checked === true || control.getAttribute('aria-checked') === 'true') control.click();
      await sleep(200);
      if (control.checked === true || control.getAttribute('aria-checked') === 'true') return needs('Không tắt được gửi email; chưa xuất bản.');
    }
    if (engine === 'medium' && !emailControls.length && /send/i.test(normalize(final.innerText))) return needs('Medium vẫn đang yêu cầu gửi email; chưa xuất bản.');
  }
  const plainTags = ['slideshare', 'devto'].includes(engine) ? pick(['#tag-input', 'input[name="tags"]:not([role="combobox"]):not([aria-autocomplete])']) : null;
  if (plainTags && options.tags?.length && (!write(plainTags, options.tags.join(', ')) || value(plainTags) !== normalize(options.tags.join(', ')))) return needs('Không điền được tags của SlideShare; chưa xuất bản.');
  for (const tag of plainTags ? [] : options.tags ?? []) {
    if (!await choose(tag, ['input[placeholder*="Add a topic" i]', 'input[placeholder*="Add tags" i]', 'input[placeholder*="Search tags" i]', 'input[name="tags"]'], ['Add tags', 'Topics', 'Tags'])) return needs(`Không chọn được tag “${tag}”; chưa bấm đăng.`);
  }
  if (captcha()) return { status: 'captcha' };
  if (!quoraAudienceMatches()) return needs('Đối tượng xem bài Quora đã thay đổi; chưa bấm Post.');
  const finalLabels = {
    medium: ['Publish now', 'Xuất bản ngay'], substack: ['Publish', 'Publish now'], quora: ['Post', 'Đăng'],
    reddit: ['Post', 'Đăng'], slideshare: ['Publish'], 'aws-builder': ['Publish', 'Publish article'],
    tinhte: ['Đăng', 'Đăng bài', 'Đăng bài viết', 'Xuất bản'], pixelfed: ['Post', 'Share', 'Publish', 'Đăng'],
    mastodon: ['Publish!', 'Publish', 'Post', 'Đăng', 'Đăng bài'], bluesky: ['Post', 'Đăng'], tumblr: ['Post', 'Post now', 'Đăng'], devto: ['Publish', 'Xuất bản'],
  }[engine];
  const submit = await wait(() => { const target = pick(recipe.submitSelectors); return target && enabled(target) ? target : button(finalLabels ?? []); }, 5000);
  if (!submit) return needs('Nút đăng chưa sẵn sàng. Kiểm tra các trường bắt buộc hoặc quyền của tài khoản.');
  if (!['medium', 'substack'].includes(engine) && !validContent()) return needs('Nội dung không còn khớp với bài trên web; chưa đăng.');
  submit.click();
  if (engine === 'aws-builder') {
    const confirmation = await wait(() => all('[role="dialog"]').find(node => visible(node)
      && /publish article|publish your article/i.test(node.innerText) && normalize(node.innerText).includes(normalize(post.title))), 1500);
    if (confirmation) {
      const confirm = [...confirmation.querySelectorAll('button')].filter(enabled).filter(node => ['publish', 'publish article'].includes(normalize(node.innerText).toLowerCase()));
      if (confirm.length !== 1) return { status: 'uncertain', message: 'Đã mở bước xuất bản AWS nhưng chưa xác nhận được kết quả.' };
      confirm[0].click();
    }
  }
  return { status: 'submitted', beforeUrls };
}

export async function readSocialPublishedPost(task) {
  const { job } = task;
  if (location.origin !== job.targetOrigin) return null;
  const roots = [document];
  for (let i = 0; i < roots.length; i++) for (const node of roots[i].querySelectorAll('*')) if (node.shadowRoot) roots.push(node.shadowRoot);
  const all = selector => roots.flatMap(root => [...root.querySelectorAll(selector)]);
  const visible = node => node && node.getClientRects().length > 0 && getComputedStyle(node).visibility !== 'hidden';
  const words = text => (String(text ?? '').normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).join(' ');
  const expectedTitle = words(job.post.title);
  const body = job.recipe.engine === 'quora' && job.post.title ? `${job.post.title}\n\n${job.post.body}` : job.post.body;
  const expectedBody = words(body.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')).split(' ').slice(0, 40).join(' ');
  if (!expectedBody) return null;
  const pattern = new RegExp(job.recipe.successUrlPattern);
  const validUrl = value => {
    try { const url = new URL(value, location.href); return url.href !== job.openUrl && url.origin === job.targetOrigin && pattern.test(url.href)
      && !(task.beforeUrls ?? []).includes(url.href) && !/\/(publish|edit|draft|create|upload)(?:\/|$)/.test(url.pathname) ? url.href : null; }
    catch { return null; }
  };
  const titleRequired = (job.recipe.publishedTitleSelectors ?? []).length > 0;
  const titleMatches = !titleRequired || job.recipe.publishedTitleSelectors.some(selector => all(selector).some(node => visible(node) && words(node.innerText) === expectedTitle));
  const matchingBodies = (job.recipe.publishedBodySelectors ?? []).flatMap(all).filter(node => visible(node) && words(node.innerText).includes(expectedBody));
  if (titleMatches && matchingBodies.length && validUrl(location.href)) return validUrl(location.href);
  // Some social apps stay on the feed. Only accept a permalink inside the
  // matching post, never a global unrelated link or an existing pre-submit post.
  if (!titleRequired) for (const node of matchingBodies) {
    const article = node.closest('article, .status, .post, .feed-card, [data-post-id], [data-testid="post"]');
    if (!article) continue;
    for (const selector of job.recipe.publishedLinkSelectors ?? []) for (const link of article.querySelectorAll(selector)) {
      const url = validUrl(link.href); if (url) return url;
    }
  }
  // Mastodon's redesigned /publish page clears the composer without rendering
  // the new status. Read the public own timeline, scoped to this submission's
  // author, exact content and timestamp. Never accept an older matching post.
  if (job.recipe.engine === 'mastodon' && task.submittedAt) {
    const username = job.verifiedSessionUsername || job.auth?.expectedUsername;
    if (!username || /[/?#]/.test(username)) return null;
    try {
      const accountResponse = await fetch(`/api/v1/accounts/lookup?acct=${encodeURIComponent(username.replace(/^@/, ''))}`, { credentials: 'same-origin', signal: AbortSignal.timeout(4000) });
      if (!accountResponse.ok) return null;
      const account = await accountResponse.json();
      if (!account.id || String(account.acct).toLowerCase() !== username.replace(/^@/, '').toLowerCase()) return null;
      const response = await fetch(`/api/v1/accounts/${encodeURIComponent(account.id)}/statuses?limit=10&exclude_reblogs=true&exclude_replies=true`, { credentials: 'same-origin', signal: AbortSignal.timeout(4000) });
      if (!response.ok) return null;
      const statuses = await response.json();
      if (!Array.isArray(statuses)) return null;
      const exactBody = words(body);
      const matches = statuses.filter(status => {
        const at = Date.parse(status.created_at);
        if (String(status.account?.id) !== String(account.id) || status.reblog || status.in_reply_to_id
          || !Number.isFinite(at) || at < task.submittedAt - 5000 || at > Date.now() + 5000 || !validUrl(status.url)) return false;
        const text = new DOMParser().parseFromString(String(status.content).replace(/<br\s*\/?\s*>|<\/p>/gi, ' '), 'text/html').body.textContent;
        return words(text) === exactBody;
      });
      if (matches.length === 1) return validUrl(matches[0].url);
    } catch { /* A later poll may confirm the result; never resubmit here. */ }
  }
  return null;
}
