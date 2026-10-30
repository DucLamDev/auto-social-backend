const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { before, after, test } = require('node:test');
const { chromium } = require('playwright');
let browser, accountAuthStep;
before(async () => {
  const source = fs.readFileSync(path.join(__dirname, '../../browser-extension/auth-actions.js'), 'utf8');
  ({ accountAuthStep } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`));
  browser = await chromium.launch();
});
after(async () => browser?.close());
const job = { targetOrigin: 'https://forum.test', openUrl: 'https://forum.test/new-topic', recipe: { engine: 'xenforo' },
  auth: { provider: 'password', expectedUsername: 'alice', loginUsername: 'alice@example.test', autoLogin: true, autoTotp: true } };
async function pageAt(url, html) { const page = await browser.newPage(); await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: html })); await page.goto(url); return page; }

test('Tinhte verifies the own profile button rather than another author avatar', async () => {
  const page = await pageAt('https://tinhte.vn/editorv2/create/767/', '<header><button class="profile-button"><img alt="alice" src="data:image/svg+xml,%3Csvg xmlns=\"http://www.w3.org/2000/svg\"/%3E" style="width:30px;height:30px"></button></header><article><img alt="bob"></article>');
  const scoped = { ...job, targetOrigin: 'https://tinhte.vn', recipe: { engine: 'tinhte' } };
  try {
    assert.equal((await page.evaluate(accountAuthStep, { job: scoped })).state, 'authenticated');
    await page.locator('header img').evaluate(n => n.alt = 'bob');
    assert.equal((await page.evaluate(accountAuthStep, { job: scoped })).state, 'mismatch');
  } finally { await page.close(); }
});

test('Pixelfed opens the own user menu and verifies its profile link', async () => {
  const page = await pageAt('https://pixelfed.social/i/web', '<nav><div class="nav-item dropdown"><a href="/i/web" class="nav-link dropdown-toggle" role="button" aria-expanded="false">User Menu</a><div class="dropdown-menu" style="display:none"><a href="/alice">Profile</a></div></div></nav>');
  const scoped = { ...job, targetOrigin: 'https://pixelfed.social', recipe: { engine: 'pixelfed' } };
  try {
    await page.evaluate(() => { document.querySelector('[role=button]').onclick = e => { e.preventDefault(); e.currentTarget.setAttribute('aria-expanded','true'); document.querySelector('.dropdown-menu').style.display='block'; }; });
    assert.equal((await page.evaluate(accountAuthStep, { job: scoped })).state, 'accountMenu');
    await page.evaluate(accountAuthStep, { job: scoped, action: 'accountMenu' });
    assert.equal((await page.evaluate(accountAuthStep, { job: scoped })).state, 'authenticated');
  } finally { await page.close(); }
});

test('Pixelfed verifies its authenticated API identity without opening menus or using a feed author', async () => {
  const page = await pageAt('https://pixelfed.social/i/web', '<article><a href="/bob">@bob</a></article>');
  const scoped = { ...job, targetOrigin: 'https://pixelfed.social', recipe: { engine: 'pixelfed' } };
  try {
    await page.route('**/api/pixelfed/v1/accounts/verify_credentials', route => route.fulfill({ json: { id: '123', username: 'alice' } }));
    assert.equal((await page.evaluate(accountAuthStep, { job: scoped })).state, 'authenticated');
    await page.route('**/api/pixelfed/v1/accounts/verify_credentials', route => route.fulfill({ json: { id: '456', username: 'bob' } }));
    assert.equal((await page.evaluate(accountAuthStep, { job: scoped })).state, 'mismatch');
  } finally { await page.close(); }
});

test('Vivaldi follows its offered SSO link and does not fill Google credentials there', async () => {
  const page = await pageAt('https://social.vivaldi.net/auth/sign_in', '<a href="https://login.vivaldi.net/profile/">vivaldi.net</a>');
  try {
    const scoped = { ...job, targetOrigin: 'https://social.vivaldi.net', recipe: { engine: 'mastodon' } };
    assert.equal((await page.evaluate(accountAuthStep, { job: scoped })).state, 'openLogin');
  } finally { await page.close(); }
});

test('Minds verifies the sidebar own profile rather than feed authors', async () => {
  const page = await pageAt('https://www.minds.com/newsfeed/subscriptions/latest', '<nav><ul class="m-sidebarNavigation__list"><li><a href="/alice"><img style="width:25px;height:25px" alt="">@alice</a></li></ul></nav><article><a href="/bob">@bob</a></article>');
  try { assert.equal((await page.evaluate(accountAuthStep, { job: { ...job, targetOrigin: 'https://www.minds.com' } })).state, 'authenticated'); }
  finally { await page.close(); }
});

test('Discourse accepts the owner email mapping but never another email or only a similar display name', async () => {
  const page = await pageAt('https://forum.test/', '<header></header>');
  const scoped = { ...job, kind: 'LOGIN_CHECK', recipe: { engine: 'discourse' }, auth: { ...job.auth, expectedUsername: 'company', allowIdentityByEmail: true } };
  try {
    await page.route('**/session/current.json', route => route.fulfill({ json: { current_user: { username: 'different-display-name', email: 'alice@example.test' } } }));
    assert.equal((await page.evaluate(accountAuthStep, { job: scoped })).state, 'authenticated');
    await page.route('**/session/current.json', route => route.fulfill({ json: { current_user: { username: 'different-display-name', email: 'other@example.test' } } }));
    assert.equal((await page.evaluate(accountAuthStep, { job: scoped })).state, 'mismatch');
  } finally { await page.close(); }
});

test('Discourse verifies an alias using only the current user email endpoint', async () => {
  const page = await pageAt('https://forum.test/', '<header></header>');
  const scoped = { ...job, kind: 'LOGIN_CHECK', recipe: { engine: 'discourse' }, auth: { ...job.auth, expectedUsername: 'company', allowIdentityByEmail: true } };
  try {
    await page.route('**/session/current.json', route => route.fulfill({ json: { current_user: { username: 'alias' } } }));
    await page.route('**/u/alias/emails.json', route => route.fulfill({ json: { email: 'alice@example.test' } }));
    const result = await page.evaluate(accountAuthStep, { job: scoped });
    assert.equal(result.state, 'authenticated');
    assert.ok(!JSON.stringify(result).includes('alice@example.test'));
  } finally { await page.close(); }
});

test('Differ resolves its own /me canonical profile, never a suggested author', async () => {
  const page = await pageAt('https://differ.blog/', '<div class="dropdown"><div class="avatar" role="button">Account</div></div>');
  try {
    await page.route('**/me', route => route.fulfill({ contentType: 'text/html', body: '<link rel="canonical" href="https://differ.blog/@alice"><a href="/@bob">Suggested author</a>' }));
    const scoped = { ...job, targetOrigin: 'https://differ.blog', recipe: { engine: 'generic' } };
    assert.equal((await page.evaluate(accountAuthStep, { job: scoped })).state, 'authenticated');
    await page.route('**/me', route => route.fulfill({ contentType: 'text/html', body: '<link rel="canonical" href="https://differ.blog/@bob"><a href="/@alice">Suggested author</a>' }));
    assert.equal((await page.evaluate(accountAuthStep, { job: scoped })).state, 'mismatch');
  } finally { await page.close(); }
});

test('DEV opens its account menu and reads the handle from the own profile link', async () => {
  const page = await pageAt('https://dev.to/', '<header><button aria-label="Navigation menu" aria-expanded="false">Menu</button><a id="crayons-header__menu__profile__link" style="display:none" href="/alice">Display name</a></header>');
  try {
    await page.evaluate(() => { document.querySelector('button').onclick = e => { e.currentTarget.setAttribute('aria-expanded','true'); document.querySelector('a').style.display='block'; }; });
    const scoped = { ...job, targetOrigin: 'https://dev.to', recipe: { engine: 'devto' } };
    assert.equal((await page.evaluate(accountAuthStep, { job: scoped })).state, 'accountMenu');
    await page.evaluate(accountAuthStep, { job: scoped, action: 'accountMenu' });
    assert.equal((await page.evaluate(accountAuthStep, { job: scoped })).state, 'authenticated');
  } finally { await page.close(); }
});

test('DEV verifies the signed-in bootstrap identity without opening a menu', async () => {
  const page = await pageAt('https://dev.to/', '<body data-user=\'{"username":"alice"}\'><article><a href="/bob">Bob</a></article></body>');
  try {
    const scoped = { ...job, targetOrigin: 'https://dev.to', recipe: { engine: 'devto' } };
    assert.equal((await page.evaluate(accountAuthStep, { job: scoped })).state, 'authenticated');
    await page.evaluate(() => document.body.setAttribute('data-user', '{"username":"bob"}'));
    assert.equal((await page.evaluate(accountAuthStep, { job: scoped })).state, 'mismatch');
  } finally { await page.close(); }
});

test('Pixelfed resolves a numeric own-profile ID before comparing the username', async () => {
  const page = await pageAt('https://pixelfed.social/i/web', '<nav><a href="/i/web/profile/12345">Profile</a></nav>');
  try {
    await page.route('**/api/v1/accounts/12345', route => route.fulfill({ json: { id: '12345', username: 'alice' } }));
    const scoped = { ...job, targetOrigin: 'https://pixelfed.social', recipe: { engine: 'pixelfed' } };
    assert.equal((await page.evaluate(accountAuthStep, { job: scoped })).state, 'authenticated');
    await page.route('**/api/v1/accounts/12345', route => route.fulfill({ json: { id: '67890', username: 'alice' } }));
    assert.equal((await page.evaluate(accountAuthStep, { job: scoped })).state, 'challenge');
  } finally { await page.close(); }
});

test('checks the logged-in identity and refuses a different account before typing', async () => {
  const page = await pageAt('https://forum.test/', '<a class="p-navgroup-link--user"><span class="p-navgroup-linkText">bob</span></a><input type="password">');
  try {
    assert.equal((await page.evaluate(accountAuthStep, { job })).state, 'mismatch');
    await page.locator('.p-navgroup-linkText').evaluate(node => { node.textContent = 'alice'; });
    assert.equal((await page.evaluate(accountAuthStep, { job })).state, 'authenticated');
  } finally { await page.close(); }
});

test('fills a direct password then TOTP, without returning either secret', async () => {
  const page = await pageAt('https://forum.test/login', '<form><input name="username"><input type="password"><button type="submit" disabled>Log in</button></form>');
  try {
    await page.evaluate(() => { document.querySelector('form').oninput = () => { document.querySelector('button').disabled = ![...document.querySelectorAll('input')].every(x => x.value); }; document.querySelector('form').onsubmit = event => { event.preventDefault(); window.received = [...document.querySelectorAll('input')].map(x => x.value); }; });
    assert.equal((await page.evaluate(accountAuthStep, { job })).state, 'password');
    const result = await page.evaluate(accountAuthStep, { job, action: 'password', expectedPageUrl: page.url(), payload: { username: 'alice@example.test', password: 'fixture-password' } });
    assert.equal(result.state, 'submitted'); assert.ok(!JSON.stringify(result).includes('fixture-password'));
    assert.deepEqual(await page.evaluate(() => window.received), ['alice@example.test', 'fixture-password']);
    await page.evaluate(() => { document.body.innerHTML = '<form><input name="second_factor_token"><button type="submit">Verify</button></form>'; document.querySelector('form').onsubmit = event => { event.preventDefault(); window.code = document.querySelector('input').value; }; });
    assert.equal((await page.evaluate(accountAuthStep, { job })).state, 'totp');
    assert.equal((await page.evaluate(accountAuthStep, { job, action: 'totp', payload: { code: '123456', expiresAt: Date.now() + 20_000 } })).state, 'submitted');
    assert.equal(await page.evaluate(() => window.code), '123456');
  } finally { await page.close(); }
});

test('Google credentials are never filled into the social password form', async () => {
  const page = await pageAt('https://forum.test/login', '<form><input name="username"><input type="password"><button>Log in</button></form><button id="google">Continue with Google</button>');
  try {
    const googleJob = { ...job, auth: { ...job.auth, provider: 'google' } };
    assert.equal((await page.evaluate(accountAuthStep, { job: googleJob, action: 'password', payload: { username: 'alice@example.test', password: 'fixture-password' } })).state, 'google');
    assert.equal(await page.locator('input[type=password]').inputValue(), '');
  } finally { await page.close(); }
});

test('Google chooser selects only the configured account and uses its authenticator step', async () => {
  const page = await pageAt('https://accounts.google.com/AccountChooser', '<button data-identifier="bob@example.test">Bob</button><button data-identifier="alice@example.test">Alice</button>');
  try {
    const googleJob = { ...job, auth: { ...job.auth, provider: 'google' } };
    await page.evaluate(() => { for (const b of document.querySelectorAll('button')) b.onclick = () => { window.selected = b.dataset.identifier; }; });
    assert.equal((await page.evaluate(accountAuthStep, { job: googleJob })).state, 'chooser');
    await page.evaluate(accountAuthStep, { job: googleJob, action: 'choose' });
    assert.equal(await page.evaluate(() => window.selected), 'alice@example.test');
    await page.evaluate(() => { document.body.innerHTML = '<span id="profileIdentifier">bob@example.test</span><input type="password"><div id="passwordNext"><button>Next</button></div>'; });
    assert.equal((await page.evaluate(accountAuthStep, { job: googleJob, action: 'password', payload: { password: 'fixture-password' } })).state, 'mismatch');
    await page.evaluate(() => { document.body.innerHTML = '<span id="profileIdentifier">alice@example.test</span><input name="totpPin" id="totpPin"><div id="totpNext"><button>Next</button></div>'; document.querySelector('button').onclick = () => { window.code = document.querySelector('input').value; }; });
    await page.evaluate(accountAuthStep, { job: googleJob, action: 'totp', payload: { code: '123456', expiresAt: Date.now() + 20_000 } });
    assert.equal(await page.evaluate(() => window.code), '123456');
  } finally { await page.close(); }
});

test('refuses unrecognized SMS/device prompts, expired codes and navigation to another origin', async () => {
  const page = await pageAt('https://forum.test/login', '<p>Enter the code from your text message</p><input autocomplete="one-time-code"><button>Verify</button>');
  try {
    assert.equal((await page.evaluate(accountAuthStep, { job })).state, 'challenge');
    await page.evaluate(() => { document.body.innerHTML = '<input name="second_factor_token"><button>Verify</button>'; });
    assert.equal((await page.evaluate(accountAuthStep, { job, action: 'totp', payload: { code: '123456', expiresAt: 1 } })).state, 'challenge');
    assert.equal(await page.locator('input').inputValue(), '');
    assert.equal((await page.evaluate(accountAuthStep, { job, expectedPageUrl: 'https://forum.test/old-page', action: 'password', payload: { password: 'fixture-password' } })).state, 'changed');
    await page.goto('https://evil.test/');
    assert.equal((await page.evaluate(accountAuthStep, { job })).state, 'challenge');
  } finally { await page.close(); }
});

test('Google phone prompt switches to an offered Authenticator method before requesting a code', async () => {
  const page = await pageAt('https://accounts.google.com/challenge', '<p>Check your phone to verify it is you</p><button>Try another way</button>');
  const googleJob = { ...job, auth: { ...job.auth, provider: 'google' } };
  try {
    await page.evaluate(() => { document.querySelector('button').onclick = () => { document.body.innerHTML = '<button>Get a verification code from the Google Authenticator app</button>'; document.querySelector('button').onclick = () => { document.body.innerHTML = '<input id="totpPin"><div id="totpNext"><button>Next</button></div>'; }; }; });
    assert.equal((await page.evaluate(accountAuthStep, { job: googleJob })).state, 'alternate');
    await page.evaluate(accountAuthStep, { job: googleJob, action: 'alternate' });
    assert.equal((await page.evaluate(accountAuthStep, { job: googleJob })).state, 'totpChoice');
    await page.evaluate(accountAuthStep, { job: googleJob, action: 'totpChoice' });
    assert.equal((await page.evaluate(accountAuthStep, { job: googleJob })).state, 'totp');
  } finally { await page.close(); }
});

test('Google account discovery requires proof of the selected Google identity', async () => {
  const page = await pageAt('https://forum.test/', '<nav><a href="/@old-account">old-account</a></nav>');
  try {
    const discoveryJob = { ...job, kind: 'LOGIN_CHECK', auth: { ...job.auth, provider: 'google', expectedUsername: '', discoverIdentity: true } };
    assert.equal((await page.evaluate(accountAuthStep, { job: discoveryJob })).state, 'challenge');
    const verified = await page.evaluate(accountAuthStep, { job: { ...discoveryJob, authIdentityVerified: true } });
    assert.equal(verified.state, 'authenticated');
    assert.equal(verified.detectedUsername, 'old-account');
  } finally { await page.close(); }
});

test('reports a Vietnamese rejected TOTP before issuing or filling another code', async () => {
  const page = await pageAt('https://accounts.google.com/challenge/totp', '<p>Sai mã. Hãy thử lại.</p><input id="totpPin" aria-invalid="true"><div id="totpNext"><button>Tiếp theo</button></div>');
  try {
    const result = await page.evaluate(accountAuthStep, { job: { ...job, auth: { ...job.auth, provider: 'google' } }, action: 'totp', payload: { code: '123456', expiresAt: Date.now() + 20000 } });
    assert.equal(result.state, 'challenge'); assert.equal(result.googleBlocked, true);
    assert.equal(await page.locator('#totpPin').inputValue(), '');
    assert.ok(!JSON.stringify(result).includes('123456'));
  } finally { await page.close(); }
});

test('a missing submit button is a platform flow issue, not a Google verification failure', async () => {
  const page = await pageAt('https://accounts.google.com/login', '<input id="identifierId">');
  try {
    const result = await page.evaluate(accountAuthStep, { job: { ...job, auth: { ...job.auth, provider: 'google' } }, action: 'identifier', payload: { username: 'alice@example.test' } });
    assert.equal(result.state, 'challenge'); assert.equal(result.googleBlocked, false);
  } finally { await page.close(); }
});

test('Stack Exchange verifies the account ID, not a reputation label or another user with the same name', async () => {
  const page = await pageAt('https://serverfault.com/', '<header class="s-topbar"><a class="s-user-card" href="/users/123/vpsttt">VPSTTT<br>1, 1 reputation</a></header><a href="/questions/tagged/login">login</a>');
  const stackJob = { ...job, targetOrigin: 'https://serverfault.com', recipe: { engine: 'generic' }, auth: { ...job.auth, expectedUsername: 'vpsttt', profileUrl: 'https://serverfault.com/users/123/old-name' } };
  try {
    assert.equal((await page.evaluate(accountAuthStep, { job: stackJob })).state, 'authenticated');
    await page.locator('.s-user-card').evaluate(n => { n.href = '/users/456/vpsttt'; });
    assert.equal((await page.evaluate(accountAuthStep, { job: stackJob })).state, 'mismatch');
    await page.locator('.s-user-card').evaluate(n => n.remove());
    assert.equal((await page.evaluate(accountAuthStep, { job: stackJob, action: 'openLogin' })).state, 'unknown');
    assert.equal(page.url(), 'https://serverfault.com/');
  } finally { await page.close(); }
});

test('Differ opens only the account dropdown and verifies its profile without touching the editor', async () => {
  const page = await pageAt('https://differ.blog/new-story', '<style>.dropdown-content{display:none}.dropdown:focus-within .dropdown-content{display:block}</style><div class="dropdown"><div role="button" tabindex="0" class="avatar">Avatar</div><ul class="dropdown-content"><li><a href="/@vpsttt_group">My profile</a></li></ul></div><button id="publish">Publish</button>');
  const differJob = { ...job, targetOrigin: 'https://differ.blog', recipe: { engine: 'generic' }, auth: { ...job.auth, autoLogin: false, expectedUsername: 'vpsttt_group', profileUrl: 'https://differ.blog/@vpsttt_group' } };
  try {
    await page.evaluate(() => { document.querySelector('#publish').onclick = () => { window.published = true; }; });
    assert.equal((await page.evaluate(accountAuthStep, { job: differJob })).state, 'accountMenu');
    await page.evaluate(accountAuthStep, { job: differJob, action: 'accountMenu' });
    assert.equal((await page.evaluate(accountAuthStep, { job: differJob })).state, 'authenticated');
    assert.equal(await page.evaluate(() => Boolean(window.published)), false);
  } finally { await page.close(); }
});

test('Quora reads the profile handle from the account menu on an allowed locale without logging in again', async () => {
  const page = await pageAt('https://fr.quora.com/following', '<div aria-haspopup="menu" aria-expanded="false"><div aria-label="Menu du compte">Account</div></div>');
  const quoraJob = { ...job, kind: 'LOGIN_CHECK', targetOrigin: 'https://www.quora.com', recipe: { engine: 'quora' }, auth: { ...job.auth, autoLogin: false, expectedUsername: 'VPSTTT', allowedOrigins: ['https://fr.quora.com'] } };
  try {
    await page.evaluate(() => { const toggle = document.querySelector('[aria-haspopup]'); toggle.onclick = () => { toggle.setAttribute('aria-expanded', 'true'); document.body.insertAdjacentHTML('beforeend', '<div role="menu"><a href="/profile/VPSTTT">Different display name</a></div>'); }; });
    assert.equal((await page.evaluate(accountAuthStep, { job: quoraJob })).state, 'accountMenu');
    await page.evaluate(accountAuthStep, { job: quoraJob, action: 'accountMenu' });
    assert.equal((await page.evaluate(accountAuthStep, { job: quoraJob })).state, 'authenticated');
    await page.locator('[role=menu] a').evaluate(n => { n.href = '/profile/Other-account'; n.textContent = 'VPSTTT'; });
    assert.equal((await page.evaluate(accountAuthStep, { job: quoraJob })).state, 'mismatch');
  } finally { await page.close(); }
});
