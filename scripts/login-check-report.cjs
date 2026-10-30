// Snapshot of the selected batch, excluding credentials and private browser data.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const source = `const {PrismaClient}=require('@prisma/client');const p=new PrismaClient();(async()=>{
const accounts=await p.platformAccount.findMany({where:{settings:{path:['extensionImport','selected'],equals:true}},include:{platform:{select:{name:true}},extensionLoginChecks:{orderBy:{createdAt:'desc'},take:1}}});
console.log(JSON.stringify(accounts.map(a=>({id:a.id,name:a.name,platform:a.platform.name,expectedUsername:a.settings.extensionSession?.expectedUsername,autoLogin:a.settings.extensionSession?.autoLogin,setup:a.settings.extensionSetup?.status,extensionDelivery:a.settings.delivery==='extension',enabled:a.enabled,connectionStatus:a.status,issues:a.settings.extensionImport?.issues??[],check:a.extensionLoginChecks[0]?{status:a.extensionLoginChecks[0].status,message:a.extensionLoginChecks[0].message,detectedUsername:a.extensionLoginChecks[0].detectedUsername,passwordAttempted:!!a.extensionLoginChecks[0].passwordIssuedAt,totpAttempted:!!a.extensionLoginChecks[0].totpIssuedAt,finishedAt:a.extensionLoginChecks[0].finishedAt}:null}))));
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
  console.log(JSON.stringify({ accounts: accounts.length, counts, publishingConfigured, verifiedConfiguredAccounts, authenticated: accounts.filter(a => a.check?.status === 'AUTHENTICATED').map(a => a.name) }));
}
