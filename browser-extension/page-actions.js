// Functions injected into the forum tab with chrome.scripting.executeScript.
// Each one must be self-contained (no imports, no outer variables): Chrome
// serializes the function source and runs it in the page's isolated world.

/** Check the document, not the tab's network-load status. Safe to retry. */
export function canFillPage(recipe, targetOrigin) {
  if (location.origin !== targetOrigin) return false;
  const selectors = [...recipe.readySelectors, ...recipe.loginSelectors];
  if (recipe.engine === 'discourse') selectors.push('#reply-control', '.reply-area[role="dialog"]', 'button#create-topic');
  return selectors.some((selector) => [...document.querySelectorAll(selector)].some((element) => element.getClientRects().length > 0))
    || document.readyState === 'complete';
}

/**
 * Waits for the composer, fills title + body, and clicks Post when allowed.
 * Never submits when the page shows a CAPTCHA, a login form, or an editor
 * that did not keep the text.
 */
export async function fillAndSubmit(task) {
  const recipe = task.recipe;
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const visible = (element) => Boolean(element)
    && element.getClientRects().length > 0
    && getComputedStyle(element).visibility !== 'hidden';
  const find = (selectors, root = document) => {
    for (const selector of selectors) {
      const element = [...root.querySelectorAll(selector)].find(visible);
      if (element) return element;
    }
    return null;
  };
  const shows = (selectors) => Boolean(find(selectors));
  // Scope every field/action to one composer. Fall back to the title-input
  // component when the expected IDs are absent.
  // Keep this compatibility in the extension so queued jobs with an older
  // backend recipe can still be filled after reloading the extension.
  const fields = () => {
    if (recipe.engine !== 'discourse') {
      return { root: document, title: find(recipe.titleSelectors), body: find(recipe.bodySelectors) };
    }
    const roots = [...new Set([
      ...document.querySelectorAll('.reply-area[role="dialog"]'),
      ...document.querySelectorAll('#reply-control'),
    ])].filter(visible);
    let partial;
    for (const root of roots) {
      const title = find([...recipe.titleSelectors, '#reply-title', '.title-input input:not([type="hidden"])'], root);
      const body = find([...recipe.bodySelectors, 'textarea.d-editor-input', '.ProseMirror[contenteditable="true"]'], root);
      if (title && body) return { root, title, body };
      if (!partial && (title || body)) partial = { root, title, body };
    }
    return partial ?? { root: roots[0], title: null, body: null };
  };
  const setValue = (element, value) => {
    const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
    element.focus();
    if (setter) setter.call(element, value); else element.value = value;
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
  };
  const escapeHtml = (text) => text.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  const normalize = (text) => text.replace(/\s+/g, ' ').trim();

  // Discourse renders the composer a moment after load; XenForo/phpBB are static.
  let ready = false;
  let openedComposer = false;
  let switchedToMarkdown = false;
  for (let round = 0; round < 40; round += 1) {
    const { root, title, body } = fields();
    // Use Discourse's own toggle so its editor state updates as well as the DOM.
    // Replacing ProseMirror.innerHTML alone can leave the template in the model.
    if (recipe.engine === 'discourse' && root && !switchedToMarkdown) {
      const toggle = find(['button.composer-toggle-switch[data-rich-editor="true"]', 'button.composer-toggle-switch[aria-checked="true"]'], root);
      if (toggle && !toggle.disabled) {
        switchedToMarkdown = true;
        toggle.click();
        await sleep(300);
        continue;
      }
    }
    if (switchedToMarkdown && body?.isContentEditable) { await sleep(500); continue; }
    if ((recipe.engine === 'discourse' || shows(recipe.readySelectors)) && title && body
      && !title.disabled && !title.readOnly && !body.disabled && !body.readOnly) { ready = true; break; }
    if (shows(recipe.loginSelectors)) return { status: 'login', message: `Chưa đăng nhập ${location.host} trong Chrome này` };
    // /new-topic can return to the category list before the composer opens.
    // Try only Discourse's explicit New Topic button, once, after allowing the
    // normal route transition to finish. Never click a submit button here.
    if (recipe.engine === 'discourse' && !openedComposer && !title && !body && round >= 4) {
      const opener = find(['button#create-topic']);
      if (opener && !opener.disabled && opener.getAttribute('aria-disabled') !== 'true') {
        openedComposer = true;
        opener.click();
      }
    }
    await sleep(500);
  }
  if (!ready) {
    return shows(recipe.loginSelectors)
      ? { status: 'login', message: `Chưa đăng nhập ${location.host} trong Chrome này` }
      : { status: 'notReady', message: `Không thấy form đăng bài tại ${location.href}` };
  }

  const { root: composer, title, body } = fields();
  if (!title || !body) return { status: 'notReady', message: 'Không thấy ô tiêu đề hoặc nội dung' };

  setValue(title, task.post.title);
  if (body.isContentEditable) {
    body.focus();
    if (recipe.engine === 'discourse') {
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(body);
      selection.removeAllRanges();
      selection.addRange(range);
      if (!document.execCommand('insertText', false, task.post.body)) {
        return { status: 'notReady', message: 'Không điền được trình soạn thảo. Chuyển sang chế độ Markdown rồi thử lại.' };
      }
    } else {
      body.innerHTML = task.post.body
        .split(/\n{2,}/)
        .map((paragraph) => `<p>${escapeHtml(paragraph).replace(/\n/g, '<br>')}</p>`)
        .join('');
      body.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertFromPaste' }));
    }
  } else {
    setValue(body, task.post.body);
  }
  await sleep(800);

  const keptTitle = normalize(title.value ?? '') === normalize(task.post.title);
  const bodyText = body.isContentEditable ? body.innerText : body.value;
  const keptBody = normalize(bodyText ?? '') === normalize(task.post.body);
  if (!keptTitle || !keptBody) return { status: 'notReady', message: 'Trình soạn thảo không giữ được nội dung vừa điền' };

  if (shows(recipe.captchaSelectors)) return { status: 'captcha', message: 'Diễn đàn yêu cầu CAPTCHA' };

  if (recipe.engine === 'discourse') {
    const tagChooser = find(['.mini-tag-chooser'], composer);
    const configuredTags = [...new Set((new URL(task.openUrl ?? location.href).searchParams.get('tags') ?? '')
      .split(',').map((tag) => tag.trim().replace(/^#/, '').toLowerCase()).filter(Boolean))];
    const tagHeader = () => tagChooser?.querySelector('.select-kit-header');
    const selectedTags = () => {
      if (!tagChooser) return [];
      const selected = [...tagChooser.querySelectorAll('.select-kit-header .selected-name, .selected-content .selected-name, .selected-tag, .select-kit-header .discourse-tag, .select-kit-header [data-tag-name]')]
        .map((element) => normalize(element.getAttribute('data-tag-name') ?? element.getAttribute('data-name') ?? element.textContent).toLowerCase());
      // Current Discourse renders the selected tag names as "tag-a, tag-b"
      // in the header. Its search endpoint excludes those selected tags, so
      // failing to read this makes an existing selection look unavailable.
      const formatted = tagHeader()?.querySelector('.formatted-selection')?.textContent ?? '';
      return [...selected, ...formatted.split(',').map((tag) => normalize(tag).toLowerCase()).filter(Boolean)];
    };
    const hasTag = (tag) => selectedTags().includes(tag);
    const needsTag = /(?:select|choose) at least\s+\d+\s+tags?/i.test(tagHeader()?.textContent ?? '')
      || tagChooser?.getAttribute('aria-required') === 'true';
    if (!configuredTags.length && needsTag) {
      return { status: 'filled', message: 'Đã điền bài. Chuyên mục yêu cầu tag; chọn tag trong tab hoặc cấu hình Tags trong phần Tiện ích rồi giao lại.' };
    }
    if (configuredTags.length > 10 || (configuredTags.length && !tagChooser)) {
      return { status: 'filled', message: 'Đã điền bài nhưng chưa chọn được tag đã cấu hình. Kiểm tra mục Tags trong tab diễn đàn.' };
    }
    for (const tag of configuredTags) {
      if (hasTag(tag)) continue;
      const header = tagHeader();
      if (!header || header.disabled || header.getAttribute('aria-disabled') === 'true') {
        return { status: 'filled', message: `Đã điền bài nhưng ô chọn tag đang khóa: ${tag}` };
      }
      if (header.getAttribute('aria-expanded') !== 'true') header.click();
      let filter;
      for (let round = 0; round < 12; round += 1) {
        filter = tagChooser.querySelector('.select-kit-filter input');
        if (visible(filter)) break;
        await sleep(250);
      }
      if (!visible(filter)) return { status: 'filled', message: `Không mở được bộ chọn tag: ${tag}. Kiểm tra trong tab diễn đàn.` };
      setValue(filter, tag);
      let option;
      for (let round = 0; round < 20; round += 1) {
        // MiniTagChooser now uses TagRow; older versions used TagChooserRow.
        // Keep generic action/create rows excluded even when their name matches.
        option = [...tagChooser.querySelectorAll('.select-kit-row.tag-row, .select-kit-row.tag-chooser-row')].find((row) => visible(row)
          && !row.classList.contains('disabled') && row.getAttribute('aria-disabled') !== 'true'
          && normalize(row.getAttribute('data-name') ?? row.querySelector('.discourse-tag')?.textContent ?? '').toLowerCase() === tag);
        if (option) break;
        await sleep(250);
      }
      if (!option) return { status: 'filled', message: `Không chọn được tag “${tag}” từ danh sách của chuyên mục. Kiểm tra ô Tags trong tab diễn đàn.` };
      option.click();
      for (let round = 0; round < 12 && !hasTag(tag); round += 1) await sleep(250);
      if (!hasTag(tag)) return { status: 'filled', message: `Diễn đàn chưa giữ lại tag “${tag}”. Kiểm tra tag trước khi đăng.` };
    }
    if (tagHeader()?.getAttribute('aria-expanded') === 'true') tagHeader().click();
    await sleep(300);
  }
  if (shows(recipe.captchaSelectors)) return { status: 'captcha', message: 'Diễn đàn yêu cầu CAPTCHA' };
  if (!task.autoSubmit) return { status: 'filled' };

  const { root: finalComposer, title: finalTitle, body: finalBody } = fields();
  if (normalize(finalTitle?.value ?? '') !== normalize(task.post.title)
    || normalize(finalBody?.isContentEditable ? finalBody.innerText : finalBody?.value ?? '') !== normalize(task.post.body)) {
    return { status: 'filled', message: 'Nội dung đã thay đổi trong lúc chọn tag. Kiểm tra lại bài trong tab trước khi đăng.' };
  }

  const submit = recipe.engine === 'discourse'
    ? find([...recipe.submitSelectors, 'button.create', '.save-or-cancel button.btn-primary'], finalComposer)
    : find(recipe.submitSelectors);
  if (!submit || submit.disabled || submit.getAttribute('aria-disabled') === 'true') return { status: 'notReady', message: 'Không thấy nút Đăng hoặc nút đang bị khoá' };
  submit.click();
  return { status: 'submitted' };
}

/** After clicking Post: returns the forum's error banner text, if any. */
export function readErrors(recipe) {
  for (const selector of recipe.errorSelectors) {
    const element = [...document.querySelectorAll(selector)].find((node) => node.getClientRects().length > 0);
    if (element && element.innerText.trim()) return element.innerText.trim().slice(0, 400);
  }
  return null;
}

/** A successful submission can enter moderation instead of yielding a URL. */
export function readModeration(recipe) {
  if (recipe.engine !== 'discourse' && recipe.workflow !== 'social') return null;
  for (const dialog of document.querySelectorAll('.d-modal__container, .modal-inner-container, .dialog-container, dialog[open], [role="alert"], [role="status"]')) {
    if (!dialog.getClientRects().length || getComputedStyle(dialog).visibility === 'hidden') continue;
    const text = dialog.textContent.replace(/\s+/g, ' ').trim();
    if ((/post needs approval/i.test(text) && /received your new post/i.test(text)
      && /approved by a moderator/i.test(text)) || (recipe.workflow === 'social' && /(?:post|article|bài viết).{0,100}(?:submitted for review|pending approval|pending review|chờ duyệt)/i.test(text))) {
      return 'Diễn đàn đã nhận bài và đang chờ quản trị viên duyệt. Không gửi lại bài này.';
    }
  }
  return null;
}

// A topic-shaped URL alone is not proof: the user may have opened an existing
// welcome topic while a submission was awaiting approval. Verify the rendered
// title and the start of the first post before reporting success.
export function readPublishedPost(task) {
  if (location.origin !== task.job.targetOrigin
    || !new RegExp(task.job.recipe.successUrlPattern).test(location.href)) return null;
  const selectors = {
    discourse: ['#topic-title h1', '.topic-post .cooked, #post_1 .cooked'],
    xenforo: ['h1.p-title-value', '.message--post .message-body .bbWrapper'],
    phpbb: ['h2.topic-title', '.post .content'],
  }[task.job.recipe.engine];
  if (!selectors) return null;
  const visible = element => element && element.getClientRects().length > 0;
  const title = document.querySelector(selectors[0]);
  const body = document.querySelector(selectors[1]);
  if (!visible(title) || !visible(body)) return null;
  const words = value => (String(value).normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).join(' ');
  const expectedTitle = words(task.job.post?.title ?? '');
  if (!expectedTitle || words(title.innerText) !== expectedTitle) return null;
  const markdown = String(task.job.post?.body ?? '')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1');
  const expectedBody = words(markdown).split(' ').slice(0, 40).join(' ');
  if (!expectedBody || !words(body.innerText).includes(expectedBody)) return null;
  return location.href;
}
