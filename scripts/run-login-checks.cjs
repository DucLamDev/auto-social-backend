// Local profile launcher. Uses the same MV3 extension as the user's Chrome.
// Private inputs stay in DPAPI + Chrome storage; logs contain only check states.
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const { directory, readPrivate } = require('./private-account-input.cjs');
const apiUrl = 'http://localhost:3001';
const watch = process.argv.includes('--watch');
const active = new Map();
const completed = new Set();
let stopping = false;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function api(device, endpoint) {
  const response = await fetch(`${apiUrl}/api/v1/extension/agent/${endpoint}`, { method: endpoint === 'heartbeat' ? 'POST' : 'GET',
    headers: { authorization: `Bearer ${device.token}`, 'content-type': 'application/json' }, signal: AbortSignal.timeout(15_000) });
  const payload = await response.json();
  if (!response.ok || !payload.success) throw new Error('Backend unavailable');
  return payload.data;
}
async function run(device) {
  const beat = await api(device, 'heartbeat');
  const extensionPath = path.join(directory, 'extensions', device.id);
  fs.mkdirSync(extensionPath, { recursive: true });
  for (const name of fs.readdirSync(path.join(__dirname, '../browser-extension'))) {
    const source = path.join(__dirname, '../browser-extension', name);
    if (fs.statSync(source).isFile()) fs.copyFileSync(source, path.join(extensionPath, name));
  }
  const manifestFile = path.join(extensionPath, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  manifest.host_permissions = [...new Set([`${apiUrl}/*`, 'http://127.0.0.1/*', ...beat.origins.map(origin => `${origin}/*`)])];
  // Only the selected imported account origins are granted to this dedicated profile.
  delete manifest.optional_host_permissions;
  fs.writeFileSync(manifestFile, JSON.stringify(manifest));
  const context = await chromium.launchPersistentContext(path.join(directory, 'profiles', device.id), {
    executablePath: chromium.executablePath(), headless: !process.argv.includes('--visible'),
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
  });
  try {
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    await worker.evaluate(({ apiUrl, token }) => chrome.storage.local.set({ apiUrl, token, loginChecksOnly: true, paused: false }), { apiUrl, token: device.token });
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${worker.url().split('/')[2]}/popup.html`);
    const deadline = Date.now() + 45 * 60_000;
    while (!stopping && Date.now() < deadline) {
      await sleep(5000);
      // Wake the extension; the normal 30-second alarm also works without this launcher.
      await popup.evaluate(() => chrome.runtime.sendMessage({ type: 'tick-now' })).catch(() => {});
      const status = await api(device, 'login-checks/status');
      for (const check of status.checks) if (!['QUEUED', 'RUNNING'].includes(check.status) && !completed.has(check.id)) {
        completed.add(check.id);
        console.log(JSON.stringify({ platform: check.account.platform.name, status: check.status, message: check.message }));
      }
      if (!status.pending) break;
    }
  } finally { await context.close(); }
}
async function main() {
  do {
    const devices = readPrivate('managed-devices');
    for (const device of devices) {
      if (stopping || active.size >= 2) break;
      if (active.has(device.id)) continue;
      const status = await api(device, 'login-checks/status');
      if (!status.pending) continue;
      active.set(device.id, run(device).catch(() => console.log(JSON.stringify({ profile: device.name, status: 'LAUNCH_ERROR' }))).finally(() => active.delete(device.id)));
    }
    if (active.size) await Promise.race([...active.values(), sleep(5000)]);
    else if (watch) await sleep(10_000);
    else break;
  } while (!stopping);
  await Promise.allSettled(active.values());
}
process.on('SIGINT', () => { stopping = true; });
process.on('SIGTERM', () => { stopping = true; });
main().catch(() => { console.error('Login launcher stopped; private details suppressed'); process.exitCode = 1; });
