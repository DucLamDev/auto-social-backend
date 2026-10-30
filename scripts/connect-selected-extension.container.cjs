// Operator tool: configure the existing selected accounts without creating posts.
// Credentials arrive on stdin; stdout contains only public configuration/status.
const { PrismaClient } = require('@prisma/client');
const { ConfigService } = require('@nestjs/config');
const { CredentialEncryptionService } = require('./dist/credentials/credential-encryption.service');
const { CredentialsService } = require('./dist/credentials/credentials.service');
const { ExtensionLoginCheckService } = require('./dist/extension-agent/extension-login-check.service');
const { EXTENSION_FLOWS, validateExtensionFlow } = require('./dist/connectors/extension/extension-flows');
const { parseExtensionDeliverySettings } = require('./dist/connectors/extension/extension-delivery');
const db = new PrismaClient();
const record = v => v && typeof v === 'object' && !Array.isArray(v) ? v : {};
async function main(input) {
  const accounts = await db.platformAccount.findMany({ where: { settings: { path: ['extensionImport', 'selected'], equals: true } },
    include: { platform: true, credential: true, extensionLoginChecks: { orderBy: { createdAt: 'desc' }, take: 1 } } });
  if (accounts.length !== 42 || new Set(accounts.map(a => a.ownerId)).size !== 1) throw Error('Selection changed');
  if (await db.publishJob.count({ where: { platformAccountId: { in: accounts.map(a => a.id) } } })) throw Error('This initial setup tool cannot change accounts with publishing history');
  const ownerId = accounts[0].ownerId;
  const device = await db.extensionDevice.findFirst({ where: { id: input.deviceId, ownerId, revokedAt: null } });
  if (!device || input.google?.loginUsername?.toLowerCase() !== input.googleEmail.toLowerCase() || !input.google.password) throw Error('Google identity or device mismatch');
  if (await db.extensionLoginCheck.count({ where: { platformAccountId: { in: accounts.map(a => a.id) }, status: 'RUNNING' } })) throw Error('Wait for active checks');
  const encryption = new CredentialEncryptionService(new ConfigService());
  const credentials = new CredentialsService(db, encryption, new ConfigService());
  const sources = new Set(input.emailOnlySources);
  const googleIds = [], report = [];
  await db.$transaction(async tx => {
    for (const a of accounts) {
      const settings = record(a.settings), imported = record(settings.extensionImport), session = record(settings.extensionSession);
      if (!/vpsttt/i.test(session.expectedUsername || '') || session.deviceId !== device.id) throw Error('Account outside selected Chrome scope');
      if (imported.sources.some(source => sources.has(source))) {
        const stored = a.credential?.status === 'ACTIVE' ? encryption.decrypt(a.credential.encryptedPayload) : {};
        await credentials.upsert(a.id, { ...stored, extensionLogin: { username: input.googleEmail, password: input.google.password,
          ...(input.google.totpSecret ? { totpSecret: input.google.totpSecret } : {}) } }, null, tx);
        settings.extensionSession = { ...session, provider: 'google', loginUsername: input.googleEmail, autoLogin: true,
          autoTotp: Boolean(input.google.totpSecret) && session.totpNeedsReview !== true };
        settings.extensionImport = { ...imported, emailOnlyGoogle: true, issues: (imported.issues || []).filter(issue => !['MISSING_PASSWORD', 'MISSING_GOOGLE_EMAIL'].includes(issue)) };
        googleIds.push(a.id);
      }
      const flow = EXTENSION_FLOWS.find(f => f.id === a.platform.slug);
      const redis = a.platform.slug === 'redis-community-forum';
      const target = settings.extensionTargetUrl || flow?.targetUrl || (redis ? 'https://forum.redis.io/new-topic' : '');
      if ((flow || redis) && target && a.platform.mode !== 'OFFICIAL_API') {
        const parsed = parseExtensionDeliverySettings({ ...settings, extensionEngine: settings.extensionEngine || flow?.engine || 'discourse',
          extensionTargetUrl: target, extensionAutoSubmit: true });
        validateExtensionFlow(a.platform.slug, parsed);
        if (new URL(parsed.targetUrl).origin !== session.origin) throw Error('Posting origin mismatch');
        Object.assign(settings, { delivery: 'extension', extensionEngine: parsed.engine, extensionTargetUrl: parsed.targetUrl,
          extensionAutoSubmit: true, extensionTags: parsed.tags, extensionCategory: parsed.category, extensionFlair: parsed.flair,
          ...(flow ? { extensionFlowId: flow.id, extensionFlowRevision: flow.revision } : {}), extensionSetup: { status: 'READY' } });
        if (a.platform.slug === 'nginx-community') Object.assign(settings, {
          extensionTargetUrl: 'https://community.nginx.org/new-topic?category=projects%2Fnginx&tags=web-server', extensionTags: ['web-server'], extensionCategory: 'projects/nginx',
        });
      } else settings.extensionSetup = { status: flow ? 'DESTINATION_REQUIRED' : 'FLOW_REQUIRED' };
      const verified = a.extensionLoginChecks[0]?.status === 'AUTHENTICATED';
      // Enable only a verified login with a configured posting flow. No jobs are
      // enqueued; moderation and existing campaign state are not touched.
      const ready = verified && settings.delivery === 'extension';
      await tx.platformAccount.update({ where: { id: a.id }, data: { settings, ...(ready ? { enabled: true, status: 'CONNECTED' } : {}) } });
      report.push({ id: a.id, name: a.name, login: verified ? 'AUTHENTICATED' : 'NEEDS_ACTION', setup: settings.extensionSetup.status,
        googleFallback: googleIds.includes(a.id), publishingEnabled: ready || a.enabled });
    }
  }, { timeout: 30000 });
  const batch = input.queue ? await new ExtensionLoginCheckService(db, credentials).queue(ownerId, googleIds) : null;
  return { accounts: report.length, boundToChrome: report.length, publishingConfigured: report.filter(r => r.setup === 'READY').length,
    destinationRequired: report.filter(r => r.setup === 'DESTINATION_REQUIRED').length,
    flowRequired: report.filter(r => r.setup === 'FLOW_REQUIRED').length, googleFallback: googleIds.length, batch, report };
}
let input = '';
process.stdin.setEncoding('utf8'); process.stdin.on('data', part => { input += part; });
process.stdin.on('end', () => main(JSON.parse(input)).then(r => console.log(JSON.stringify(r))).catch(() => {
  console.error('Configuration failed; private input and database error details suppressed'); process.exitCode = 1;
}).finally(() => db.$disconnect()));
