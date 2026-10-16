'use strict';
const { existsSync } = require('node:fs');
const { join, resolve } = require('node:path');
const { spawnSync } = require('node:child_process');

function findChrome(env, isFile = existsSync) {
  if (env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH) {
    return isFile(env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH) ? env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH : undefined;
  }
  const roots = [env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.LOCALAPPDATA].filter(Boolean);
  return roots.map((root) => join(root, 'Google', 'Chrome', 'Application', 'chrome.exe')).find(isFile);
}

function argumentsFor(mode, accountLabel, root, smokePath) {
  if (!['login', 'check'].includes(mode)) throw new Error('MODE_INVALID');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(accountLabel)) throw new Error('ACCOUNT_LABEL_INVALID');
  return [smokePath, '--platform', 'x', '--account-label', accountLabel, '--profiles-dir', root,
    '--timeout-ms', mode === 'login' ? '300000' : '60000',
    mode === 'login' ? '--manual-login' : '--inspect-session'];
}

function main() {
  if (process.platform !== 'win32') throw new Error('WINDOWS_REQUIRED');
  if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('NODE_22_REQUIRED');
  if (!process.env.LOCALAPPDATA) throw new Error('LOCALAPPDATA_UNAVAILABLE');
  const chrome = findChrome(process.env);
  if (!chrome) throw new Error('CHROME_NOT_FOUND');
  const smokePath = join(__dirname, 'auth-smoke.cjs');
  if (!existsSync(smokePath) || !existsSync(join(__dirname, 'node_modules', 'playwright'))) throw new Error('RUN_SETUP_FIRST');
  const root = resolve(process.env.LOCALAPPDATA, 'VPSTTT', 'SocialPublisher', 'profiles');
  const args = argumentsFor(process.argv[2] || 'login', process.argv[3] || 'account01', root, smokePath);
  console.log('Chrome dùng profile riêng của bot. Không dùng profile Chrome cá nhân hoặc gửi session lên VPS.');
  const result = spawnSync(process.execPath, args, { cwd: __dirname, stdio: 'inherit', shell: false,
    env: { ...process.env, PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH: chrome } });
  if (result.error) throw new Error('PROCESS_START_FAILED');
  process.exitCode = result.status ?? 1;
}

module.exports = { findChrome, argumentsFor };
if (require.main === module) {
  try { main(); } catch (error) {
    console.error(JSON.stringify({ status: 'ERROR', errorCode: error.message }));
    process.exitCode = 1;
  }
}
