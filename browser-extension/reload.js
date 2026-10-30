// Internal update page for this unpacked extension. Do not interrupt active work.
async function reloadWhenIdle() {
  const { tasks = {} } = await chrome.storage.session.get('tasks');
  if (Object.keys(tasks).length) {
    document.body.textContent = 'Waiting for current extension tasks before reloading…';
    setTimeout(reloadWhenIdle, 1000);
    return;
  }
  chrome.runtime.reload();
}
void reloadWhenIdle();
