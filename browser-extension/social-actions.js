// These functions are injected by value into the signed-in destination tab.
// Keep every helper inside the function: extension modules are not in page scope.
export async function fillSocialAndSubmit(job) {
  const { recipe, post, options = {} } = job;
  const engine = recipe.engine;
  // Second run after the worker applied AI form-fill actions: the title/body and
  // the configured choices are already in place, only verify and submit.
  const resume = job.formFillResume === true;
  // Compatibility for already queued recipes on Mastodon's redesigned composer.
  const bodySelectors = engine === 'mastodon' ? ['textarea#composer-text', ...recipe.bodySelectors]
    : engine === 'quora' ? ['[role="dialog"] .doc[contenteditable="true"]', ...recipe.bodySelectors] : recipe.bodySelectors;
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const normalize = value => String(value ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim();
  // Rich editors render Markdown (headings, lists, links) and textareas keep it
  // raw: compare word sequences, accepting either form of the approved text.
  const words = text => String(text ?? '').normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  const plainMarkdown = text => String(text ?? '')
    .replace(/^\s*(?:```|~~~).*$/gm, ' ')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}\[[^\]]+\]:\s+\S.*$/gm, ' ')
    .replace(/<((?:https?|mailto):[^>\s]+)>/gi, '$1')
    .replace(/<\/?[a-z][^>]*>/gi, ' ')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*(?:>\s*)+/gm, '')
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/gm, '');
  const similar = (expected, actual) => {
    if (!expected.length) return !actual.length;
    if (actual.length > Math.ceil(expected.length * 1.15)) return false;
    if (expected.join(' ') === actual.join(' ')) return true;
    // Longest common subsequence: words that appear in the same order.
    let previous = new Uint32Array(actual.length + 1), current = new Uint32Array(actual.length + 1);
    for (const word of expected) {
      for (let j = 0; j < actual.length; j++) current[j + 1] = word === actual[j] ? previous[j] + 1 : Math.max(previous[j + 1], current[j]);
      [previous, current] = [current, previous];
    }
    return previous[actual.length] >= Math.ceil(expected.length * 0.95);
  };
  const holds = (expected, actual) => [plainMarkdown(expected), expected].some(text => similar(words(text), words(actual)));
  const bodyWords = words(post.body);
  const startsWithTitle = words(post.title).every((word, index) => bodyWords[index] === word);
  const roots = () => {
    const result = [document];
    for (let i = 0; i < result.length; i++) for (const node of result[i].querySelectorAll('*')) if (node.shadowRoot) result.push(node.shadowRoot);
    return result;
  };
  const all = selector => roots().flatMap(root => [...root.querySelectorAll(selector)]);
  const visible = node => node && node.getClientRects().length > 0 && getComputedStyle(node).visibility !== 'hidden';
  const enabled = node => visible(node) && !node.disabled && !node.readOnly && node.getAttribute('aria-disabled') !== 'true';
  const contains = (root, node) => {
    while (node) {
      if (root.contains(node)) return true;
      node = node.getRootNode().host;
    }
    return false;
  };
  let composerForm = null;
  const activeScope = () => {
    const dialogs = all('[role="dialog"], .modal.show, .compose-modal-component, m-composer__modal, #c-postbox-dialog').filter(visible);
    // Nested dialogs are common; unrelated simultaneous dialogs are ambiguous.
    const leaves = dialogs.filter(node => !dialogs.some(other => other !== node && contains(node, other)));
    return leaves.length === 1 ? leaves[0] : leaves.length ? false
      : composerForm?.isConnected ? composerForm : document;
  };
  const pick = selectors => {
    const scope = activeScope();
    if (!scope) return null;
    for (const selector of selectors ?? []) {
      const found = all(selector).filter(node => visible(node) && contains(scope, node));
      if (found.length === 1) return found[0];
      if (found.length > 1) return null;
    }
    return null;
  };
  const button = labels => {
    const scope = activeScope();
    if (!scope) return null;
    const candidates = all('button, [role="button"], [role="tab"], input[type="submit"], a').filter(node => enabled(node) && contains(scope, node));
    const matches = candidates.filter(node => labels.some(label => [node.innerText, node.getAttribute('aria-label'), node.value].some(text => normalize(text).toLowerCase() === label.toLowerCase())));
    return matches.length === 1 ? matches[0] : null;
  };
  const wait = async (find, timeout = 20_000) => {
    const end = Date.now() + timeout;
    do { const result = find(); if (result) return result; await sleep(200); } while (Date.now() < end);
    return null;
  };
  const value = node => normalize(node?.isContentEditable ? node.innerText : node?.value);
  const selectAll = node => {
    // An empty heading/paragraph has no native caret position until it has
    // a line break (real editors normally render this placeholder themselves).
    if (!node.childNodes.length) node.append(document.createElement('br'));
    node.closest('[contenteditable="true"]')?.focus();
    const selection = window.getSelection(); const range = document.createRange();
    range.selectNodeContents(node); selection.removeAllRanges(); selection.addRange(range);
  };
  // Types line by line so editors receive real paragraph / line-break inputs
  // instead of one run-on string. The native input events are enough: an extra
  // synthetic InputEvent made some editors (Lexical) insert the text twice.
  const typeText = text => {
    const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
    if (lines.length === 1 && !lines[0]) return document.execCommand('delete');
    for (let i = 0; i < lines.length; i++) {
      if (i && !document.execCommand(lines[i - 1] === '' || lines[i] === '' ? 'insertParagraph' : 'insertLineBreak')) return false;
      if (lines[i] && !document.execCommand('insertText', false, lines[i])) return false;
    }
    return true;
  };
  const write = (node, text, mode) => {
    if (!enabled(node)) return false;
    node.focus();
    if (node.isContentEditable) {
      selectAll(node);
      if (mode !== 'insertText' && node.matches('[data-slate-editor="true"], .ck-editor__editable')) {
        const data = new DataTransfer(); data.setData('text/plain', text);
        const paste = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data });
        node.dispatchEvent(paste);
        if (paste.defaultPrevented) return true;
      }
      return typeText(text);
    }
    const proto = node.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(node, text);
    node.dispatchEvent(new Event('input', { bubbles: true })); node.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  };
  const escapeHtml = text => String(text ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  // The body follows recipe.inputMode: `pasteHtml` hands rich editors (Lexical,
  // ProseMirror…) the rendered HTML with the Markdown as text/plain, replacing
  // what the editor holds; `insertText` and `value` type plain text.
  const writeBody = async (node, text) => {
    if (recipe.inputMode !== 'pasteHtml' || !node.isContentEditable || typeof post.bodyHtml !== 'string' || !post.bodyHtml.trim()) return write(node, text, recipe.inputMode);
    if (!enabled(node)) return false;
    const html = text === post.body ? post.bodyHtml : `<p>${escapeHtml(post.title)}</p>${post.bodyHtml}`;
    node.focus(); selectAll(node);
    // Editors pick up the DOM selection on the (asynchronous) selectionchange.
    await sleep(60);
    const data = new DataTransfer(); data.setData('text/html', html); data.setData('text/plain', text);
    const paste = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data });
    node.dispatchEvent(paste);
    if (paste.defaultPrevented) { await sleep(200); return true; }
    // No paste handler: a plain contenteditable takes the HTML as it is.
    selectAll(node);
    return document.execCommand('insertHTML', false, html) || write(node, text, 'insertText');
  };
  // `missing` names the composer controls that were not found, so the worker
  // can ask the backend AI which visible element to use instead.
  const fail = (message, missing) => ({ status: 'notReady', message, ...(missing ? { missing } : {}) });
  const needs = message => ({ status: 'filled', message });
  // Another draft is in the composer: the operator saves or clears it first.
  const draft = message => ({ status: 'draft', message });
  // The editor was found but does not hold the approved text.
  const mismatch = message => ({ status: 'contentMismatch', message });
  const captcha = () => (recipe.captchaSelectors ?? []).some(selector => all(selector).some(visible));
  const finalLabels = {
    differ: ['Publish'], dzone: ['Submit to Moderation'],
    stackexchange: ['Post your question', 'Submit to Staging Ground'], lemmy: ['Create', 'Tạo'], discuit: ['Submit', 'Post'], linkedin: ['Post', 'Đăng', 'Đăng bài'],
    minds: ['Post'],
    medium: ['Publish now', 'Xuất bản ngay'], substack: ['Publish', 'Publish now'], quora: ['Post', 'Đăng'],
    reddit: ['Post', 'Đăng'], slideshare: ['Publish'], 'aws-builder': ['Publish', 'Publish article'],
    tinhte: ['Đăng', 'Đăng bài', 'Đăng bài viết', 'Xuất bản'], pixelfed: ['Post', 'Share', 'Publish', 'Đăng'],
    mastodon: ['Publish!', 'Publish', 'Post', 'Đăng', 'Đăng bài'], bluesky: ['Post', 'Đăng'], tumblr: ['Post', 'Post now', 'Đăng'], devto: ['Publish', 'Xuất bản'], dailydev: ['Post'],
    disqus: ['Create Discussion'], mewe: ['Post'], ubiquiti: ['Publish'], huggingface: ['Post'],
    invision: ['Submit Topic'], flarum: ['Post Discussion'], zendesk: ['Submit', 'Post'],
  }[engine];
  // Discuss Disqus: choosing a category writes "<Category>: " into the title and the
  // whole field is stored, so the title carries the prefix. Community Growth is the
  // category for site owners' community topics; nothing is preselected on the form.
  const disqusCategory = engine === 'disqus' ? normalize(options.category) || 'Community Growth' : '';
  const titleText = engine === 'disqus' && !normalize(post.title).toLowerCase().startsWith(`${disqusCategory.toLowerCase()}:`)
    ? `${disqusCategory}: ${normalize(post.title)}` : post.title;
  // Disqus reads its fields on focusout (jQuery), not on input: commit each one written.
  const commit = node => engine === 'disqus' && node?.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
  // Quora has no title field: the title leads the post unless the body already starts with it.
  const expectedBody = engine === 'quora' && normalize(post.title) && !startsWithTitle ? `${post.title}\n\n${post.body}` : post.body;
  // MeWe feed posts carry no link: their ids stand for the permalinks that existed before this post.
  const beforeUrls = [...new Set([...all('a[href]').map(node => node.href),
    ...(engine === 'mewe' ? all('.c-mw-post-header[data-postid]').map(node => `${location.origin}/post/show/${node.getAttribute('data-postid')}`) : [])])].slice(0, 2000);
  if (location.origin !== job.targetOrigin) return fail('Trang đã chuyển sang tên miền khác; chưa điền hay gửi bài.');
  // The backend counts the body the way this destination does; never type a post it would cut or refuse.
  if (post.maxChars != null && typeof post.length === 'number' && post.length > post.maxChars) {
    return { status: 'tooLong', message: `Nội dung dài ${post.length}/${post.maxChars} ký tự, vượt giới hạn của kênh này. Cần rút gọn trên web.` };
  }
  if (engine === 'devto' && /your account has been suspended/i.test(document.querySelector('main')?.innerText || document.body.innerText)) {
    return { status: 'restricted', message: 'DEV đã đình chỉ tài khoản này và hạn chế đăng bài. Cần giải quyết với DEV trước khi thử lại.' };
  }
  if (captcha()) return { status: 'captcha', message: 'Nền tảng yêu cầu CAPTCHA. Hoàn thành trong tab rồi tiếp tục từ web.' };
  const notices = all('[role="alert"], .alert, .error, .form-error, [class*="error" i], form').filter(visible).map(node => node.innerText).join(' ');
  if (/@\S+\s+is\s+(?:suspended|banned)|account\s+(?:has\s+been\s+|is\s+)?(?:suspended|banned|disabled|deactivated)|tài\s+khoản\s+(?:của\s+bạn\s+)?(?:đã\s+)?bị\s+(?:khoá|khóa|đình\s+chỉ|cấm)/i.test(notices)) {
    return { status: 'restricted', message: 'Nền tảng báo tài khoản đã bị đình chỉ hoặc khoá. Cần giải quyết với nền tảng hoặc dùng tài khoản khác; chưa đăng bài.' };
  }
  if ((recipe.loginSelectors ?? []).some(selector => all(selector).some(visible))) return { status: 'login', message: 'Đăng nhập tài khoản trong Chrome trước khi chạy luồng.' };
  if (/you must be logged in|please sign in to continue|bạn (?:cần|phải) đăng nhập/i.test(document.body.innerText)) return { status: 'login', message: 'Nền tảng yêu cầu đăng nhập trước khi tạo bài.' };
  if (engine === 'slideshare' && /(?:uploads?|uploading).{0,80}(?:unavailable|disabled|temporarily suspended)/i.test(document.body.innerText)) {
    return { status: 'unavailable', message: 'SlideShare đang tạm ngừng nhận file upload. Bài chưa được gửi.' };
  }

  // Blogger: "New Post" makes a draft and opens the editor, whose body is a
  // same-origin designMode iframe the generic steps cannot reach. Each step checks
  // what is on screen; nothing is published unless title and body hold the post.
  if (engine === 'blogger') {
    const titleInput = () => pick(recipe.titleSelectors);
    const editor = () => all('iframe.editable, iframe[class*="editable"]').find(frame => visible(frame) && frame.contentDocument?.body) ?? null;
    if (!titleInput() || !editor()) {
      if (!/^\/blog\/post\/edit\//.test(location.pathname)) {
        // The left menu and the floating button are the same action: either one.
        const create = all('[jsname="UOx8F"]').filter(enabled);
        if (!create.length) return fail('Không thấy nút Bài đăng mới (New Post) của Blogger.', ['opener']);
        create[0].click();
      }
      if (!await wait(() => titleInput() && editor(), 30_000)) return fail('Chưa mở được trình soạn bài Blogger.', ['body']);
    }
    const title = titleInput(), doc = editor().contentDocument, body = doc.body;
    const shown = () => doc.body.innerText.replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
    if (!resume && ((value(title) && value(title) !== normalize(post.title)) || (shown() && !holds(expectedBody, shown())))) {
      return draft('Trình soạn Blogger đang có bài khác; chưa ghi đè. Kiểm tra bản nháp trong tab rồi bấm Giao lại cho tiện ích trên web.');
    }
    if (!resume) {
      if (!write(title, post.title)) return mismatch('Không điền được tiêu đề Blogger; chưa đăng.');
      const html = typeof post.bodyHtml === 'string' && post.bodyHtml.trim() ? post.bodyHtml
        : String(post.body).split(/\n{2,}/).map(part => `<p>${escapeHtml(part).replace(/\n/g, '<br>')}</p>`).join('');
      body.focus(); doc.execCommand('selectAll', false);
      if (!doc.execCommand('insertHTML', false, html)) return mismatch('Không điền được nội dung vào trình soạn Blogger; chưa đăng.');
      body.dispatchEvent(new Event('input', { bubbles: true }));
      title.dispatchEvent(new Event('change', { bubbles: true }));
    }
    await sleep(800);
    if (value(titleInput()) !== normalize(post.title) || !holds(expectedBody, shown())) return mismatch('Trình soạn Blogger không giữ đúng tiêu đề / nội dung; chưa đăng.');
    if (!job.autoSubmit) return { status: 'filled', beforeUrls };
    const publish = await wait(() => all('[jsname="vdQQuc"]').find(enabled) ?? null, 10_000);
    if (!publish) return needs('Đã điền bài nhưng không thấy nút Đăng (Publish) của Blogger; kiểm tra trong tab.');
    publish.click();
    const confirm = await wait(() => all('[jsname="LgbsSe"][data-id="EBS5u"]').find(enabled) ?? button(['Confirm', 'Xác nhận']), 10_000);
    if (!confirm) return needs('Blogger chưa hiện hộp "Xuất bản bài đăng?"; bài đã điền, kiểm tra trong tab rồi bấm Đăng.');
    confirm.click();
    return { status: 'submitted', beforeUrls };
  }

  // A composer opener approved for this site after a redesign (or suggested by
  // the AI in this run). Never a submit button or a control inside a form.
  if ((recipe.openerSelectors ?? []).length && !pick(bodySelectors)) {
    const open = pick(recipe.openerSelectors);
    if (open && enabled(open) && !open.matches('[type="submit"]') && !open.closest('form')) {
      open.click();
      await wait(() => pick(bodySelectors), 8000);
    }
  }

  const quoraPersonal = engine === 'quora' && new URL(job.openUrl).hostname === 'www.quora.com';
  if (engine === 'reddit' && !pick(bodySelectors)) {
    // A submit page can initially show the link/media tab. Only switch an
    // explicit text tab, never a generic Post action that could submit a draft.
    const textTab = await wait(() => {
      const body = pick(bodySelectors);
      if (body) return body;
      const scope = activeScope();
      const tabs = all('[role="tab"]').filter(node => scope && enabled(node) && contains(scope, node))
        .filter(node => ['text', 'văn bản'].includes(normalize(node.innerText || node.getAttribute('aria-label')).toLowerCase()));
      return tabs.length === 1 ? tabs[0] : null;
    }, 3000);
    if (textTab?.getAttribute('role') === 'tab' && textTab.getAttribute('aria-selected') !== 'true') textTab.click();
  }
  if (engine === 'linkedin' && !pick(bodySelectors)) {
    const open = await wait(() => button(['Start a post', 'Start a post, try writing with AI', 'Bắt đầu bài đăng']));
    if (!open) return fail('Không thấy Start a post của LinkedIn.', ['opener']);
    open.click();
  }
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
        if (!open) return fail('Không thấy nút mở trình soạn bài Quora. Kiểm tra đúng tài khoản và nơi đăng.', ['opener']);
        open.click();
        postTab = await wait(() => button(['Create Post', 'Tạo bài viết']), 1500);
      }
      postTab?.click();
    }
    if (!await wait(() => pick(bodySelectors), 10_000)) return fail('Chưa chuyển được Quora sang Create Post; chưa điền hoặc gửi bài.', ['body']);
    if (!quoraAudienceMatches()) return needs('Bài cá nhân Quora chưa ở chế độ Everyone. Chọn Everyone trong tab rồi bấm Giao lại cho tiện ích trên web; chưa điền hay gửi bài.');
    const current = value(pick(bodySelectors)).replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
    if (current && !holds(expectedBody, current)) return draft('Quora đang có bản nháp khác trong khung soạn. Lưu hoặc đóng bản nháp đó trong tab rồi bấm Giao lại cho tiện ích trên web; tiện ích không ghi đè bản nháp.');
  }
  // The modal composer names its audience ("My Channel"). The newsfeed's inline
  // "Speak your mind…" composer has no audience picker and posts to the signed-in channel.
  const mindsChannelMatches = () => engine !== 'minds' || (all('m-composer__modal').some(visible)
    ? all('m-composer__modal *').some(node => visible(node) && !node.closest('m-composer__textarea') && normalize(node.innerText) === 'My Channel')
    : location.pathname.startsWith('/newsfeed'));
  if (engine === 'minds') {
    if (!pick(bodySelectors)) {
      const open = await wait(() => button(['Create', 'Create your first post'])
        ?? pick(['m-composer textarea', 'textarea[placeholder*="speak your mind" i]', '[contenteditable="true"][data-placeholder*="speak your mind" i]']));
      if (!open) return fail('Không thấy khung "Speak your mind" hoặc nút Create của Minds.', ['opener']);
      open.click(); open.focus?.();
    }
    if (!await wait(() => pick(bodySelectors), 8000)) return fail('Chưa mở được Compose trên Minds.', ['body']);
    if (!mindsChannelMatches()) return needs('Minds chưa chọn My Channel. Chọn My Channel trong tab rồi bấm Giao lại cho tiện ích trên web; chưa điền hay gửi bài.');
    const current = value(pick(bodySelectors));
    if (current && !holds(expectedBody, current)) return draft('Minds đang có bản nháp khác trong khung soạn. Lưu hoặc xoá bản nháp đó trong tab rồi bấm Giao lại cho tiện ích trên web; chưa ghi đè bản nháp.');
  }
  if (engine === 'huggingface' && !resume) {
    // Hugging Face decides who may publish Posts (PRO and some other accounts).
    try {
      const response = await fetch('/api/posts/can-post', { credentials: 'same-origin', signal: AbortSignal.timeout(5000) });
      const allowed = response.ok ? await response.json() : null;
      if (allowed?.canPost === false) {
        return { status: 'restricted', message: `Hugging Face chưa cho tài khoản này đăng Posts${allowed.reason ? `: ${String(allowed.reason).slice(0, 200)}` : ''}. Posts dành cho tài khoản PRO và một số tài khoản được Hugging Face mở quyền; chưa điền bài.` };
      }
    } catch { /* The composer's own warning and disabled Post button still apply. */ }
    if (!pick(bodySelectors)) {
      const open = await wait(() => button(['New Post']), 5000);
      open?.click();
    }
  }
  if (engine === 'pixelfed' && !pick(['.compose-modal-component', '#composeModal', 'textarea[placeholder*="caption" i]'])) {
    const open = await wait(() => button(['New Post', 'Create new post', 'Compose', 'Create', 'New post', 'Đăng bài'])
      ?? pick(['a[href="/i/compose"]', '[data-toggle="modal"][data-target="#composeModal"]', 'button[aria-label="Create a post"]']));
    if (!open) return fail('Không tìm thấy nút tạo bài Pixelfed.', ['opener']);
    open.click();
    const photos = await wait(() => button(['Photos', 'Photo', 'Photo / Video', 'Ảnh']), 1500);
    photos?.click();
  }

  if (recipe.requiredMedia && !resume) {
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

  // An account without a verified email gets a disabled title and Create button.
  if (engine === 'disqus' && all('.alert.-warning a[data-action="verify-email"]').some(visible)) {
    return { status: 'restricted', message: 'Disqus yêu cầu xác minh email của tài khoản trước khi tạo discussion. Xác minh email trên Disqus rồi bấm Giao lại cho tiện ích trên web.' };
  }
  const writable = node => enabled(node) && (node.isContentEditable || node.matches('input, textarea'));
  let lastBody = null, lastTitle = null;
  const fields = await wait(() => {
    const body = pick(bodySelectors), title = pick(recipe.titleSelectors);
    lastBody = body; lastTitle = title;
    return writable(body) && (!recipe.titleSelectors.length || writable(title)) && body !== title ? { body, title } : null;
  }, recipe.requiredMedia ? 45_000 : 20_000);
  if (!fields) {
    const missing = [...(recipe.titleSelectors.length && !writable(lastTitle) ? ['title'] : []), ...(!writable(lastBody) || lastBody === lastTitle ? ['body'] : [])];
    return fail('Không xác định được một khung soạn có đủ ô tiêu đề/nội dung cho phép nhập. Kiểm tra trang tạo bài, hộp thoại đang mở và quyền đăng; chưa bấm đăng.', missing.length ? missing : ['body']);
  }
  const { body } = fields;
  let { title } = fields;
  const form = body.closest('form');
  if (form && (!title || contains(form, title))) composerForm = form;
  // Medium's title and body share one contenteditable section.
  const titleInBody = engine === 'medium' && title && body.contains(title);
  // Check every field before writing any of them, including short-post engines.
  const bodyText = titleInBody
    ? normalize([...body.children].filter(node => !node.contains(title)).map(node => node.innerText).join(' ')) : value(body);
  // A Disqus title holding only a category prefix ("Community Growth:") is not a draft.
  const titleDraft = title && value(title) && value(title) !== normalize(titleText) && !(engine === 'disqus' && /^[^:]{2,40}:$/.test(value(title)));
  if ((bodyText && !holds(expectedBody, bodyText)) || titleDraft) {
    return draft('Trình soạn đang chứa bản nháp khác; chưa ghi đè tiêu đề hoặc nội dung. Lưu hoặc xoá bản nháp đó trong tab rồi bấm Giao lại cho tiện ích trên web.');
  }

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
    return all('[aria-selected="true"], [aria-checked="true"], .selected, .tag, .chip, .rs__multi-value, [data-testid*="flair"], button, [role="combobox"]').some(node => visible(node) && normalize(node.innerText).toLowerCase().includes(name.toLowerCase()));
  };
  // Product Hunt "Start new thread": the forum the thread goes to is picked in a "Search for a
  // product" box (General, Vibecoding, Introduce yourself, Self-Promotion, or a product's own
  // forum). Its rows have no stable roles, so a row is the element whose own text is exactly the
  // name and that appeared when the box opened. Sidebar links read "p/general" and never match,
  // and links are never clicked. Returns true, or the result that stops the run untouched.
  const chooseProductHuntForum = async name => {
    const field = pick(['input[placeholder*="Search for a product" i]', 'input[aria-label*="Search for a product" i]', 'input[placeholder*="product" i]']);
    if (!field) return needs('Không thấy ô "Search for a product" của Product Hunt để chọn forum; chưa điền bài.');
    const same = text => normalize(text).toLowerCase() === name.toLowerCase();
    // textContent first (cheap, no layout), then the visible text of the few matches.
    const named = () => all('body *').filter(node => node !== field && same(node.textContent) && visible(node) && same(node.innerText)
      && ![...node.children].some(child => same(child.textContent)) && !node.closest('a[href], header, nav, aside, [role="banner"], [role="navigation"]'));
    const area = (() => { let node = field; for (let level = 0; level < 4 && node.parentElement; level++) node = node.parentElement; return node; })();
    const before = new Set(named());
    // Shown in the picker once chosen: the input's value, or a label next to it.
    const shown = () => same(field.value) || named().some(node => contains(area, node));
    if (shown()) return true;
    const rowsNow = () => named().filter(node => !before.has(node));
    field.focus(); field.click();
    let rows = await wait(() => (rowsNow().length ? rowsNow() : null), 2500) ?? [];
    if (!rows.length) {
      // Product forums are found by searching their name.
      write(field, name);
      rows = await wait(() => (rowsNow().length ? rowsNow() : null), 6000) ?? [];
    }
    if (rows.length !== 1) {
      return needs(rows.length ? `Có nhiều mục “${name}” trong ô chọn forum của Product Hunt; chưa điền bài. Chọn đúng forum trong tab rồi bấm Giao lại.`
        : `Không thấy forum / product “${name}” trong ô "Search for a product" của Product Hunt; chưa điền bài. Ghi đúng tên ở ô Chuyên mục của tài khoản.`);
    }
    const clicked = rows[0];
    (clicked.closest('[role="option"], [role="menuitem"], [cmdk-item], button, li') ?? clicked).click();
    // The list closed (the clicked row is gone) and the picker now names the forum.
    if (!await wait(() => ((!clicked.isConnected || !visible(clicked)) && shown() ? true : null), 3000)) return needs(`Đã bấm forum “${name}” nhưng Product Hunt chưa hiện forum đã chọn; chưa điền bài.`);
    return true;
  };
  // The post language (Lemmy and similar forms). Not found: left to AI form-fill.
  const chooseLanguage = async () => {
    const names = { en: ['en', 'eng', 'english'], vi: ['vi', 'vie', 'vietnamese', 'tiếng việt'] }[post.language];
    if (!names || !recipe.languageSelectors?.length) return;
    const field = pick(recipe.languageSelectors);
    if (!field || !enabled(field)) return;
    const matches = text => names.includes(normalize(text).toLowerCase());
    if (field.tagName === 'SELECT') {
      const selected = field.selectedOptions?.[0];
      if (selected && (matches(selected.value) || matches(selected.textContent))) return;
      const option = [...field.options].find(item => !item.disabled && (matches(item.value) || matches(item.textContent)));
      if (!option) return;
      field.value = option.value;
      field.dispatchEvent(new Event('input', { bubbles: true })); field.dispatchEvent(new Event('change', { bubbles: true }));
      return;
    }
    if (matches(field.innerText || field.value)) return;
    field.click();
    const row = await wait(() => {
      const rows = all('[role="option"], .dropdown-item').filter(enabled).filter(node => matches(node.innerText));
      return rows.length === 1 ? rows[0] : null;
    }, 3000);
    if (row) { row.click(); await sleep(250); }
    else field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
  };

  // Where the post goes is chosen before any text is written: these pickers can
  // re-render the form, and a missing destination must leave the composer untouched.
  const formFillOn = job.formFill?.enabled === true && !['medium', 'substack'].includes(engine);
  if (['lemmy', 'discuit'].includes(engine)) {
    // Without a configured community, AI form-fill picks one after the text is in place.
    if (!options.category && !formFillOn) return needs('Cần chọn community đích trong cấu hình tài khoản trên web.');
    if (options.category && engine === 'discuit') {
      const input = pick(['.page-new-select input']);
      if (!input) return needs('Không mở được bộ chọn community.');
      if (value(input).toLowerCase() !== options.category.toLowerCase()) {
        if (!write(input, options.category)) return needs('Không mở được bộ chọn community.');
        const choice = await wait(() => all('.page-new-select-suggest-item').filter(visible).find(n => normalize(n.querySelector('.page-new-select-suggest-name')?.innerText ?? n.innerText).toLowerCase() === options.category.toLowerCase()), 5000);
        if (!choice) return needs('Community Discuit đã cấu hình không có trong danh sách.');
        choice.click(); await sleep(250);
      }
      if (value(input).toLowerCase() !== options.category.toLowerCase()) return needs('Chưa xác nhận community Discuit.');
    } else if (options.category) {
      const open = pick(['#post-community']);
      if (!open) return needs('Không thấy bộ chọn community Lemmy.');
      if (!normalize(open.innerText).toLowerCase().includes(options.category.toLowerCase())) {
        open.click();
        const search = await wait(() => pick(['#post-community + div input', '.dropdown-menu input', '[role="combobox"] input', 'input[role="combobox"]']), 2000);
        if (search) write(search, options.category);
        const row = await wait(() => all('[role="option"], .dropdown-item').filter(visible).find(n => normalize(n.innerText).toLowerCase() === options.category.toLowerCase()), 5000);
        if (!row) return needs('Không thấy community Lemmy đã chọn.');
        row.click(); await sleep(250);
      }
      if (!normalize(open.innerText).toLowerCase().includes(options.category.toLowerCase())) return needs('Chưa xác nhận community Lemmy.');
    }
  }
  if (engine === 'disqus' && !resume) {
    // Radio values are the category names; clicking a checked one fires no change, so
    // it is fired by hand (the form does not add the prefix twice).
    const radio = all('[data-role="channel-categories"] input[type="radio"][name="category"]')
      .find(node => !node.disabled && normalize(node.value).toLowerCase() === disqusCategory.toLowerCase());
    if (!radio) return needs(`Discuss Disqus không có chuyên mục “${disqusCategory}”. Chọn đúng tên chuyên mục trong cấu hình tài khoản trên web; chưa điền bài.`);
    if (!radio.checked) radio.click();
    else radio.dispatchEvent(new Event('change', { bubbles: true }));
    await sleep(300);
    if (!radio.checked) return needs('Chưa chọn được chuyên mục Discuss Disqus; chưa điền bài.');
  }
  if (engine === 'ubiquiti' && !resume) {
    // One required topic, chosen from plain buttons by their name (General by default).
    // The General / Early Access / Alpha tabs of beta testers are not topics.
    const topic = normalize(options.category) || 'General';
    const matches = all('button').filter(enabled).filter(node => !node.matches('[role="tab"], [data-testid="public"], [data-testid="beta"], [data-testid="alpha"]')
      && [...node.querySelectorAll('span[data-uic-component="Text"]')].some(span => normalize(span.innerText).toLowerCase() === topic.toLowerCase()));
    const choices = matches.filter(node => !matches.some(other => other !== node && node.contains(other)));
    if (choices.length !== 1) return needs(`Không thấy đúng một chủ đề “${topic}” trên Ubiquiti Community. Sửa ô Chuyên mục của tài khoản trên web (ví dụ General, Network, Protect); chưa điền bài.`);
    choices[0].click();
    await sleep(300);
  }
  if (engine === 'zendesk' && !resume) {
    // The topic select is often hidden behind Zendesk's own dropdown; the form posts the select's value.
    const select = all('select#community_post_topic_id, select[name="community_post[topic_id]"]')[0];
    const topic = normalize(options.category);
    if (select && topic) {
      const option = [...select.options].find(item => !item.disabled && item.value && normalize(item.textContent).toLowerCase() === topic.toLowerCase());
      if (!option) return needs(`Không thấy topic “${topic}” trong form cộng đồng; chưa điền bài. Ghi đúng tên topic ở ô Chuyên mục của tài khoản.`);
      select.value = option.value;
      select.dispatchEvent(new Event('input', { bubbles: true })); select.dispatchEvent(new Event('change', { bubbles: true }));
    }
    if (select && !select.value) return needs('Bài cộng đồng cần chọn topic; chưa điền bài. Ghi tên topic ở ô Chuyên mục của tài khoản hoặc dán URL new post có ?community_post[topic_id]=<id>.');
  }
  if (engine === 'producthunt' && !resume) {
    const chosen = await chooseProductHuntForum(normalize(options.category) || 'Self-Promotion');
    if (chosen !== true) return chosen;
  }
  await chooseLanguage();

  if (!resume) {
    if (title && !write(title, titleText)) return mismatch('Không điền được tiêu đề vào ô tiêu đề đã tìm thấy; chưa gửi bài.');
    commit(title);
    if (titleInBody) {
      // Preserve the title block and write only the story paragraph below it.
      const paragraph = [...body.querySelectorAll('p')].find(node => node !== title && !title.contains(node));
      if (!paragraph) return fail('Không tìm thấy đoạn nội dung riêng trong editor Medium.');
      if (!await writeBody(paragraph, expectedBody)) return mismatch('Không điền được nội dung vào editor Medium; chưa gửi bài.');
    } else if (!await writeBody(body, expectedBody)) return mismatch('Không điền được nội dung vào khung soạn đã tìm thấy; chưa gửi bài.');
    commit(body);
    const summary = pick(['textarea[name="summary"]', 'input[name="summary"]', 'textarea[placeholder*="summary" i]']);
    if (summary) write(summary, post.summary || post.body.split('\n').find(line => line.trim())?.slice(0, 240) || post.title);
    if (engine === 'dzone') {
      const subtitle = pick(['textarea[name="subtitle"]']); if (subtitle) write(subtitle, post.summary || post.title);
      const meta = pick(['#meta-description-textarea']); if (meta) write(meta, (post.summary || post.title).slice(0, 160));
    }
  }
  await sleep(500);
  // Same words in the same order (Markdown rendered or raw), not byte-for-byte equality.
  const validContent = () => {
    title = pick(recipe.titleSelectors);
    const currentBody = pick(bodySelectors);
    if (!currentBody || (recipe.titleSelectors.length && value(title) !== normalize(titleText))) return false;
    const shown = currentBody.isContentEditable ? currentBody.innerText : currentBody.value;
    return holds(engine === 'medium' && title && currentBody.contains(title) ? `${post.title}\n\n${expectedBody}` : expectedBody, shown);
  };
  if (!validContent()) {
    return resume ? needs('Nội dung trong khung soạn đã thay đổi sau khi AI điền các mục bắt buộc; chưa bấm Đăng. Kiểm tra trong tab.')
      : mismatch('Editor không giữ đúng tiêu đề/nội dung từ web (thiếu chữ, mất đoạn hoặc thừa nội dung); chưa gửi bài.');
  }

  // One planned image, attached once the text is in place. A composer that does
  // not show the image is never submitted: the post would go out without it.
  const inScope = selectors => {
    const scope = activeScope();
    return scope ? [...new Set((selectors ?? []).flatMap(selector => all(selector)))].filter(node => contains(scope, node)) : [];
  };
  const previewShown = () => inScope(recipe.mediaPreviewSelectors).some(visible);
  const uploading = () => inScope(recipe.mediaBusySelectors).some(visible);
  const attachImage = async asset => {
    if (previewShown()) return true;
    const bytes = Uint8Array.from(atob(asset.base64), char => char.charCodeAt(0));
    let file = new File([bytes], asset.name, { type: asset.mimeType });
    // MeWe treats anything but PNG / JPEG / GIF (WebP) as a document: redraw it as PNG.
    if (engine === 'mewe' && !/^image\/(png|jpeg|gif)$/.test(file.type)) {
      try {
        const bitmap = await createImageBitmap(file);
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
        canvas.getContext('2d').drawImage(bitmap, 0, 0);
        file = new File([await canvas.convertToBlob({ type: 'image/png' })], `${String(asset.name).replace(/\.[^.]*$/, '') || 'image'}.png`, { type: 'image/png' });
      } catch { return false; }
    }
    const transfer = () => { const data = new DataTransfer(); data.items.add(file); return data; };
    const input = () => { const found = inScope(recipe.mediaInputSelectors).filter(node => !node.disabled); return found.length === 1 ? found[0] : null; };
    let target = input();
    if (!target && recipe.mediaOpenerLabels?.length) {
      const open = button(recipe.mediaOpenerLabels);
      if (open) { open.click(); target = await wait(input, 5000); }
    }
    if (target) {
      target.files = transfer().files;
      target.dispatchEvent(new Event('input', { bubbles: true }));
      target.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
      // Composers that create their file picker on demand (Bluesky) take a pasted image.
      const editor = pick(bodySelectors);
      if (!editor) return false;
      editor.focus();
      editor.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer() }));
    }
    // LinkedIn shows an image editor step ("Next") before returning to the post.
    for (let step = 0; step < 2 && recipe.mediaConfirmLabels?.length && !previewShown(); step++) {
      const next = await wait(() => (previewShown() ? 'shown' : button(recipe.mediaConfirmLabels)), 15_000);
      if (!next || next === 'shown') break;
      next.click(); await sleep(800);
    }
    if (!await wait(() => previewShown() || null, recipe.mediaWaitMs ?? 45_000)) return false;
    // Wait for the upload itself so Post is not pressed on a half-sent image.
    await wait(() => (uploading() ? null : true), 90_000);
    if (uploading()) return false;
    const alt = asset.altText ? pick(recipe.mediaAltSelectors ?? []) : null;
    if (alt) write(alt, asset.altText);
    return true;
  };
  if (recipe.optionalMedia && job.attachments?.length && !resume && engine !== 'differ') {
    if (!await attachImage(job.attachments[0])) return needs('Đã điền bài nhưng chưa gắn được ảnh vào khung soạn, nên chưa bấm Đăng. Gắn ảnh rồi bấm Đăng, hoặc bỏ ảnh của kênh này trên web rồi chạy lại.');
    await sleep(300);
    if (!validContent()) return needs('Nội dung thay đổi khi gắn ảnh; chưa đăng.');
  }

  if (!resume && !['lemmy', 'discuit', 'producthunt', 'disqus', 'ubiquiti', 'zendesk'].includes(engine) && !await choose(options.category, ['select[name="category"]', 'select[name="node_id"]', '[role="combobox"][aria-label*="category" i]', 'input[placeholder*="chuyên mục" i]'], ['Category', 'Chuyên mục', 'Chọn chuyên mục'])) return needs('Không chọn được chuyên mục đã cấu hình. Sửa cấu hình trên web trước khi thử lại.');
  if (engine === 'stackexchange' && !resume) {
    // Tags configured on the account must all be applied; the AI's suggested tags
    // are used only when the site already has them (never created), up to 5 in total.
    const configured = options.tags ?? [];
    const suggested = (options.suggestedTags ?? []).filter(tag => !configured.some(item => item.toLowerCase() === tag.toLowerCase()));
    if (!configured.length && !suggested.length) return needs('Câu hỏi cần ít nhất một tag. Bài AI chưa có tag; thêm tag trong cấu hình tài khoản trên web rồi giao lại.');
    const tags = pick(['#tagnames']);
    // Selected tags render as ".s-tag" chips ("nginx ×"); suggestions also show counts.
    const chipName = node => normalize(node.innerText).replace(/\s*[×✕✖]\s*$/, '').toLowerCase();
    const hasChip = tag => all('.s-tag, .post-tag, .js-tag').some(node => visible(node) && !node.closest('[role="option"], [role="listbox"]') && chipName(node) === tag.toLowerCase());
    const tagInput = () => pick(['input#filterInput[aria-label="tags"]', 'input[aria-label="tags" i]', '#tageditor-replacing-tagnames--input']);
    const suggestionFor = tag => wait(() => {
      const rows = all('[role="option"]').filter(visible).filter(node => {
        const label = node.querySelector('.s-tag, .post-tag');
        return (label ? chipName(label) : normalize(node.innerText).toLowerCase().split(/\s+/)[0]) === tag.toLowerCase();
      });
      return rows.length === 1 ? rows[0] : null;
    }, 3000);
    // The plain field cannot tell whether a tag exists: AI tags only stand in for missing configured ones.
    if (tags) write(tags, (configured.length ? configured : suggested).slice(0, 5).join(' '));
    else {
      for (const tag of configured) {
        if (hasChip(tag)) continue;
        const input = tagInput();
        if (!input || !write(input, tag)) return needs(`Không tìm thấy ô nhập tag trên ${location.hostname}.`);
        const suggestion = await suggestionFor(tag);
        if (suggestion) suggestion.click();
        else for (const type of ['keydown', 'keypress', 'keyup']) input.dispatchEvent(new KeyboardEvent(type, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
        if (!await wait(() => hasChip(tag), 3000)) return needs(`Không chọn được tag ${tag} trên ${location.hostname}. Kiểm tra tag có tồn tại trên trang này.`);
      }
      for (const tag of suggested) {
        if ([...configured, ...suggested].filter(hasChip).length >= 5) break;
        if (hasChip(tag)) continue;
        const input = tagInput();
        if (!input || !write(input, tag)) break;
        const suggestion = await suggestionFor(tag);
        // Only a tag the site lists: Enter could create a new tag, which most accounts may not.
        if (suggestion) { suggestion.click(); await wait(() => hasChip(tag), 3000); }
        else write(input, '');
      }
      if (![...configured, ...suggested].some(hasChip)) {
        return needs(`Câu hỏi cần ít nhất một tag có trên ${location.hostname}; các tag AI gợi ý (${suggested.join(', ')}) không có trên trang này. Thêm tag đúng trong cấu hình tài khoản trên web rồi giao lại.`);
      }
    }
  }
  if (engine === 'disqus' && !resume) {
    // Topics: the account's fixed tags, then the post's AI tags; 2-30 characters, at
    // most 5, never a category name. "a, b, c" is split into chips on focusout.
    const categories = all('[data-role="channel-categories"] input[type="radio"][name="category"]').map(node => normalize(node.value).toLowerCase());
    const seen = new Set();
    const topics = [...(options.tags ?? []), ...(options.suggestedTags ?? [])]
      .map(tag => normalize(tag).replace(/^#+/, '').replace(/[,;]+/g, ' ').replace(/\s+/g, ' ').trim())
      .filter(tag => tag.length >= 2 && tag.length <= 30 && !categories.includes(tag.toLowerCase()) && !seen.has(tag.toLowerCase()) && seen.add(tag.toLowerCase()))
      .slice(0, 5);
    const input = pick(['[data-role="topic-input"] input[name="topics"]']);
    if (topics.length && input && enabled(input)) { write(input, topics.join(', ')); commit(input); await sleep(300); }
  }
  if (engine === 'reddit' && !resume && !await choose(options.flair, ['[role="dialog"] input[placeholder*="Search" i]', '[role="dialog"] input[type="search"]'], ['Add flair and tags', 'Add tags and flair', 'Add tags and flairs', 'Flair', 'Thêm flair'])) return needs('Không chọn được flair của subreddit.');

  // Required controls the recipe does not know about (a community, a rules
  // checkbox…) keep Post disabled or the form invalid. The worker then asks the
  // backend AI how to fill them and runs this function again with `resume`.
  const submitTarget = () => {
    const scope = activeScope();
    if (!scope) return null;
    for (const selector of recipe.submitSelectors ?? []) {
      const found = all(selector).filter(node => visible(node) && contains(scope, node));
      if (found.length) return found.length === 1 ? found[0] : null;
    }
    const labels = (finalLabels ?? []).map(label => label.toLowerCase());
    const matches = all('button, [role="button"], input[type="submit"]').filter(node => visible(node) && contains(scope, node)
      && [node.innerText, node.getAttribute('aria-label'), node.value].some(text => labels.includes(normalize(text).toLowerCase())));
    return matches.length === 1 ? matches[0] : null;
  };
  // Differ: the toolbar "Publish" (#post-submit-button) only opens <dialog id="modal-submit">.
  // The dialog holds an optional featured image (JPG/PNG/GIF, at most 5 MB), one
  // Keyword picked from Differ's own topic list, and the real Publish (type=submit).
  const DIFFER_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif'];
  const DIFFER_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
  // Broad topics most posts fit when none of the post's tags is in Differ's list.
  const DIFFER_FALLBACK_TOPICS = ['technology', 'tech', 'programming', 'software development', 'software', 'devops', 'linux', 'web development', 'security', 'cloud computing', 'cloud'];
  const topicKey = text => String(text ?? '').normalize('NFD').replace(/\p{M}+/gu, '').replace(/[đĐ]/g, 'd').toLowerCase().replace(/[^a-z0-9]+/g, '');
  const differDialog = () => { const dialog = document.querySelector('dialog#modal-submit'); return dialog?.open && visible(dialog) ? dialog : null; };
  const differKeyword = async dialog => {
    const shown = () => normalize(dialog.querySelector('.rs__single-value')?.innerText);
    if (shown()) return shown();
    const control = dialog.querySelector('.rs__control');
    const input = dialog.querySelector('input.rs__input, .rs__input input, input[id^="react-select"]');
    if (!control && !input) return null;
    const optionNodes = () => [...dialog.querySelectorAll('.rs__option')].filter(visible);
    // react-select opens its menu on mouse down on the control, or on ArrowDown in its input.
    control?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }));
    let nodes = await wait(() => (optionNodes().length ? optionNodes() : null), 2000);
    if (!nodes && input) {
      input.focus();
      input.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 }));
      nodes = await wait(() => (optionNodes().length ? optionNodes() : null), 2000);
    }
    if (!nodes) return null;
    const topics = nodes.map(node => ({ node, label: normalize(node.innerText), key: topicKey(node.innerText) })).filter(topic => topic.key);
    const wanted = [...(options.tags ?? []), ...(options.suggestedTags ?? [])].map(topicKey).filter(Boolean);
    const pickTopic = () => {
      for (const tag of wanted) { const exact = topics.find(topic => topic.key === tag); if (exact) return exact; }
      // "selfhosting" fits "Self Hosting"; "linuxserver" fits "Linux". Short keys would match too much.
      for (const tag of wanted) {
        const close = topics.find(topic => topic.key.length >= 3 && tag.length >= 3 && (topic.key.includes(tag) || tag.includes(topic.key)));
        if (close) return close;
      }
      for (const fallback of DIFFER_FALLBACK_TOPICS.map(topicKey)) { const general = topics.find(topic => topic.key === fallback); if (general) return general; }
      return null;
    };
    const topic = pickTopic();
    // No match: the menu stays open so AI form-fill (or the operator) sees Differ's topic list.
    if (!topic) return null;
    topic.node.click();
    return await wait(() => (shown() ? shown() : null), 2000);
  };
  const differImage = async (dialog, asset) => {
    const preview = () => [...dialog.querySelectorAll('img[alt="preview"]')].some(visible);
    if (preview()) return true;
    const bytes = Uint8Array.from(atob(asset.base64), char => char.charCodeAt(0));
    if (!DIFFER_IMAGE_TYPES.includes(asset.mimeType) || bytes.length > DIFFER_IMAGE_MAX_BYTES) return false;
    const input = dialog.querySelector('input[type="file"]');
    if (!input) return false;
    const transfer = new DataTransfer(); transfer.items.add(new File([bytes], asset.name, { type: asset.mimeType }));
    input.files = transfer.files;
    input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true }));
    return Boolean(await wait(() => (preview() ? true : null), 10_000));
  };
  const publishDiffer = async () => {
    let dialog = differDialog();
    if (!dialog) {
      const opener = await wait(() => { const target = pick(recipe.submitSelectors); return target && enabled(target) ? target : null; }, 5000);
      if (!opener) return { ...needs('Nút Publish của Differ chưa sẵn sàng; chưa đăng.'), missing: ['submit'] };
      if (!validContent()) return needs('Nội dung không còn khớp với bài trên web; chưa đăng.');
      opener.click();
      dialog = await wait(differDialog, 5000);
      if (!dialog) return needs('Đã bấm Publish nhưng Differ không mở hộp xuất bản (Featured Image / Keyword); chưa đăng.');
    }
    // The featured image is optional: one Differ cannot take (type, over 5 MB) is left out, never blocks the post.
    const asset = job.attachments?.[0];
    const imageNote = asset && !await differImage(dialog, asset) ? ' Ảnh bìa không gắn được (Differ chỉ nhận JPG/PNG/GIF tối đa 5 MB) nên bài đăng không kèm ảnh.' : '';
    const keyword = await differKeyword(dialog);
    if (!keyword) {
      // None of the post's tags is a Differ topic: let the AI pick from the list, or leave it to the operator.
      if (job.formFill?.enabled && (job.formFillRounds ?? 0) < 2 && !resume) {
        return { status: 'needsForm', problems: ['required'], beforeUrls, message: 'Chưa chọn được Keyword (topic) của Differ cho bài này. Chọn một topic trong hộp Publish rồi bấm Publish.' };
      }
      return needs(`Chưa chọn được Keyword (topic) của Differ cho bài này; hộp Publish đang mở. Chọn một topic rồi bấm Publish.${imageNote}`);
    }
    if (captcha()) return { status: 'captcha' };
    if (!validContent()) return needs('Nội dung không còn khớp với bài trên web; chưa đăng.');
    const publish = [...dialog.querySelectorAll('button[type="submit"]')].filter(enabled);
    if (publish.length !== 1) return needs('Không thấy đúng một nút Publish trong hộp xuất bản của Differ; chưa đăng.');
    publish[0].click();
    return { status: 'submitted', beforeUrls, ...(imageNote ? { message: imageNote.trim() } : {}) };
  };

  const formProblems = () => {
    const scope = activeScope();
    if (!scope) return [];
    const problems = [];
    const target = submitTarget();
    if (target && !enabled(target)) problems.push('submit');
    const host = scope === document ? pick(bodySelectors)?.closest('form') : scope;
    if (!host) return problems;
    const editors = [pick(bodySelectors), pick(recipe.titleSelectors)].filter(Boolean);
    const controls = all('select, input, textarea, [role="combobox"], [role="checkbox"], [role="switch"], [role="radio"]').filter(node => visible(node)
      && contains(host, node) && !editors.includes(node) && !node.isContentEditable
      && !['hidden', 'password', 'file', 'submit', 'button', 'reset', 'image'].includes((node.getAttribute('type') || '').toLowerCase()));
    const filledControl = node => {
      if (node.matches('input[type="radio"]')) return node.name ? controls.some(other => other.matches('input[type="radio"]') && other.name === node.name && other.checked) : node.checked;
      if (node.matches('input[type="checkbox"]')) return node.checked;
      if (node.matches('[role="checkbox"], [role="switch"], [role="radio"]')) return node.getAttribute('aria-checked') === 'true';
      if (node.matches('select, input, textarea')) return Boolean(String(node.value ?? '').trim());
      return Boolean(normalize(node.innerText));
    };
    if (controls.some(node => (node.required || node.getAttribute('aria-required') === 'true') && !filledControl(node))) problems.push('required');
    const describedError = node => [node.getAttribute('aria-errormessage'), ...(node.getAttribute('aria-describedby') || '').split(/\s+/)].filter(Boolean)
      .map(id => node.getRootNode().getElementById?.(id)).some(note => note && visible(note) && normalize(note.innerText) && /error|invalid|lỗi|không hợp lệ|bắt buộc|required/i.test(`${note.className} ${note.getAttribute('role')} ${note.innerText}`));
    if (controls.some(node => node.getAttribute('aria-invalid') === 'true' || describedError(node))
      || all('.invalid-feedback, .field-error').some(node => visible(node) && contains(host, node) && normalize(node.innerText))) problems.push('invalid');
    return problems;
  };
  const forceForm = ['lemmy', 'discuit'].includes(engine) && !options.category && !resume;
  const formFillNeeded = async () => {
    if (!formFillOn) return null;
    let problems = formProblems();
    // Sites enable Post a moment after the last input, or once an image upload is processed:
    // give it as long as the Post lookup below would.
    if (problems.length) { await wait(() => (formProblems().length ? null : true), recipe.optionalMedia && job.attachments?.length ? 30_000 : 5000); problems = formProblems(); }
    if (!problems.length && !forceForm) return null;
    if ((job.formFillRounds ?? 0) >= 2) return needs('AI chưa điền chắc chắn các mục bắt buộc; mở tab để kiểm và bấm Đăng.');
    return { status: 'needsForm', problems, beforeUrls, message: 'Còn mục bắt buộc chưa điền hoặc nút Đăng đang khoá. Điền các mục đó trong tab rồi bấm Đăng.' };
  };

  // Stop before entering a publish confirmation if automatic submission is off.
  if (!job.autoSubmit) {
    return await formFillNeeded() ?? { status: 'filled', beforeUrls,
      ...(resume ? { message: 'AI đã điền các mục bắt buộc của form. Kiểm tra lại rồi bấm Đăng trong tab.' } : {}) };
  }
  if (captcha()) return { status: 'captcha' };
  if (!validContent()) return needs('Nội dung thay đổi khi chọn chuyên mục/flair. Chưa bấm đăng.');
  if (engine === 'stackexchange') {
    const review = button(['Review your question']);
    if (review) { review.click(); await sleep(500); }
  }
  if (engine === 'dzone') {
    const moderation = '.dropdown-menu li[ng-click="s.save(true, false, false, true)"]';
    if (!pick([moderation])) {
      const toggles = all('button.dropdown-toggle').filter(enabled).filter(n => normalize(n.innerText) === 'More');
      if (!toggles.length) return needs('Không thấy menu More để gửi bài DZone đi duyệt.');
      toggles[toggles.length - 1].click();
      if (!await wait(() => pick([moderation]), 2500)) return needs('DZone chưa cho phép Submit to Moderation; kiểm tra các trường bắt buộc.');
    }
  }

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
  const plainTags = ['slideshare', 'devto'].includes(engine) && !resume ? pick(['#tag-input', 'input[name="tags"]:not([role="combobox"]):not([aria-autocomplete])']) : null;
  if (plainTags && options.tags?.length && (!write(plainTags, options.tags.join(', ')) || value(plainTags) !== normalize(options.tags.join(', ')))) return needs(`Không điền được tags đã cấu hình trên ${location.hostname}; chưa xuất bản.`);
  // Without configured tags the AI's tags fill the field; a field that rejects them is left empty.
  const aiTags = (options.suggestedTags ?? []).join(', ');
  if (plainTags && !options.tags?.length && aiTags && !value(plainTags) && (!write(plainTags, aiTags) || value(plainTags) !== normalize(aiTags))) write(plainTags, '');
  for (const tag of plainTags || resume || ['stackexchange', 'differ', 'disqus', 'ubiquiti'].includes(engine) ? [] : options.tags ?? []) {
    if (!await choose(tag, [...(engine === 'differ' ? ['input.rs__input[role="combobox"]'] : []), 'input[placeholder*="Add a topic" i]', 'input[placeholder*="Add tags" i]', 'input[placeholder*="Search tags" i]', 'input[name="tags"]'], ['Add tags', 'Topics', 'Tags'])) return needs(`Không chọn được tag “${tag}”; chưa bấm đăng.`);
  }
  if (captcha()) return { status: 'captcha' };
  if (!quoraAudienceMatches()) return needs('Đối tượng xem bài Quora đã thay đổi; chưa bấm Post.');
  const unfilled = await formFillNeeded();
  if (unfilled) return unfilled;
  if (engine === 'differ') return await publishDiffer();
  if (engine === 'producthunt') {
    const editor = pick(bodySelectors);
    const submit = await wait(() => {
      const after = all('button, input[type="submit"]').filter(node => enabled(node) && normalize(node.innerText || node.value).toLowerCase() === 'submit'
        && !node.closest('header, nav, [role="banner"], [role="navigation"]')
        && editor && (editor.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING));
      return after[0] ?? null;
    }, 5000);
    if (!submit) return { ...needs('Nút Submit của form Product Hunt chưa sẵn sàng; chưa đăng.'), missing: ['submit'] };
    if (!validContent()) return needs('Nội dung không còn khớp với bài trên web; chưa đăng.');
    submit.click();
    return { status: 'submitted', beforeUrls };
  }
  const submit = await wait(() => {
    const target = pick(recipe.submitSelectors);
    if (target) return enabled(target) ? target : null;
    const scope = activeScope();
    // A known but ambiguous/disabled submit must not fall through to another
    // action with the same label (e.g. a comment or a different post type).
    if (!scope || (recipe.submitSelectors ?? []).some(selector => all(selector).some(node => visible(node) && contains(scope, node)))) return null;
    return button(finalLabels ?? []);
  }, recipe.optionalMedia && job.attachments?.length ? 30_000 : 5000);
  if (!submit) return { ...needs('Nút đăng chưa sẵn sàng. Kiểm tra các trường bắt buộc hoặc quyền của tài khoản.'), missing: ['submit'] };
  if (!['medium', 'substack'].includes(engine) && !validContent()) return needs('Nội dung không còn khớp với bài trên web; chưa đăng.');
  if (!mindsChannelMatches()) return needs('Nơi đăng Minds đã thay đổi; chưa gửi bài.');
  submit.click();
  if (engine === 'flarum') {
    // Opened from a tag page the discussion already has its tag. Otherwise Flarum asks for
    // one before posting: pick the account's category (General by default), then confirm.
    const modal = await wait(() => all('.TagDiscussionModal').find(visible) ?? null, 2500);
    if (modal) {
      const tag = normalize(options.category) || 'General';
      const rows = [...modal.querySelectorAll('.TagSelectionModal-list > li, .SelectTagListItem')].filter(visible)
        .filter(row => normalize(row.querySelector('.SelectTagListItem-name')?.innerText ?? row.innerText).toLowerCase() === tag.toLowerCase());
      if (rows.length !== 1) return needs(`Flarum yêu cầu chọn tag nhưng không thấy tag “${tag}”; bài đã điền, chọn tag trong tab rồi bấm đăng. Có thể dán trang tag (…/t/<tag>) vào Trang tạo chủ đề.`);
      rows[0].click(); await sleep(300);
      const confirm = [...modal.querySelectorAll('button[type="submit"]')].filter(enabled);
      if (confirm.length !== 1) return needs(`Đã chọn tag “${tag}” nhưng không thấy nút xác nhận của Flarum; kiểm tra trong tab.`);
      confirm[0].click();
    }
  }
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
  const titleWords = words(job.post.title).split(' ').filter(Boolean);
  const leadsWithTitle = titleWords.every((word, index) => words(job.post.body).split(' ')[index] === word);
  const body = job.recipe.engine === 'quora' && titleWords.length && !leadsWithTitle ? `${job.post.title}\n\n${job.post.body}` : job.post.body;
  // Feeds truncate long posts ("(more)"), and Quora shows the title apart from
  // the text: match the first words of the body itself, not the whole post.
  const expectedLead = words(job.post.body.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')).split(' ').slice(0, 12).join(' ');
  if (!expectedLead) return null;
  const pattern = new RegExp(job.recipe.successUrlPattern);
  // A post-shaped link on this site, new or old.
  const permalink = value => {
    try { const url = new URL(value, location.href); return url.href !== job.openUrl && url.origin === job.targetOrigin && pattern.test(url.href)
      && !/\/(publish|edit|draft|create|upload)(?:\/|$)/.test(url.pathname) ? url.href : null; }
    catch { return null; }
  };
  const validUrl = value => { const url = permalink(value); return url && !(task.beforeUrls ?? []).includes(url) ? url : null; };
  const titleRequired = (job.recipe.publishedTitleSelectors ?? []).length > 0;
  const titleMatches = !titleRequired || job.recipe.publishedTitleSelectors.some(selector => all(selector).some(node => visible(node) && words(node.innerText) === expectedTitle));
  const publishedBodySelectors = [...(job.recipe.publishedBodySelectors ?? []), ...(job.recipe.engine === 'pixelfed' ? ['.timeline-status-component .status-text .read-more-component'] : [])];
  const matchingBodies = publishedBodySelectors.flatMap(all).filter(node => visible(node) && words(node.innerText).includes(expectedLead));
  const matchesAuthor = url => {
    if (job.recipe.engine !== 'pixelfed') return true;
    const author = /^\/p\/([^/]+)\/\d+/.exec(new URL(url).pathname)?.[1];
    const expectedAuthor = job.verifiedSessionUsername || job.auth?.expectedUsername;
    return !!author && (!expectedAuthor || author.toLowerCase() === expectedAuthor.replace(/^@/, '').toLowerCase());
  };
  const matchingContent = job.recipe.engine === 'pixelfed' ? matchingBodies.filter(node => words(node.innerText) === words(body)) : matchingBodies;
  if (titleMatches && matchingContent.length && validUrl(location.href) && matchesAuthor(location.href)) return validUrl(location.href);
  // Blogger returns to the post list: the new post's row shows its exact title and a
  // "View" link to <blog>.blogspot.com that was not on the page before submitting.
  if (job.recipe.engine === 'blogger') {
    const pattern = new RegExp(job.recipe.successUrlPattern);
    for (const link of all('a[jsname="X9tL0d"][href], [jsname="X9tL0d"] a[href], a[href*=".blogspot.com/"]').filter(visible)) {
      if (!pattern.test(link.href) || (task.beforeUrls ?? []).includes(link.href)) continue;
      let row = link;
      for (let depth = 0; depth < 8 && row.parentElement && !words(row.innerText).includes(expectedTitle); depth++) row = row.parentElement;
      if (expectedTitle && words(row.innerText).includes(expectedTitle) && new Set([...row.querySelectorAll('a[href*=".blogspot.com/"]')].map(a => a.href)).size === 1) return link.href;
    }
    return null;
  }
  // MeWe adds the new post on top of the feed without a link: the post header's
  // data-postid gives its permalink. Posts on the page before submitting are excluded.
  if (job.recipe.engine === 'mewe') {
    for (const node of matchingContent) {
      const id = node.closest('.c-mw-post')?.querySelector('.c-mw-post-header[data-postid]')?.getAttribute('data-postid');
      const url = id && /^[A-Za-z0-9_-]+$/.test(id) ? validUrl(`${location.origin}/post/show/${id}`) : null;
      if (url) return url;
    }
    return null;
  }
  // Some social apps stay on the feed. Only accept a permalink inside the
  // matching post, never a global unrelated link or an existing pre-submit post.
  if (!titleRequired) for (const node of matchingContent) {
    const article = node.closest('article, .status, .post, .feed-card, .timeline-status-component, m-activity, [data-post-id], [data-testid="post"]');
    if (article) for (const selector of job.recipe.publishedLinkSelectors ?? []) for (const link of article.querySelectorAll(selector)) {
      const url = validUrl(link.href); if (url && matchesAuthor(url)) return url;
    }
    // Apps without semantic post containers (Quora): climb to the smallest
    // ancestor holding a permalink. Stop at the first one found, even an old
    // (pre-submit) one: climbing further would reach other people's posts.
    let container = node;
    for (let depth = 0; depth < 8 && container.parentElement; depth++) {
      container = container.parentElement;
      const permalinks = [...new Set((job.recipe.publishedLinkSelectors?.length ? job.recipe.publishedLinkSelectors : ['a[href]'])
        .flatMap(selector => [...container.querySelectorAll(selector)]).map(link => permalink(link.href)).filter(Boolean))];
      if (!permalinks.length) continue;
      const fresh = permalinks.length === 1 ? validUrl(permalinks[0]) : null;
      if (fresh && matchesAuthor(fresh)) return fresh;
      break;
    }
  }
  // Lists (profile, "your posts", a redirect to the author page) link the new
  // post by its exact title. Accept a single new permalink with that text.
  if (expectedTitle.split(' ').length >= 3) {
    const titled = [...new Set(all('a[href]').filter(link => visible(link) && words(link.innerText) === expectedTitle).map(link => validUrl(link.href)).filter(Boolean))];
    if (titled.length === 1 && matchesAuthor(titled[0])) return titled[0];
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
