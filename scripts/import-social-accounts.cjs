const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { directory, readPrivate, savePrivate } = require('./private-account-input.cjs');
const root = path.resolve(__dirname, '..');
function run(program, args, input) {
  const result = spawnSync(program, args, { cwd: root, input, encoding: 'utf8', windowsHide: true, maxBuffer: 10 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`${program} failed; private child output suppressed`);
  return result.stdout;
}
try {
  const args = process.argv.slice(2);
  const value = name => args[args.indexOf(name) + 1];
  if (!args.includes('--paste') || !args.includes('--google-device')) throw new Error('Supply --paste and --google-device');
  const currentChrome = args.includes('--current-chrome');
  const brand = args.includes('--brand') ? value('--brand') : '';
  const preferredPasswords = args.includes('--prefer-xlsx-passwords') ? value('--prefer-xlsx-passwords') : '';
  const allRows = JSON.parse(run('python', [path.join(__dirname, 'read-social-accounts.py'), ...(args.includes('--xlsx') ? ['--xlsx', value('--xlsx')] : []), '--paste', value('--paste'), '--prefer-xlsx-passwords', preferredPasswords, ...(brand ? ['--brand', brand] : []), '--json']));
  const platforms = args.includes('--platforms') ? value('--platforms').split(',') : null;
  const rows = platforms ? allRows.filter(row => platforms.includes(row.platform)) : allRows;
  if (!rows.length) throw new Error('No rows matched the selected platforms');
  let privateDevices = [];
  if (fs.existsSync(path.join(directory, 'managed-devices.dpapi'))) privateDevices = readPrivate('managed-devices');
  run('docker', ['compose', 'cp', 'scripts/bulk-account-import.container.cjs', 'api:/app/bulk-account-import.cjs']);
  const result = JSON.parse(run('docker', ['compose', 'exec', '-T', 'api', 'node', '/app/bulk-account-import.cjs'], JSON.stringify({
    rows, ...(!currentChrome ? { google: readPrivate('google-override') } : {}), googleDeviceId: value('--google-device'), privateDevices,
    currentChrome, brand, replaceSelection: currentChrome && Boolean(brand), queue: args.includes('--queue'),
  })));
  savePrivate('managed-devices', result.privateDevices);
  const reportFile = path.join(root, 'reports/account-import.json');
  const previous = platforms && fs.existsSync(reportFile) ? JSON.parse(fs.readFileSync(reportFile, 'utf8')) : null;
  const updatedSources = new Set(result.report.flatMap(row => row.sources));
  const accounts = [...(previous?.accounts ?? []).filter(row => !row.sources.some(source => updatedSources.has(source))), ...result.report];
  const report = { sourceRows: allRows.length, brand, currentChrome, preferredXlsxPasswords: preferredPasswords ? preferredPasswords.split(',').filter(Boolean) : previous?.preferredXlsxPasswords ?? [], accounts, batch: result.batch, googleDeviceId: result.googleDeviceId };
  fs.mkdirSync(path.join(root, 'reports'), { recursive: true });
  fs.writeFileSync(reportFile, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ sourceRows: rows.length, accounts: result.report.length, configured: result.report.filter(r => r.configured).length,
    autoLogin: result.report.filter(r => r.autoLogin).length, sessionOnly: result.report.filter(r => r.configured && !r.autoLogin).length,
    needsInput: result.report.filter(r => r.issues.length).map(r => ({ platform: r.platform, sources: r.sources, issues: r.issues })), managedProfiles: currentChrome ? 0 : result.privateDevices.length, batch: result.batch }));
} catch (error) { console.error(error.message); process.exitCode = 1; }
