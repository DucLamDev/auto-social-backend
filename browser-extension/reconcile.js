// Reads receipts for existing tasks. An explicit resume parameter can continue
// a pre-submit task; the worker rejects tasks that may already have been sent.
// Tokens remain in the extension.
import { readSocialPublishedPost } from './social-actions.js';
import { readDiscourseReceiptNotice, showPublishNotice } from './publish-notice.js';
async function reconcile() {
  const resume = new URL(location.href).searchParams.get('resume');
  if (resume && /^[a-f0-9-]{36}$/.test(resume)) {
    document.getElementById('result').textContent = JSON.stringify(await chrome.runtime.sendMessage({ type: 'resume-pre-submit', jobId: resume }));
    return;
  }
  if (new URL(location.href).searchParams.get('mode') === 'notices') {
    const { lastHeartbeat, history = [] } = await chrome.storage.local.get(['lastHeartbeat', 'history']);
    const jobIds = history.filter(item => item.reason === 'MODERATION_PENDING' && item.outcome === 'NEEDS_ACTION').map(item => item.jobId);
    const results = [];
    for (const origin of lastHeartbeat?.origins ?? []) {
      if (!await chrome.permissions.contains({ origins: [`${origin}/*`] })) continue;
      for (const tab of await chrome.tabs.query({ url: `${origin}/*` })) {
        try {
          const [{ result: notice }] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: readDiscourseReceiptNotice, args: [jobIds] });
          if (!notice) continue;
          const [{ result: shown }] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: showPublishNotice, args: [notice] });
          results.push({ tabId: tab.id, origin, shown });
        } catch { /* Closed tab or navigation: never submit anything. */ }
      }
    }
    document.getElementById('result').textContent = JSON.stringify(results);
    return;
  }
  const { tasks = {} } = await chrome.storage.session.get('tasks');
  const { apiUrl, token } = await chrome.storage.local.get(['apiUrl', 'token']);
  const results = [];
  for (const task of Object.values(tasks)) {
    if (!task.submittedAt || !['submitted', 'waitingUser'].includes(task.phase) || !['mastodon', 'pixelfed'].includes(task.job.recipe.engine)) continue;
    const [{ result: url }] = await chrome.scripting.executeScript({ target: { tabId: task.tabId }, func: readSocialPublishedPost, args: [task] });
    if (!url) { results.push({ jobId: task.job.jobId, confirmed: false }); continue; }
    const response = await fetch(`${apiUrl.replace(/\/$/, '')}/api/v1/extension/agent/tasks/${task.job.jobId}/result`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ outcome: 'PUBLISHED', url }) });
    results.push({ jobId: task.job.jobId, confirmed: true, recorded: response.ok, url });
    // Leave task cleanup to the worker; it cannot submit again in these phases.
  }
  document.getElementById('result').textContent = JSON.stringify(results);
}
reconcile().catch(() => { document.getElementById('result').textContent = 'Không xác nhận được kết quả. Không gửi lại bài.'; });
