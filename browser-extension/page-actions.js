// Functions injected into the forum tab with chrome.scripting.executeScript.
// Each one must be self-contained (no imports, no outer variables): Chrome
// serializes the function source and runs it in the page's isolated world.

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
  const find = (selectors) => {
    for (const selector of selectors) {
      const element = [...document.querySelectorAll(selector)].find(visible);
      if (element) return element;
    }
    return null;
  };
  const shows = (selectors) => Boolean(find(selectors));
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
  for (let round = 0; round < 40; round += 1) {
    if (shows(recipe.readySelectors)) { ready = true; break; }
    if (shows(recipe.loginSelectors)) return { status: 'login', message: `Chưa đăng nhập ${location.host} trong Chrome này` };
    await sleep(500);
  }
  if (!ready) {
    return shows(recipe.loginSelectors)
      ? { status: 'login', message: `Chưa đăng nhập ${location.host} trong Chrome này` }
      : { status: 'notReady', message: `Không thấy form đăng bài tại ${location.href}` };
  }

  const title = find(recipe.titleSelectors);
  const body = find(recipe.bodySelectors);
  if (!title || !body) return { status: 'notReady', message: 'Không thấy ô tiêu đề hoặc nội dung' };

  setValue(title, task.post.title);
  if (body.isContentEditable) {
    body.focus();
    body.innerHTML = task.post.body
      .split(/\n{2,}/)
      .map((paragraph) => `<p>${escapeHtml(paragraph).replace(/\n/g, '<br>')}</p>`)
      .join('');
    body.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertFromPaste' }));
  } else {
    setValue(body, task.post.body);
  }
  await sleep(800);

  const keptTitle = normalize(title.value ?? '') === normalize(task.post.title);
  const bodyText = body.isContentEditable ? body.innerText : body.value;
  const keptBody = normalize(bodyText ?? '').startsWith(normalize(task.post.body).slice(0, 40));
  if (!keptTitle || !keptBody) return { status: 'notReady', message: 'Trình soạn thảo không giữ được nội dung vừa điền' };

  if (shows(recipe.captchaSelectors)) return { status: 'captcha', message: 'Diễn đàn yêu cầu CAPTCHA' };
  if (!task.autoSubmit) return { status: 'filled' };

  const submit = find(recipe.submitSelectors);
  if (!submit || submit.disabled) return { status: 'notReady', message: 'Không thấy nút Đăng hoặc nút đang bị khoá' };
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
