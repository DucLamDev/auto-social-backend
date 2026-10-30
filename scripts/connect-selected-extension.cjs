// Uses the explicitly selected source and the operator's protected Google login.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { readPrivate } = require('./private-account-input.cjs');
const root = path.resolve(__dirname, '..');
const args = process.argv.slice(2), value = flag => args[args.indexOf(flag) + 1];
function run(program, argv, input) {
  const r = spawnSync(program, argv, { cwd: root, input, encoding: 'utf8', windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
  if (r.status !== 0) throw Error('Private configuration command failed; child output suppressed');
  return r.stdout;
}
try {
  for (const flag of ['--paste', '--device', '--google-email']) if (!args.includes(flag)) throw Error('Missing required option');
  const rows = JSON.parse(run('python', ['scripts/read-social-accounts.py', '--paste', value('--paste'), '--brand', 'vpsttt', '--json']));
  const emailOnly = rows.filter(r => !r.password && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(r.loginUsername));
  const google = readPrivate('google-override');
  if (google.loginUsername.toLowerCase() !== value('--google-email').toLowerCase()) throw Error('Stored Google identity does not match the requested email');
  run('docker', ['compose', 'cp', 'scripts/connect-selected-extension.container.cjs', 'api:/app/connect-selected-extension.cjs']);
  const result = JSON.parse(run('docker', ['compose', 'exec', '-T', 'api', 'node', '/app/connect-selected-extension.cjs'], JSON.stringify({
    deviceId: value('--device'), googleEmail: value('--google-email'), google, emailOnlySources: emailOnly.map(r => r.source), queue: args.includes('--queue'),
  })));
  fs.writeFileSync(path.join(root, 'reports/extension-connections.json'), JSON.stringify({ generatedAt: new Date().toISOString(), ...result }, null, 2));
  const { report, ...counts } = result; console.log(JSON.stringify(counts));
} catch (error) { console.error(error.message); process.exitCode = 1; }
