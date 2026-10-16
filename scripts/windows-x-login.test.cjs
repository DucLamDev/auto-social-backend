'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { join } = require('node:path');
const { findChrome, argumentsFor } = require('./windows-x-login.cjs');

test('an explicit missing Chrome path fails instead of silently switching browser', () => {
  const env = { PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH: '/fixture/missing-chrome.exe', PROGRAMFILES: '/fixture/programs' };
  assert.equal(findChrome(env, () => false), undefined);
});
test('finds an existing user Chrome executable without installing or inspecting a profile', () => {
  const env = { PROGRAMFILES: '/fixture/programs', LOCALAPPDATA: '/fixture/user' };
  const wanted = join(env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe');
  assert.equal(findChrome(env, (path) => path === wanted), wanted);
});
test('login/check use the same profile root and label, without a CSV or credential argument', () => {
  const login = argumentsFor('login', 'account02', '/fixture/profiles', '/fixture/auth-smoke.cjs');
  const check = argumentsFor('check', 'account02', '/fixture/profiles', '/fixture/auth-smoke.cjs');
  assert.equal(login.includes('--manual-login'), true);
  assert.equal(check.includes('--inspect-session'), true);
  for (const args of [login, check]) {
    assert.equal(args[args.indexOf('--profiles-dir') + 1], '/fixture/profiles');
    assert.equal(args[args.indexOf('--account-label') + 1], 'account02');
    assert.equal(args.includes('--headless'), false);
    assert.equal(args.includes('--auth-file'), false);
  }
  assert.throws(() => argumentsFor('auto', 'account02', '/fixture/profiles', '/fixture/smoke'), /MODE_INVALID/);
  assert.throws(() => argumentsFor('login', '../other', '/fixture/profiles', '/fixture/smoke'), /ACCOUNT_LABEL_INVALID/);
});
