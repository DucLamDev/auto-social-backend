// Windows DPAPI, scoped to the signed-in Windows user. No plaintext files or
// command-line arguments. Secrets enter child processes only through stdin.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const directory = path.join(process.env.LOCALAPPDATA, 'VPSTTT Social Publisher');
function dpapi(input, decrypt = false) {
  const command = decrypt
    ? '$v=[Console]::In.ReadToEnd(); $s=ConvertTo-SecureString $v; [Console]::Out.Write(([Net.NetworkCredential]::new("",$s)).Password)'
    : '$v=[Console]::In.ReadToEnd(); [Console]::Out.Write((ConvertTo-SecureString -String $v -AsPlainText -Force | ConvertFrom-SecureString))';
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { input, encoding: 'utf8', windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
  if (result.status !== 0) throw new Error('Windows could not protect/unprotect private configuration');
  return result.stdout.trim();
}
function savePrivate(name, value) {
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, name + '.dpapi'), dpapi(JSON.stringify(value)), 'utf8');
}
function readPrivate(name) { return JSON.parse(dpapi(fs.readFileSync(path.join(directory, name + '.dpapi'), 'utf8'), true)); }
module.exports = { directory, savePrivate, readPrivate };
if (require.main === module) {
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdout.write('Private input ready (input is not echoed)\n');
  let input = '';
  process.stdin.on('data', part => {
    input += part.toString();
    if (!/[\r\n]/.test(input)) return;
    try {
      const value = JSON.parse(input.trim());
      if (typeof value.loginUsername !== 'string' || typeof value.password !== 'string' || typeof value.totpSecret !== 'string') throw new Error();
      savePrivate('google-override', value);
      process.stdout.write('Google override protected with Windows DPAPI.\n');
    } catch { process.stdout.write('Private input rejected; no credential printed.\n'); process.exitCode = 1; }
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.exit(process.exitCode ?? 0);
  });
}
