// Chạy tiện ích thật trong Chromium dùng chung: ghép nối, "đăng nhập sẵn" diễn đàn giả lập, chờ tiện ích tự đăng.
// Bản sao thử nghiệm chỉ đổi optional_host_permissions → host_permissions (máy chạy test không bấm được hộp cấp quyền).
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.argv[2]);

const [, , , chromePath, extensionSource, secretsPath, forum, api, shotsDir] = process.argv;

(async () => {
  const testExtension = path.join(path.dirname(secretsPath), 'ext-test');
  fs.rmSync(testExtension, { recursive: true, force: true });
  fs.cpSync(extensionSource, testExtension, { recursive: true });
  const manifest = JSON.parse(fs.readFileSync(path.join(testExtension, 'manifest.json'), 'utf8'));
  manifest.host_permissions = ['http://127.0.0.1/*'];
  delete manifest.optional_host_permissions;
  fs.writeFileSync(path.join(testExtension, 'manifest.json'), JSON.stringify(manifest, null, 2));

  const profile = path.join(path.dirname(secretsPath), 'chrome-profile');
  fs.rmSync(profile, { recursive: true, force: true });
  const context = await chromium.launchPersistentContext(profile, {
    executablePath: chromePath,
    headless: false,
    args: ['--headless=new', `--disable-extensions-except=${testExtension}`, `--load-extension=${testExtension}`],
    viewport: { width: 1280, height: 800 },
  });
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent('serviceworker');
  const extensionId = new URL(worker.url()).host;
  console.log('extension', extensionId);

  // Người dùng đã đăng nhập diễn đàn sẵn trong Chrome của mình.
  const login = await context.newPage();
  await login.goto(`${forum}/login-as`);
  await login.close();

  const { deviceToken } = JSON.parse(fs.readFileSync(secretsPath, 'utf8'));
  await worker.evaluate(([apiUrl, token]) => chrome.storage.local.set({ apiUrl, token, paused: false }), [api, deviceToken]);

  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  const deadline = Date.now() + 120_000;
  let threads = [];
  while (Date.now() < deadline) {
    await popup.evaluate(() => chrome.runtime.sendMessage({ type: 'tick-now' }));
    await new Promise((resolve) => setTimeout(resolve, 4000));
    threads = await (await fetch(`${forum}/api/threads`)).json();
    console.log('threads on forum:', threads.length);
    if (threads.length >= 3) break;
  }
  await new Promise((resolve) => setTimeout(resolve, 3000));
  await popup.reload();
  await popup.setViewportSize({ width: 360, height: 560 });
  await popup.waitForTimeout(800);
  await popup.screenshot({ path: path.join(shotsDir, 'popup-after.png') });
  const history = await worker.evaluate(() => chrome.storage.local.get('history'));
  console.log(JSON.stringify(history.history?.map(({ outcome, platform, account, url, message }) => ({ outcome, platform, account, url, message })), null, 1));
  console.log(JSON.stringify(threads.map(({ engine, title, id }) => ({ engine, title, id })), null, 1));
  await context.close();
})().catch((error) => { console.error(error); process.exit(1); });
