// Read-only diagnosis of an idle managed profile. Never submits a form, reads
// an input value, exports cookies, or prints a credential-bearing URL.
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { chromium } = require('playwright');
const { directory, readPrivate } = require('./private-account-input.cjs');
const selected = process.argv.includes('--device') ? process.argv[process.argv.indexOf('--device') + 1] : null;
const query = `const {PrismaClient}=require('@prisma/client');const p=new PrismaClient();(async()=>{
const checks=await p.extensionLoginCheck.findMany({include:{account:{select:{settings:true,platform:{select:{slug:true}}}}}});
console.log(JSON.stringify(checks.map(c=>({id:c.id,deviceId:c.deviceId,status:c.status,platform:c.account.platform.slug,url:c.account.settings.extensionSession?.loginUrl}))));
})().finally(()=>p.$disconnect());`;
async function main() {
  const child = spawnSync('docker', ['compose', 'exec', '-T', 'api', 'node', '-'], { cwd: path.resolve(__dirname, '..'), input: query, encoding: 'utf8', windowsHide: true });
  if (child.status) throw new Error('Cannot load check status');
  const checks = JSON.parse(child.stdout);
  const devices = readPrivate('managed-devices').filter(d => (!selected || d.id === selected)
    && !checks.some(c => c.deviceId === d.id && ['QUEUED', 'RUNNING'].includes(c.status)));
  for (const device of devices) {
    const context = await chromium.launchPersistentContext(path.join(directory, 'profiles', device.id), { headless: true, args: ['--disable-extensions'] });
    try {
      for (const check of checks.filter(c => c.deviceId === device.id && c.status === 'NEEDS_ACTION' && c.url)) {
        const page = await context.newPage();
        try {
          const response = await page.goto(check.url, { waitUntil: 'domcontentloaded', timeout: 25_000 });
          await page.waitForTimeout(1500);
          const diagnostic = await page.evaluate(() => {
            const visible = node => node.getClientRects().length > 0 && getComputedStyle(node).visibility !== 'hidden';
            const safeText = value => String(value ?? '').replace(/[\w.+-]+@[\w.-]+/g, '[email]').replace(/[A-Za-z0-9_-]{30,}/g, '[opaque]').slice(0, 100);
            const body = document.body?.innerText ?? '';
            return { origin: location.origin, path: safeText(location.pathname),
              signals: { invalidCredentials: /incorrect password|invalid (?:email|password|credentials)|wrong password|sign.in failed/i.test(body), captcha: /verify you are human|captcha|checking your browser|security verification/i.test(body), confirmEmail: /confirm your email|verify your email|confirmation email/i.test(body), suspended: /account (?:is )?(?:suspended|disabled|locked)/i.test(body) },
              inputs: [...document.querySelectorAll('input')].filter(visible).map(n => ({ name: n.name, id: n.id, type: n.type, autocomplete: n.autocomplete })),
              buttons: [...document.querySelectorAll('button,[role=button],input[type=submit]')].filter(visible).slice(0, 20).map(n => ({ text: safeText(n.innerText || n.getAttribute('aria-label')), id: n.id, type: n.type })),
              profileLinks: [...document.querySelectorAll('nav a,header a,[role=navigation] a')].filter(visible).filter(n => /profile|\/u\/|\/@|account|settings/i.test(n.getAttribute('href') ?? '')).slice(0, 10).map(n => ({ text: safeText(n.innerText), path: safeText(new URL(n.href).pathname) })),
            };
          });
          console.log(JSON.stringify({ checkId: check.id, platform: check.platform, httpStatus: response?.status(), ...diagnostic }));
        } catch { console.log(JSON.stringify({ checkId: check.id, platform: check.platform, diagnostic: 'LOAD_FAILED' })); }
        finally { await page.close(); }
      }
    } finally { await context.close(); }
  }
}
main().catch(() => { console.error('Read-only session inspection failed; private details suppressed'); process.exitCode = 1; });
