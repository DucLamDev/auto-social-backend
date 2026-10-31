// Keep stopped jobs and receipts while updating; never interrupt a submit.
let previousPaused;
async function reloadWhenIdle() {
  if (previousPaused === undefined) {
    previousPaused = (await chrome.storage.local.get('paused')).paused ?? false;
    await chrome.storage.local.set({ paused: true });
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  const { tasks = {} } = await chrome.storage.session.get('tasks');
  if (Object.values(tasks).some(task => !['waitingAuth', 'waitingUser'].includes(task.phase))) {
    document.body.textContent = 'Đang đợi lượt xử lý hiện tại hoàn tất trước khi cập nhật…';
    setTimeout(reloadWhenIdle, 1000);
    return;
  }
  await chrome.storage.local.set({ updateCheckpoint: { tasks, paused: previousPaused } });
  chrome.runtime.reload();
}
void reloadWhenIdle();
