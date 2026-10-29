/**
 * Kiểm tra nhanh một hệ thống đã dựng (docker compose): API, hạ tầng, đăng nhập,
 * OAuth provider nào sẵn sàng, tài khoản và việc cần xử lý. Chỉ đọc, trừ khi
 * truyền --check (chạy gia hạn token + kiểm tra kết nối ngay, quyền ADMIN).
 *
 *   SMOKE_EMAIL=admin@... SMOKE_PASSWORD=... pnpm smoke:stack [--api http://localhost:3001] [--check]
 *
 * Mật khẩu chỉ đọc từ biến môi trường, không in ra.
 */
interface Envelope<T> { success: boolean; data: T; error?: { code?: string; message?: string } }

const args = process.argv.slice(2);
const apiIndex = args.indexOf('--api');
const api = (apiIndex >= 0 ? args[apiIndex + 1] : process.env.SMOKE_API_URL ?? 'http://localhost:3001')?.replace(/\/$/, '');
const runCheck = args.includes('--check');
let failures = 0;

function line(ok: boolean, label: string, detail = ''): void {
  if (!ok) failures += 1;
  console.log(`${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`);
}

async function call<T>(path: string, init: RequestInit = {}, token?: string): Promise<{ status: number; body?: Envelope<T> }> {
  const headers = new Headers(init.headers);
  headers.set('accept', 'application/json');
  if (init.body) headers.set('content-type', 'application/json');
  if (token) headers.set('authorization', `Bearer ${token}`);
  const response = await fetch(`${api}${path}`, { ...init, headers, signal: AbortSignal.timeout(30_000) });
  const body = await response.json().catch(() => undefined) as Envelope<T> | undefined;
  return { status: response.status, body };
}

async function main(): Promise<void> {
  console.log(`Kiểm tra ${api}\n`);
  const health = await call<{ status: string }>('/health').catch(() => undefined);
  line(health?.status === 200, 'API đang chạy (/health)', health ? `HTTP ${health.status}` : 'không kết nối được');
  if (!health) return;

  const ready = await call<{ database: string; redis: string; rabbitmq: string }>('/ready').catch(() => undefined);
  const infra = ready?.body?.data;
  line(ready?.status === 200 && infra?.redis === 'up' && infra.rabbitmq === 'up', 'PostgreSQL, Redis, RabbitMQ (/ready)',
    infra ? `database ${infra.database}, redis ${infra.redis}, rabbitmq ${infra.rabbitmq}` : `HTTP ${ready?.status ?? '?'}`);

  const email = process.env.SMOKE_EMAIL;
  const password = process.env.SMOKE_PASSWORD;
  if (!email || !password) {
    line(false, 'Đăng nhập', 'đặt SMOKE_EMAIL và SMOKE_PASSWORD (tài khoản seed) để kiểm tra tiếp');
    return;
  }
  const login = await call<{ accessToken: string; user: { roles: string[] } }>('/api/v1/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) });
  const token = login.body?.data?.accessToken;
  line(Boolean(token), 'Đăng nhập', token ? `vai trò ${login.body?.data.user.roles.join(', ')}` : `HTTP ${login.status} ${login.body?.error?.code ?? ''}`);
  if (!token) return;

  const providers = await call<Array<{ provider: string; status: string }>>('/api/v1/oauth/providers', {}, token);
  const list = providers.body?.data ?? [];
  const readyProviders = list.filter((item) => item.status === 'READY').map((item) => item.provider);
  line(providers.status === 200, 'OAuth provider', readyProviders.length ? `sẵn sàng: ${readyProviders.join(', ')}` : 'chưa provider nào sẵn sàng (thiếu App ID/Secret)');
  for (const name of ['threads', 'instagram', 'tumblr', 'google', 'linkedin']) {
    const item = list.find((provider) => provider.provider === name);
    if (item && item.status !== 'READY') console.log(`  · ${name}: ${item.status}`);
  }

  const accounts = await call<Array<{ status: string; enabled: boolean; platform?: { slug: string } }>>('/api/v1/platform-accounts', {}, token);
  const rows = accounts.body?.data ?? [];
  const byStatus = rows.reduce<Record<string, number>>((count, row) => ({ ...count, [row.status]: (count[row.status] ?? 0) + 1 }), {});
  line(accounts.status === 200, 'Tài khoản đích', rows.length ? Object.entries(byStatus).map(([status, n]) => `${status} ${n}`).join(', ') : 'chưa có tài khoản nào');

  if (runCheck) {
    const check = await call<{ tokens: Record<string, number>; connections: Record<string, number> }>('/api/v1/account-health/check', { method: 'POST' }, token);
    const data = check.body?.data;
    line(check.status === 200, 'Gia hạn token + kiểm tra kết nối', data ? `gia hạn ${data.tokens.refreshed ?? 0}, kiểm tra ${data.connections.checked ?? 0}, lỗi ${(data.tokens.failed ?? 0) + (data.connections.failed ?? 0)}` : `HTTP ${check.status}`);
  }

  const attention = await call<{ total: number; alertsEnabled: boolean; jobs: Record<string, number>; accounts: { problems: unknown[]; expiringSoon: unknown[] } }>('/api/v1/account-health', {}, token);
  const summary = attention.body?.data;
  line(attention.status === 200, 'Việc cần xử lý (/account-health)', summary
    ? `${summary.total} việc: ${summary.accounts.problems.length} tài khoản hỏng, ${summary.accounts.expiringSoon.length} token sắp hết hạn, ${summary.jobs.needsAction ?? 0} bài cần thao tác, ${summary.jobs.failed ?? 0} bài thất bại`
    : `HTTP ${attention.status}`);
  if (summary) console.log(`  · cảnh báo webhook: ${summary.alertsEnabled ? 'bật' : 'tắt (ALERT_WEBHOOK_URL trống)'}`);
}

main()
  .catch((error: unknown) => line(false, 'Lỗi không mong đợi', error instanceof Error ? error.message : 'unknown'))
  .finally(() => {
    console.log(failures ? `\n${failures} mục chưa đạt.` : '\nTất cả mục đạt.');
    process.exitCode = failures ? 1 : 0;
  });
