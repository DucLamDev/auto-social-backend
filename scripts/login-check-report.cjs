// Snapshot of the selected batch, excluding credentials and private browser data.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const source = `const {PrismaClient}=require('@prisma/client');const p=new PrismaClient();(async()=>{
const {extensionFlowAudit}=require('./dist/connectors/extension/extension-flow-audit');
const accounts=await p.platformAccount.findMany({where:{settings:{path:['extensionImport','selected'],equals:true}},include:{platform:{select:{name:true,slug:true}},extensionLoginChecks:{orderBy:{createdAt:'desc'},take:50}}});
const safe=c=>c?{status:c.status,message:c.message,detectedUsername:c.detectedUsername,passwordAttempted:!!c.passwordIssuedAt,totpAttempted:!!c.totpIssuedAt,finishedAt:c.finishedAt}:null;
console.log(JSON.stringify(accounts.map(a=>({id:a.id,name:a.name,platform:a.platform.name,expectedUsername:a.settings.extensionSession?.expectedUsername,autoLogin:a.settings.extensionSession?.autoLogin,setup:a.settings.extensionSetup?.status,extensionDelivery:a.settings.delivery==='extension',enabled:a.enabled,connectionStatus:a.status,issues:a.settings.extensionImport?.issues??[],posting:extensionFlowAudit(a.platform.slug,a.settings),check:safe(a.extensionLoginChecks[0]),attempts:['password','google'].map(method=>({method,available:a.settings.extensionLoginMethods?.[method]?.available===true,check:safe(a.extensionLoginChecks.find(c=>!c.verifyOnly&&c.method===method))}))}))));
})().finally(()=>p.$disconnect());`;
const result = spawnSync('docker', ['compose', 'exec', '-T', 'api', 'node', '-'], { cwd: root, input: source, encoding: 'utf8', windowsHide: true });
if (result.status !== 0) { console.error('Could not read login status; child output suppressed'); process.exitCode = 1; }
else {
  const accounts = JSON.parse(result.stdout);
  const counts = accounts.reduce((sum, account) => { const status = account.check?.status ?? 'NOT_TESTED'; sum[status] = (sum[status] ?? 0) + 1; return sum; }, {});
  const publishingConfigured = accounts.filter(a => a.extensionDelivery).length;
  const verifiedConfiguredAccounts = accounts.filter(a => a.extensionDelivery && a.enabled && a.check?.status === 'AUTHENTICATED').map(a => a.name);
  const report = { generatedAt: new Date().toISOString(), selection: 'vpsttt and variants', profile: 'current Chrome', counts, publishingConfigured, verifiedConfiguredAccounts, accounts };
  fs.writeFileSync(path.join(root, 'reports/login-check-results.json'), JSON.stringify(report, null, 2));
  const cell = value => '"' + String(value ?? '').replace(/^[=+@-]/, "'$&").replace(/"/g, '""') + '"';
  const attempt = (a, method) => { const item = a.attempts.find(x => x.method === method); return item?.check ? item.check.status + ': ' + (item.check.message || '') : item?.available ? 'Chưa cần thử / chưa chạy' : 'Không có thông tin cho cách này'; };
  const csv = [['Tài khoản', 'Kết nối', 'Bật đăng', 'Lần kiểm tra gần nhất', 'Luồng đăng', 'Mật khẩu', 'Google'], ...accounts.map(a => [a.name, a.connectionStatus, a.enabled && a.extensionDelivery ? 'Có' : 'Chưa', a.check?.message, a.posting.message, attempt(a, 'password'), attempt(a, 'google')])];
  fs.writeFileSync(path.join(root, 'reports/social-connection-audit.csv'), '\ufeff' + csv.map(row => row.map(cell).join(',')).join('\r\n'));
  console.log(JSON.stringify({ accounts: accounts.length, counts, publishingConfigured, verifiedConfiguredAccounts, authenticated: accounts.filter(a => a.check?.status === 'AUTHENTICATED').map(a => a.name) }));
}
