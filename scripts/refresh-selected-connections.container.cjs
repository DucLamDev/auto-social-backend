// Operator maintenance for the explicitly selected VPSTTT accounts. No publish
// jobs or secrets are read/created. Run inside the API container after migration.
const { PrismaClient } = require('@prisma/client');
const { ExtensionAgentService } = require('./dist/extension-agent/extension-agent.service');
const { ExtensionLoginCheckService } = require('./dist/extension-agent/extension-login-check.service');
const db = new PrismaClient();
const record = v => v && typeof v === 'object' && !Array.isArray(v) ? v : {};
async function main() {
  const accounts = await db.platformAccount.findMany({ where: { settings: { path: ['extensionImport', 'selected'], equals: true } },
    select: { id: true, ownerId: true, settings: true, platform: { select: { slug: true } } } });
  if (accounts.length !== 42 || new Set(accounts.map(a => a.ownerId)).size !== 1) throw Error('Selected account scope changed');
  const ownerId = accounts[0].ownerId;
  const active = await db.publishJob.count({ where: { platformAccountId: { in: accounts.map(a => a.id) }, status: { in: ['PROCESSING', 'PUBLISHING'] } } });
  if (active) throw Error('Publishing in progress; configuration was not changed');
  for (const account of accounts) {
    const settings = record(account.settings), session = record(settings.extensionSession);
    if (session.deviceId !== '93e21644-21f8-4d5c-8778-725d72f52093') throw Error('Unexpected Chrome profile');
    if (account.platform.slug === 'product-hunt') {
      // Confirmed in the current Chrome's own header, not a public profile lookup.
      const profileUrl = 'https://www.producthunt.com/@vpstttcompany';
      await db.platformAccount.update({ where: { id: account.id }, data: {
        username: 'vpstttcompany',
        settings: { ...settings, extensionSession: { ...session, expectedUsername: 'vpstttcompany', profileUrl,
          identitySelector: 'header a[href="/@vpstttcompany"]', loginUrl: 'https://www.producthunt.com/', discoverIdentity: false },
          extensionSetup: { status: 'FLOW_REQUIRED', message: 'Đã có phiên Product Hunt. Chưa có luồng tự xuất bản launch; bản nháp hiện còn thiếu Launch tags.' } },
      } });
    }
    if (account.platform.slug === 'directadmin-forums') {
      await ExtensionAgentService.prototype.configureAccount.call({ prisma: db }, ownerId, account.id, {
        enabled: true, engine: 'xenforo', autoSubmit: true,
        targetUrl: 'https://forum.directadmin.com/forums/general-technical-discussion-troubleshooting.32/post-thread',
      });
    }
    if (account.platform.slug === 'cloudpanel-forum') {
      await db.platformAccount.update({ where: { id: account.id }, data: { enabled: false,
        settings: { ...settings, extensionSetup: { status: 'ACCESS_RESTRICTED',
          message: 'Đã đăng nhập VPSTTT, nhưng CloudPanel trả 403: không có quyền tạo bài tại cả box Hỏi đáp và Cài đặt. Kiểm tra thông báo tài khoản hoặc nhờ quản trị diễn đàn cấp quyền tạo chủ đề.' } },
      } });
    }
    if (account.platform.slug === 'devto') {
      await db.platformAccount.update({ where: { id: account.id }, data: { enabled: false, status: 'ERROR',
        settings: { ...settings, extensionSetup: { status: 'ACCESS_RESTRICTED',
          message: 'DEV trả 403 tại /new và báo tài khoản đã bị suspended. Cần gửi kháng nghị tới DEV để khôi phục quyền đăng; đăng nhập lại không gỡ được hạn chế này.' } },
      } });
    }
  }
  const batch = await new ExtensionLoginCheckService(db, {}).queue(ownerId, accounts.map(a => a.id), true);
  console.log(JSON.stringify({ selected: accounts.length, updated: ['product-hunt identity', 'directadmin-forums posting destination'], verifyOnly: true, ...batch }));
}
main().catch(error => { console.error(error.message?.includes('scope') || error.message?.includes('profile') || error.message?.includes('progress') ? error.message : 'Connection refresh failed; private details suppressed'); process.exitCode = 1; }).finally(() => db.$disconnect());
