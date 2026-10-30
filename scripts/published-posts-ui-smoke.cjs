// Local UI test only: no social posts are created. Populated examples are intercepted in this browser.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseEnv } = require('node:util');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '..');
const env = parseEnv(fs.readFileSync(path.join(root, '.env'), 'utf8'));
const base = 'http://localhost:3000';
const api = 'http://localhost:3001/api/v1';

(async () => {
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({ viewport: { width: 1500, height: 1050 }, permissions: ['clipboard-read', 'clipboard-write'] });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`${base}/login`);
    await page.locator('[name=email]').fill(env.SEED_ADMIN_EMAIL);
    await page.locator('[name=password]').fill(env.SEED_ADMIN_PASSWORD);
    await page.locator('button[type=submit]').click();
    await page.waitForURL((url) => !url.pathname.includes('/login'));
    const token = await page.evaluate(() => sessionStorage.getItem('sp_access_token'));
    const response = await context.request.get(`${api}/published-posts?limit=1`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(response.status(), 200);
    const actual = await response.json();
    assert.equal(actual.meta.limit, 1);
    assert.equal(typeof actual.meta.total, 'number');
    assert.ok(actual.data.length <= 1);
    const invalid = await context.request.get(`${api}/published-posts?accountId=bad-id`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(invalid.status(), 400);
    const liveLoad = page.waitForResponse((res) => res.url().includes('/api/v1/published-posts?') && res.status() === 200);
    await page.goto(`${base}/published-posts`);
    await liveLoad;
    await page.getByRole('heading', { name: 'Bài đã đăng', exact: true }).waitFor();
    await page.getByRole('link', { name: 'Bài đã đăng', exact: true }).waitFor();
    const review = path.resolve(root, '../ui-review');
    fs.mkdirSync(review, { recursive: true });
    await page.screenshot({ path: path.join(review, 'published-posts-live.png'), fullPage: true });

    const makePost = (id, title, platform, account, url) => ({
      id, publishJobId: `job-${id}`, url, publishedAt: '2026-10-30T06:00:00Z',
      platformAccount: { id: `account-${id}`, name: account, platform: { id: `platform-${id}`, name: platform, slug: platform.toLowerCase() } },
      job: { target: { campaign: { id: 'campaign-review', name: 'Kiến thức máy chủ web' }, contentVariant: { title } } },
    });
    const fixtures = [
      makePost('review-1', 'Hướng dẫn sử dụng NGINX cơ bản', 'NGINX Community', 'NGINX vpsttt', 'https://forum.example.com/t/nginx/123'),
      makePost('review-2', 'Chia sẻ kiến thức triển khai máy chủ web', 'Mastodon', 'Mastodon vpsttt', 'https://social.example.com/@vpsttt/123'),
      makePost('review-3', 'Bài đã đăng nhưng nền tảng chưa trả link', 'Tumblr', 'Tumblr vpsttt', null),
    ];
    let calls = 0;
    await page.route('**/api/v1/published-posts?**', (route) => {
      calls += 1;
      const data = calls === 1 ? fixtures.slice(0, 2) : fixtures;
      return route.fulfill({ json: { success: true, data, meta: { page: 1, limit: 25, total: data.length, totalPages: 1 } } });
    });
    await page.reload();
    await page.getByRole('link', { name: `Mở bài: ${fixtures[0].job.target.contentVariant.title}`, exact: true }).waitFor();
    await page.getByRole('button', { name: `Sao chép link: ${fixtures[0].job.target.contentVariant.title}` }).click();
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), fixtures[0].url);
    await page.getByText(fixtures[2].job.target.contentVariant.title, { exact: true }).waitFor({ timeout: 35000 });
    assert.ok(calls >= 2, 'History should refresh automatically');
    assert.equal(await page.getByRole('link', { name: /^Mở bài:/ }).count(), 2);
    await page.screenshot({ path: path.join(review, 'published-posts-desktop.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForFunction(() => document.querySelector('main').getBoundingClientRect().left < 1 && document.querySelector('aside').getBoundingClientRect().right < 1);
    await page.screenshot({ path: path.join(review, 'published-posts-mobile.png'), fullPage: true });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    assert.equal(overflow, false, 'Page should contain horizontal table scrolling');
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ passed: true, actualPublishedCount: actual.meta.total, checks: ['live authenticated API', 'invalid filter rejection', 'page and navigation', 'exact link copy', 'automatic refresh', 'missing link handling', 'mobile viewport'], screenshots: review }));
  } finally { await browser.close(); }
})().catch((error) => { console.error(error instanceof assert.AssertionError ? error.message : `UI check failed: ${error.name}`); process.exitCode = 1; });
