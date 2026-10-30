// Run inside the rebuilt API container. All fixtures and service writes are
// rolled back in one transaction, and nothing is posted to an external site.
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { PrismaClient } = require('@prisma/client');
const { ConfigService } = require('@nestjs/config');
const { CredentialEncryptionService } = require('./dist/credentials/credential-encryption.service');
const { CredentialsService } = require('./dist/credentials/credentials.service');
const { ExtensionAccountSessionService } = require('./dist/extension-agent/extension-account-session.service');
const { ExtensionAgentService } = require('./dist/extension-agent/extension-agent.service');
const { ExtensionLoginCheckService } = require('./dist/extension-agent/extension-login-check.service');
const db = new PrismaClient();
const rollback = new Error('ROLLBACK_TEST_FIXTURES');
let fixtureOwner;
(async () => {
  try {
    await db.$transaction(async tx => {
      const config = new ConfigService();
      const scoped = { ...tx, $transaction: run => run(tx) };
      const encryption = new CredentialEncryptionService(config);
      const credentials = new CredentialsService(scoped, encryption, config);
      const sessions = new ExtensionAccountSessionService(scoped, credentials, encryption);
      const agent = new ExtensionAgentService(scoped, { refresh: async () => {} }, {});
      const owner = await tx.user.create({ data: { email: `fixture-${randomUUID()}@example.invalid`, displayName: 'Rollback fixture', passwordHash: 'not-a-login-hash' } });
      fixtureOwner = owner.id;
      const platform = await tx.platform.findUniqueOrThrow({ where: { slug: 'nginx-community' } });
      const content = await tx.content.create({ data: { ownerId: owner.id, title: 'Fixture', body: 'Fixture content', contentHash: randomUUID() } });
      const variant = await tx.contentVariant.create({ data: { contentId: content.id, platformId: platform.id, title: 'Fixture', body: 'Fixture content', hashtags: [] } });
      const campaign = await tx.campaign.create({ data: { ownerId: owner.id, contentId: content.id, name: 'Rollback fixture' } });
      const fixtures = [];
      for (const name of ['alice', 'bob']) {
        const device = await tx.extensionDevice.create({ data: { ownerId: owner.id, name, tokenHash: randomUUID() } });
        const account = await tx.platformAccount.create({ data: { ownerId: owner.id, platformId: platform.id, name, username: name,
          settings: { delivery: 'extension', extensionEngine: 'discourse', extensionTargetUrl: 'https://community.nginx.org/new-topic', extensionAutoSubmit: true } } });
        const input = { deviceId: device.id, provider: 'password', expectedUsername: name, autoLogin: true, autoTotp: true,
          loginUrl: 'https://community.nginx.org/login', loginUsername: name, password: `fixture-password-${name}`, totpSecret: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ' };
        // Migrating an account from an expired credential must not leave the
        // newly configured password/TOTP blocked by the old expiry timestamp.
        await credentials.upsert(account.id, {}, new Date(0), tx);
        const saved = await sessions.configure(owner.id, account.id, input);
        assert.equal(saved.passwordConfigured, true);
        const record = await tx.platformCredential.findUniqueOrThrow({ where: { platformAccountId: account.id } });
        assert.equal(record.encryptedPayload.includes(input.password), false);
        assert.equal(record.expiresAt, null);
        assert.equal(encryption.decrypt(record.encryptedPayload).extensionLogin.password, input.password);
        const target = await tx.campaignTarget.create({ data: { campaignId: campaign.id, platformAccountId: account.id, contentVariantId: variant.id } });
        const job = await tx.publishJob.create({ data: { campaignTargetId: target.id, platformAccountId: account.id, idempotencyKey: randomUUID(), scheduledAt: new Date(), status: 'NEEDS_ACTION',
          attempts: { create: { attemptNumber: 1, status: 'STARTED', responseMetadata: { extensionQueued: true } } } } });
        fixtures.push({ account, device, job });
      }
      const [a, b] = fixtures;
      assert.equal(await agent.claim(a.device, [], ['discourse']), null); // old extension
      const aTask = await agent.claim(a.device, [], ['discourse'], 1);
      const bTask = await agent.claim(b.device, [], ['discourse'], 1);
      assert.equal(aTask.account.id, a.account.id); assert.equal(bTask.account.id, b.account.id);
      assert.equal(await agent.claim(a.device, [], ['discourse'], 1), null);
      await assert.rejects(sessions.authStep(b.device, a.job.id, { step: 'password', pageUrl: 'https://community.nginx.org/login' }));
      const password = await sessions.authStep(a.device, a.job.id, { step: 'password', pageUrl: 'https://community.nginx.org/login' });
      assert.equal(password.username, 'alice');
      await assert.rejects(sessions.authStep(a.device, a.job.id, { step: 'password', pageUrl: 'https://community.nginx.org/login' }));
      await assert.rejects(agent.report(b.device, a.job.id, { outcome: 'FAILED', reason: 'LOGIN_REQUIRED' }));
      const checks = new ExtensionLoginCheckService(scoped, credentials);
      assert.equal((await checks.queue(owner.id)).queued, 2);
      assert.equal((await checks.queue(owner.id)).queued, 0);
      assert.equal(await checks.claim(a.device, []), null);
      const loginA = await checks.claim(a.device, ['https://community.nginx.org']);
      assert.equal(loginA.kind, 'LOGIN_CHECK');
      assert.equal(loginA.post, undefined);
      assert.equal(await checks.claim(a.device), null);
      await assert.rejects(checks.authStep(b.device, loginA.jobId, { step: 'password', pageUrl: inputUrl() }));
      await assert.rejects(checks.authStep(a.device, loginA.jobId, { step: 'password', pageUrl: 'https://evil.test/' }));
      await checks.authStep(a.device, loginA.jobId, { step: 'password', pageUrl: inputUrl() });
      await assert.rejects(checks.authStep(a.device, loginA.jobId, { step: 'password', pageUrl: inputUrl() }));
      await checks.result(a.device, loginA.jobId, { outcome: 'AUTHENTICATED', detectedUsername: 'alice' });
      assert.equal((await tx.platformAccount.findUniqueOrThrow({where:{id:a.account.id}})).status, 'CONNECTED');
      assert.equal(await tx.publishJob.count({ where: { target: { campaign: { ownerId: owner.id } } } }), 2);
      const currentAccount = await tx.platformAccount.findUniqueOrThrow({ where: { id: a.account.id } });
      const cookieOnly = { ...currentAccount.settings, extensionSession: { ...currentAccount.settings.extensionSession, autoLogin: false } };
      await tx.platformAccount.update({ where: { id: a.account.id }, data: { settings: cookieOnly } });
      assert.equal((await checks.queue(owner.id, [a.account.id])).queued, 1);
      const sessionCheck = await checks.claim(a.device);
      assert.equal(sessionCheck.auth.autoLogin, false);
      await assert.rejects(checks.authStep(a.device, sessionCheck.jobId, { step: 'password', pageUrl: inputUrl() }));
      await checks.result(a.device, sessionCheck.jobId, { outcome: 'AUTHENTICATED', detectedUsername: 'alice' });
      await tx.platformAccount.update({ where: { id: a.account.id }, data: { settings: { ...cookieOnly, extensionImport: { selected: false } } } });
      assert.equal((await checks.queue(owner.id, [a.account.id])).queued, 0);
      assert.equal((await checks.list(owner.id)).some(row => row.id === a.account.id), false);
      const parallel = [];
      for (const [index, provider] of ['google', 'google', 'password', 'password'].entries()) {
        const origin = `https://parallel-${index}.example.test`;
        parallel.push(await tx.platformAccount.create({ data: { ownerId: owner.id, platformId: platform.id, name: `parallel-${index}`,
          settings: { extensionLoginTarget: { url: origin }, extensionSession: { deviceId: a.device.id, provider, origin, autoLogin: true, autoTotp: false, expectedUsername: 'fixture', loginUsername: 'fixture@example.test', loginUrl: origin } } } }));
      }
      await checks.queue(owner.id, parallel.map(account => account.id));
      const first = await checks.claim(a.device);
      const second = await checks.claim(a.device);
      const third = await checks.claim(a.device);
      assert.equal([first, second, third].filter(task => task.auth.provider === 'google').length, 1);
      assert.equal(new Set([first, second, third].map(task => task.targetOrigin)).size, 3);
      assert.equal(await checks.claim(a.device), null);
      const google = [first, second, third].find(task => task.auth.provider === 'google');
      await checks.result(a.device, google.jobId, { outcome: 'AUTHENTICATED', detectedUsername: 'fixture' });
      assert.equal((await tx.platformAccount.findUniqueOrThrow({ where: { id: google.account.id } })).status, 'RECONNECT_REQUIRED');
      assert.equal((await checks.claim(a.device)).auth.provider, 'google');
      throw rollback;
    }, { timeout: 20_000 });
  } catch (error) { if (error !== rollback) throw error; }
  assert.equal(await db.user.count({ where: { id: fixtureOwner } }), 0);
  console.log('PASS: routing, isolated login-only queue, encrypted credentials, one-attempt auth, no publishing from login checks; all fixtures rolled back');
})().catch(error => { console.error(error.message); process.exitCode = 1; }).finally(() => db.$disconnect());
function inputUrl() { return 'https://community.nginx.org/login'; }
