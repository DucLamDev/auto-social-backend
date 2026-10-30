// Execute inside the built API container. All configuration writes roll back; no provider calls occur.
const assert = require('node:assert/strict');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { PrismaClient } = require('@prisma/client');
const { ConfigService } = require('@nestjs/config');
const { GeminiKeyPoolService, GEMINI_KEYS_SETTING } = require(path.resolve('dist/ai/gemini-key-pool.service'));
const { CredentialEncryptionService } = require(path.resolve('dist/credentials/credential-encryption.service'));
const { SettingsController } = require(path.resolve('dist/settings/settings.controller'));
const prisma = new PrismaClient();
const rollback = new Error('ROLLBACK_GEMINI_SMOKE');
(async () => {
  const before = await prisma.systemSetting.findUnique({ where: { key: GEMINI_KEYS_SETTING } });
  const config = new ConfigService(process.env);
  const encryption = new CredentialEncryptionService(config);
  const state = new Map();
  const redis = { getValue: async (key) => state.get(key) ?? null, setValue: async (key, value) => { state.set(key, value); }, setOnce: async (key, value) => { state.set(key, value); return true; } };
  let passed = false;
  try {
    await prisma.$transaction(async (tx) => {
      const pool = new GeminiKeyPoolService(tx, config, encryption, redis);
      const current = await pool.describe();
      const keyA = `fixture-gemini-${randomUUID()}`;
      const keyB = `fixture-gemini-${randomUUID()}`;
      const saved = await pool.update({ revision: current.revision, changes: [{ slot: 9, apiKey: keyA }, { slot: 10, apiKey: keyB }] });
      assert.equal(saved.slots.length, 10);
      assert.equal(saved.slots[8].configured, true);
      assert.equal(JSON.stringify(saved).includes(keyA), false);
      const stored = await tx.systemSetting.findUniqueOrThrow({ where: { key: GEMINI_KEYS_SETTING } });
      assert.equal(stored.secret, true);
      assert.equal(JSON.stringify(stored.value).includes(keyA), false);
      assert.equal(encryption.decrypt(stored.value.encrypted).keys[8], keyA);
      const exposed = await new SettingsController(tx, encryption).list();
      assert.deepEqual(exposed.find((row) => row.key === GEMINI_KEYS_SETTING).value, { configured: true });
      const secondProcess = new GeminiKeyPoolService(tx, config, encryption, redis);
      let count = 0;
      const result = await secondProcess.run(async (key) => { count++; if (key === keyB) return 'generated'; throw { status: 429 }; });
      assert.equal(result, 'generated');
      assert.ok(count >= 2 && count <= 10);
      let nextCalls = 0;
      await secondProcess.run(async (key) => { nextCalls++; assert.equal(key, keyB); return 'generated'; });
      assert.equal(nextCalls, 1);
      passed = true;
      throw rollback;
    }, { timeout: 20_000 });
  } catch (error) { if (error !== rollback) throw error; }
  assert.equal(passed, true);
  const after = await prisma.systemSetting.findUnique({ where: { key: GEMINI_KEYS_SETTING } });
  assert.deepEqual(after, before, 'Original runtime keys must remain unchanged');
  console.log(JSON.stringify({ passed: true, checks: ['encrypted persistence', 'masked settings responses', 'reload in another instance', 'quota failover', 'preferred key', 'transaction rollback'], providerRequests: 0 }));
})().catch(() => { console.error('Gemini DB smoke failed; secret details suppressed'); process.exitCode = 1; }).finally(() => prisma.$disconnect());
