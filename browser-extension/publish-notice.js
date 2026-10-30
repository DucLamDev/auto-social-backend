// Injected functions are self-contained. Never modify or submit the composer.
export function showPublishNotice(notice) {
  if (location.origin !== notice.targetOrigin || !['moderation', 'published'].includes(notice.status)) return false;
  const id = 'vpsttt-publish-notice';
  const previous = document.getElementById(id);
  if (previous?.dataset.jobId === notice.jobId) return true;
  previous?.remove();
  const host = document.createElement('aside');
  host.id = id;
  host.dataset.jobId = notice.jobId;
  host.dataset.status = notice.status;
  host.style.cssText = 'position:fixed;right:20px;top:20px;z-index:2147483647;width:min(460px,calc(100vw - 40px));';
  const root = host.attachShadow({ mode: 'open' });
  const panel = document.createElement('div');
  panel.setAttribute('role', 'status');
  panel.style.cssText = 'box-sizing:border-box;background:#f0fdf4;color:#14532d;border:2px solid #16a34a;border-radius:12px;padding:20px;font:15px/1.5 system-ui,sans-serif;box-shadow:0 8px 32px #0003;';
  const close = document.createElement('button');
  close.type = 'button';
  close.textContent = '×';
  close.setAttribute('aria-label', 'Đóng thông báo');
  close.style.cssText = 'float:right;margin:-6px -4px 0 12px;border:0;background:transparent;color:inherit;font:26px system-ui;cursor:pointer;';
  close.onclick = () => host.remove();
  const heading = document.createElement('strong');
  heading.textContent = notice.status === 'moderation' ? 'Đã gửi bài · chờ diễn đàn duyệt' : 'Đã đăng bài thành công';
  const detail = document.createElement('p');
  detail.style.cssText = 'margin:10px 0 0;';
  detail.textContent = notice.status === 'moderation'
    ? 'Diễn đàn đã nhận bài từ Social Publisher. Khung soạn thảo có thể vẫn còn nội dung; không cần bấm Đăng lại.'
    : 'Social Publisher đã xác nhận bài được đăng. Không cần bấm Đăng lại.';
  panel.append(close, heading, detail);
  if (notice.title) {
    const title = document.createElement('p');
    title.style.cssText = 'margin:8px 0 0;font-size:13px;overflow-wrap:anywhere;';
    title.textContent = `Bài đã gửi: ${String(notice.title).slice(0, 300)}`;
    panel.append(title);
  }
  if (notice.status === 'published' && notice.url) {
    try {
      const url = new URL(notice.url);
      if (url.origin === location.origin && !url.username && !url.password) {
        const link = document.createElement('a');
        link.href = url.href;
        link.textContent = 'Mở bài đã đăng';
        link.style.cssText = 'display:block;margin-top:10px;color:inherit;text-decoration:underline;';
        panel.append(link);
      }
    } catch { /* No fabricated or unsafe link. */ }
  }
  root.append(panel);
  document.documentElement.append(host);
  return true;
}

// Restore only receipts also acknowledged in this extension's own history.
export function readDiscourseReceiptNotice(jobIds) {
  for (const jobId of jobIds) {
    try {
      const receipt = JSON.parse(sessionStorage.getItem(`vpsttt:discourse-submit:${jobId}`) || 'null');
      if (receipt?.status === 'moderation') return { jobId, status: 'moderation', targetOrigin: location.origin };
    } catch { /* Ignore unrelated or invalid storage. */ }
  }
  return null;
}
