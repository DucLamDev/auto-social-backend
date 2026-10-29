// Chuẩn bị dữ liệu thử qua API thật (giống thao tác trên giao diện):
// đăng nhập → tạo mã ghép nối → 3 tài khoản diễn đàn dùng tiện ích → nội dung + biến thể → chiến dịch → đăng.
import { writeFileSync } from 'node:fs';

const api = process.argv[2] ?? 'http://127.0.0.1:3921';
const forum = process.argv[3] ?? 'http://127.0.0.1:3922';
const out = process.argv[4];
let token = '';

async function call(method, path, body) {
  const response = await fetch(`${api}/api/v1${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.success) throw new Error(`${method} ${path} → ${response.status} ${JSON.stringify(payload?.error ?? payload)}`);
  return payload.data;
}

token = (await call('POST', '/auth/login', { email: process.env.SEED_ADMIN_EMAIL, password: process.env.SEED_ADMIN_PASSWORD })).accessToken;
const device = await call('POST', '/extension/devices', { name: 'Chrome thử nghiệm' });
console.log('device', device.name, 'token', `${device.token.slice(0, 8)}…`);

const targets = [
  { slug: 'directadmin-forums', name: 'DirectAdmin (giả lập XenForo)', engine: 'xenforo', url: `${forum}/forums/hosting.12/post-thread` },
  { slug: 'nginx-community', name: 'NGINX (giả lập Discourse)', engine: 'discourse', url: `${forum}/discourse` },
  { slug: 'unraid-forums', name: 'Unraid (giả lập phpBB)', engine: 'phpbb', url: `${forum}/posting.php?mode=post&f=3` },
];
const accounts = [];
for (const target of targets) {
  const account = await call('POST', '/platform-accounts', { platformSlug: target.slug, name: target.name, enabled: true });
  const configured = await call('PUT', `/extension/accounts/${account.id}`, { enabled: true, engine: target.engine, targetUrl: target.url, autoSubmit: true });
  accounts.push({ ...target, id: account.id });
  console.log('account', target.slug, '→', configured.engine, configured.targetUrl);
}

const content = await call('POST', '/contents', {
  title: 'Hướng dẫn tối ưu VPS cho website WordPress',
  body: 'Bài viết thử nghiệm luồng tự đăng bằng tiện ích Chrome.',
  language: 'vi',
});
const campaignTargets = [];
for (const account of accounts) {
  const variant = await call('POST', '/content-variants', {
    contentId: content.id,
    platformSlug: account.slug,
    title: `[TEST] Tối ưu VPS cho WordPress (${account.engine})`,
    body: `Xin chào mọi người,\n\nĐây là bài thử nghiệm tự động đăng qua tiện ích Chrome trên ${account.engine}.\n\nCảm ơn đã đọc!`,
    hashtags: ['vps', 'wordpress'],
  });
  await call('PATCH', `/content-variants/${variant.id}/status`, { status: 'APPROVED' });
  campaignTargets.push({ platformAccountId: account.id, contentVariantId: variant.id });
}
const campaign = await call('POST', '/campaigns', { name: 'Thử tiện ích Chrome', contentId: content.id, targets: campaignTargets, timezone: 'Asia/Ho_Chi_Minh' });
await call('POST', `/campaigns/${campaign.id}/publish`);
console.log('campaign', campaign.id, 'published with', campaignTargets.length, 'targets');

writeFileSync(out, JSON.stringify({ deviceToken: device.token, campaignId: campaign.id, accessToken: token }), { mode: 0o600 });
