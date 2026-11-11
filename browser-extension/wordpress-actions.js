// Injected by value into a WordPress block editor tab (<site>/wp-admin/post-new.php) in the
// page's MAIN world: the editor's own data API (wp.data, wp.blocks, wp.apiFetch) keeps its
// state consistent and publishes through WordPress itself. Keep every helper inside.

/**
 * Writes the title and the post (its HTML turned into blocks), attaches the planned image
 * as featured image and first block, then publishes, or submits for review when the account
 * may not publish (Contributor). Never touches a post that is not a fresh new post.
 */
export async function fillWordPress(job) {
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const wait = async (check, ms = 30_000) => {
    for (const until = Date.now() + ms; Date.now() < until; await sleep(250)) {
      try { const value = check(); if (value) return value; } catch { /* the editor is still booting */ }
    }
    return null;
  };
  const words = text => String(text ?? '').normalize('NFKC').toLowerCase().replace(/<[^>]+>/g, ' ').match(/[\p{L}\p{N}]+/gu) ?? [];
  const escapeHtml = text => text.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  const post = job.post ?? {};

  if (/\/wp-login\.php$/.test(location.pathname) || document.querySelector('#loginform')) {
    return { status: 'login', message: 'Chưa đăng nhập WordPress trong Chrome này.' };
  }
  // WordPress.com's own editor (wordpress.com/post/<site>) runs the block editor in a frame on another origin.
  if (location.hostname === 'wordpress.com') {
    return { status: 'notReady', message: 'WordPress.com đang mở trình soạn kiểu WordPress.com. Vào Settings → General của blog, chọn Admin interface style: Classic, rồi giao lại cho tiện ích.' };
  }
  const wp = await wait(() => (window.wp?.data?.select?.('core/editor')?.getCurrentPost?.()?.id && window.wp.blocks?.rawHandler ? window.wp : null));
  // No `missing` field: the composer AI hint re-runs the social runner, which does not drive this editor.
  if (!wp) return { status: 'notReady', message: `Không thấy trình soạn bài WordPress (block editor) tại ${location.href}.` };
  const { data, blocks } = wp;
  const editor = data.select('core/editor');
  const current = editor.getCurrentPost();
  // Only a fresh new post; another draft in this tab is the operator's.
  if (current.status !== 'auto-draft' || String(editor.getEditedPostAttribute('title') ?? '').trim() || words(editor.getEditedPostContent()).length) {
    return { status: 'draft', message: 'Trình soạn WordPress đang có bài khác; chưa ghi đè. Mở trang Viết bài mới (post-new.php) rồi giao lại.' };
  }
  const html = typeof post.bodyHtml === 'string' && post.bodyHtml.trim() ? post.bodyHtml
    : String(post.body ?? '').split(/\n{2,}/).map(part => `<p>${escapeHtml(part).replace(/\n/g, '<br>')}</p>`).join('');
  data.dispatch('core/editor').editPost({ title: post.title });
  data.dispatch('core/block-editor').resetBlocks(blocks.rawHandler({ HTML: html }));
  await sleep(300);
  const lead = words(html).slice(0, 12).join(' ');
  if (editor.getEditedPostAttribute('title') !== post.title || !words(editor.getEditedPostContent()).join(' ').includes(lead)) {
    return { status: 'contentMismatch', message: 'Trình soạn WordPress không giữ đúng tiêu đề / nội dung; chưa đăng.' };
  }

  // The planned image: uploaded to the media library, set as featured image and shown first.
  const asset = job.attachments?.[0];
  if (asset) {
    try {
      const bytes = Uint8Array.from(atob(asset.base64), char => char.charCodeAt(0));
      const form = new FormData();
      form.append('file', new File([bytes], asset.name, { type: asset.mimeType }));
      if (asset.altText) form.append('alt_text', asset.altText);
      const media = await wp.apiFetch({ path: '/wp/v2/media', method: 'POST', body: form });
      if (!media?.id || !media.source_url) throw new Error('no media');
      data.dispatch('core/editor').editPost({ featured_media: media.id });
      data.dispatch('core/block-editor').insertBlocks(blocks.createBlock('core/image', { id: media.id, url: media.source_url, alt: asset.altText || '' }), 0);
    } catch {
      return { status: 'filled', message: 'Đã điền bài nhưng chưa tải được ảnh lên thư viện WordPress, nên chưa đăng. Thêm ảnh rồi bấm Publish, hoặc bỏ ảnh của kênh này trên web rồi giao lại.' };
    }
  }
  if (!job.autoSubmit) return { status: 'filled' };

  // Gutenberg's own rule: Publish needs the post's publish action; otherwise Submit for Review.
  const canPublish = Boolean(current._links?.['wp:action-publish']);
  data.dispatch('core/editor').editPost({ status: canPublish ? 'publish' : 'pending' });
  try { await data.dispatch('core/editor').savePost(); } catch { /* reported below */ }
  if (!editor.didPostSaveRequestSucceed()) {
    const error = data.select('core').getLastEntitySaveError?.('postType', current.type, current.id);
    return { status: 'rejected', message: `WordPress không lưu được bài${error?.message ? `: ${String(error.message).slice(0, 200)}` : ''}.` };
  }
  const saved = editor.getCurrentPost();
  if (saved.status === 'publish' && typeof saved.link === 'string' && saved.link.startsWith(location.origin)) return { status: 'published', url: saved.link };
  if (saved.status === 'pending') return { status: 'moderation', message: 'Tài khoản WordPress này chỉ được gửi bài để duyệt (Contributor): bài đang chờ biên tập viên của blog duyệt.' };
  return { status: 'uncertain', message: `WordPress lưu bài ở trạng thái "${saved.status}" thay vì đăng; kiểm tra trong tab.` };
}
