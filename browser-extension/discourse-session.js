// Runs inside the authenticated tab. Session cookies and CSRF never leave it.
// One POST only: a missing response is uncertain, never a reason to click again.
export async function submitDiscoursePost(job) {
  if (job.recipe.engine !== 'discourse' || !job.autoSubmit) return { status: 'fallback' };
  const needs = message => ({ status: 'filled', message });
  const uncertain = () => ({ status: 'uncertain', message: 'Đã gửi yêu cầu đăng nhưng chưa xác nhận được kết quả. Không tự gửi lại để tránh trùng bài.' });
  if (location.origin !== job.targetOrigin || job.kind === 'LOGIN_CHECK') return needs('Không đúng tab hoặc tác vụ đăng bài.');
  const visible = node => node.getClientRects().length && getComputedStyle(node).visibility !== 'hidden';
  if ((job.recipe.captchaSelectors ?? []).some(s => [...document.querySelectorAll(s)].some(visible))) return { status: 'captcha', message: 'Diễn đàn yêu cầu CAPTCHA.' };
  // Do not send a second post when the current tab already reports moderation.
  if ([...document.querySelectorAll('.d-modal__container,.modal-inner-container,.dialog-container')].some(n => visible(n) && /post needs approval/i.test(n.textContent) && /received your new post/i.test(n.textContent))) {
    return { status: 'moderation', message: 'Diễn đàn đã nhận bài và đang chờ duyệt. Không gửi lại.' };
  }
  const open = new URL(job.openUrl);
  if (open.origin !== location.origin) return needs('Tên miền đích không khớp.');
  const base = open.pathname.replace(/\/(?:new-topic|categories|latest)\/?$/, '').replace(/\/$/, '');
  const endpoint = suffix => `${base}${suffix}`;
  const headers = { 'X-Requested-With': 'XMLHttpRequest', Accept: 'application/json' };
  const read = async path => {
    const response = await fetch(endpoint(path), { credentials: 'same-origin', headers, redirect: 'error', signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw new Error('Read unavailable');
    return response.json();
  };
  const normalize = value => String(value ?? '').normalize('NFKC').trim().toLowerCase();
  const key = `vpsttt:discourse-submit:${job.jobId}`;
  let receipt;
  try { receipt = JSON.parse(sessionStorage.getItem(key) || 'null'); } catch { return uncertain(); }
  if (receipt) return receipt.status === 'moderation' ? receipt : uncertain();
  let current, site, csrf;
  try { [current, site, csrf] = await Promise.all([read('/session/current.json'), read('/site.json'), read('/session/csrf.json')]); }
  catch { return { status: 'fallback' }; } // Read-only failure: DOM workflow is still safe.
  const user = current.current_user;
  if (!user?.id || !user.username) return { status: 'login', message: 'Phiên diễn đàn đã hết hạn.' };
  const expected = job.verifiedSessionUsername || job.auth?.expectedUsername;
  if (expected && normalize(expected) !== normalize(user.username)) return needs('Tài khoản trong tab đã thay đổi; chưa gửi bài.');
  if (user.can_create_topic === false) return { status: 'restricted', message: 'Tài khoản chưa được diễn đàn cấp quyền tạo chủ đề.' };
  if (!csrf.csrf || !Array.isArray(site.categories)) return { status: 'fallback' };
  const categories = site.categories;
  const requested = String(job.options?.category || open.searchParams.get('category') || '').trim();
  const categoryPath = c => {
    const parent = categories.find(p => p.id === c.parent_category_id);
    return parent ? `${parent.slug}/${c.slug}` : c.slug;
  };
  let category;
  if (requested) {
    const matches = categories.filter(c => [String(c.id), c.name, c.slug, categoryPath(c)].some(v => normalize(v) === normalize(requested)));
    if (matches.length === 1) category = matches[0];
    if (!category) return needs(`Không tìm thấy chuyên mục duy nhất “${requested}”. Cấu hình chuyên mục trên web.`);
  } else {
    // Reuse a deliberate visible selection before considering a general category.
    const selected = document.querySelector('#reply-control .category-chooser .select-kit-header, .reply-area .category-chooser .select-kit-header');
    const selectedId = selected?.getAttribute('data-value') || selected?.querySelector('[data-value]')?.getAttribute('data-value');
    category = categories.find(c => String(c.id) === selectedId);
    if (!category && selected) category = categories.find(c => normalize(c.name) === normalize(selected.textContent));
    if (!category) for (const name of ['general', 'general discussion & chat', 'general discussion', 'truenas general', 'uncategorized']) {
      const matches = categories.filter(c => c.permission === 1 && normalize(c.name) === name);
      if (matches.length === 1) { category = matches[0]; break; }
    }
  }
  if (!category) return needs('Chưa có chuyên mục chung được phép đăng. Chọn chuyên mục mặc định một lần trong cài đặt tài khoản trên web.');
  if (category.permission !== 1) return { status: 'restricted', message: `Tài khoản không có quyền tạo chủ đề trong “${category.name}”.` };
  const tags = [...new Set((job.options?.tags?.length ? job.options.tags : (open.searchParams.get('tags') || '').split(','))
    .map(t => String(t).trim().replace(/^#/, '')).filter(Boolean))];
  if (tags.length < (category.minimum_required_tags || 0)) return needs(`Chuyên mục “${category.name}” cần ít nhất ${category.minimum_required_tags} tag. Lưu tag mặc định trên web.`);
  if (!job.post?.title?.trim() || !job.post?.body?.trim()) return needs('Bài chưa có đủ tiêu đề và nội dung.');
  const data = new URLSearchParams({ title: job.post.title, raw: job.post.body, category: String(category.id), archetype: 'regular', nested_post: 'true' });
  for (const tag of tags) data.append('tags[]', tag);
  // A durable per-tab guard is written before the network mutation, including
  // when the service worker restarts or two tab-update events race.
  try {
    if (sessionStorage.getItem(key)) return uncertain();
    sessionStorage.setItem(key, JSON.stringify({ status: 'started' }));
  } catch { return needs('Không lưu được trạng thái chống đăng trùng; chưa gửi bài.'); }
  let response, result;
  try {
    response = await fetch(endpoint('/posts.json'), { method: 'POST', credentials: 'same-origin', redirect: 'error',
      headers: { ...headers, 'X-CSRF-Token': csrf.csrf, 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
      body: data.toString(), signal: AbortSignal.timeout(25000) });
    result = await response.json();
  } catch { return uncertain(); }
  if (response.status >= 500) return uncertain();
  if (!response.ok || result.success === false || result.errors?.length) {
    // Explicit rejection allows a corrected retry; rate limits/auth checks are
    // never evaded with a UI submission or another account.
    if (response.status >= 400 && response.status < 500) sessionStorage.removeItem(key);
    const detail = Array.isArray(result.errors) ? result.errors.filter(x => typeof x === 'string').join('; ').slice(0, 400) : `HTTP ${response.status}`;
    return { status: 'rejected', message: `Diễn đàn từ chối bài: ${detail}` };
  }
  if (result.action === 'enqueued') {
    const pending = { status: 'moderation', message: 'Diễn đàn đã nhận bài và đang chờ quản trị viên duyệt. Không gửi lại bài này.' };
    sessionStorage.setItem(key, JSON.stringify(pending));
    return pending;
  }
  const post = result.post ?? result;
  if (!Number.isInteger(post.id) || !Number.isInteger(post.topic_id) || post.post_number !== 1) return uncertain();
  // Verify exact raw content, author and topic from a separate read before
  // exposing the URL in Published posts. HTTP 200 alone is not publication.
  try {
    const saved = await read(`/posts/${post.id}.json`);
    if (saved.id !== post.id || saved.topic_id !== post.topic_id || saved.post_number !== 1
      || normalize(saved.username) !== normalize(user.username) || saved.raw !== job.post.body) return uncertain();
    const topic = await read(`/t/${post.topic_id}.json`);
    if (topic.id !== post.topic_id || topic.title !== job.post.title) return uncertain();
    const url = `${location.origin}${base}/t/${encodeURIComponent(topic.slug || 'topic')}/${topic.id}`;
    if (!new RegExp(job.recipe.successUrlPattern).test(url)) return uncertain();
    sessionStorage.setItem(key, JSON.stringify({ status: 'published', url }));
    return { status: 'published', url };
  } catch { return uncertain(); }
}
