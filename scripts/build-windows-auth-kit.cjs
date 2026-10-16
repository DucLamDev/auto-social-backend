'use strict';
const { mkdirSync, readFileSync, writeFileSync, copyFileSync } = require('node:fs');
const { resolve, join, dirname } = require('node:path');
const { createRequire } = require('node:module');
const root = resolve(__dirname, '..');

function installedVersion(name) {
  let directory = dirname(require.resolve(name));
  while (true) {
    try {
      const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
      if (manifest.name === name) return manifest.version;
    } catch { /* A module entry may be in a nested directory. */ }
    const parent = dirname(directory);
    if (parent === directory) throw new Error('Installed package manifest not found');
    directory = parent;
  }
}

async function main() {
  const output = resolve(root, process.argv[2] || 'tmp/x-login-windows');
  mkdirSync(output, { recursive: true });
  const localRequire = createRequire(require.resolve('tsx/package.json'));
  const esbuild = localRequire('esbuild');
  const result = await esbuild.build({ absWorkingDir: root, entryPoints: ['scripts/social-auth-smoke.ts'],
    outfile: join(output, 'auth-smoke.cjs'), bundle: true, packages: 'external', platform: 'node',
    format: 'cjs', target: 'node22', metafile: true, sourcemap: false, legalComments: 'none' });
  const external = Object.values(result.metafile.outputs).flatMap((item) => item.imports)
    .filter((item) => item.external && !item.path.startsWith('node:')).map((item) => item.path);
  const permitted = new Set(['playwright', '@nestjs/common', '@nestjs/config']);
  if (external.some((name) => !permitted.has(name))) throw new Error('Unexpected runtime dependency in Windows kit');
  const dependencies = {};
  for (const name of [...new Set([...external, 'reflect-metadata', 'rxjs'])].sort()) {
    dependencies[name] = installedVersion(name);
  }
  writeFileSync(join(output, 'package.json'), JSON.stringify({ name: 'social-publisher-x-login-check',
    version: '1.0.0', private: true, engines: { node: '>=22' }, dependencies }, null, 2) + '\n');
  copyFileSync(join(root, 'scripts', 'windows-x-login.cjs'), join(output, 'windows-x-login.cjs'));
  copyFileSync(join(root, 'WINDOWS_X_LOGIN.md'), join(output, 'README.md'));
  const cmd = (name, lines) => writeFileSync(join(output, name), ['@echo off', 'setlocal', 'chcp 65001 >nul', 'cd /d "%~dp0"',
    'where node >nul 2>&1', 'if errorlevel 1 (', '  echo Can Node.js 22+ tren may nay. Chua thuc hien login.', '  pause', '  exit /b 1', ')',
    ...lines, 'set "taskExit=%ERRORLEVEL%"', 'echo.', 'pause', 'exit /b %taskExit%', ''].join('\r\n'));
  cmd('1-SETUP.cmd', ['node -e "if(Number(process.versions.node.split(\'.\')[0])<22) process.exit(1)"',
    'if errorlevel 1 (', '  echo Can Node.js 22+.', '  pause', '  exit /b 1', ')',
    'set "PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1"', 'call npm.cmd ci --ignore-scripts --no-audit --no-fund']);
  cmd('2-LOGIN-X.cmd', ['node windows-x-login.cjs login account01']);
  cmd('3-CHECK-SESSION.cmd', ['node windows-x-login.cjs check account01']);
  console.log(JSON.stringify({ status: 'BUILT', output, dependencies: Object.keys(dependencies) }));
}
main().catch(() => { console.error('WINDOWS_KIT_BUILD_FAILED'); process.exitCode = 1; });
