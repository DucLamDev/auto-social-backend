// Receives credentials on stdin, never in argv. Output is consumed privately by
// import-social-accounts.cjs; pairing tokens must never be printed to a terminal.
const { PrismaClient } = require('@prisma/client');
const { ConfigService } = require('@nestjs/config');
const { CredentialEncryptionService } = require('./dist/credentials/credential-encryption.service');
const { CredentialsService } = require('./dist/credentials/credentials.service');
const { ExtensionAgentService } = require('./dist/extension-agent/extension-agent.service');
const { ExtensionLoginCheckService } = require('./dist/extension-agent/extension-login-check.service');
const { EXTENSION_FLOWS } = require('./dist/connectors/extension/extension-flows');
const { generateTotp } = require('./dist/auth/totp-provider');
const { createHash } = require('node:crypto');
const db = new PrismaClient();
const digest = value => createHash('sha256').update(value).digest('hex').slice(0, 24);
const obj = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const loginUrls = {
  x: 'https://x.com/i/flow/login', linkedin: 'https://www.linkedin.com/login', tiktok: 'https://www.tiktok.com/login',
  wordpress: 'https://wordpress.com/log-in', medium: 'https://medium.com/m/signin', blogger: 'https://www.blogger.com/about/',
  substack: 'https://substack.com/sign-in', tumblr: 'https://www.tumblr.com/login', devto: 'https://dev.to/enter',
  quora: 'https://www.quora.com/', discord: 'https://discord.com/login', reddit: 'https://www.reddit.com/login/',
  slideshare: 'https://www.slideshare.net/login', bluesky: 'https://bsky.app/', 'aws-community': 'https://builder.aws.com/',
  mastodon: 'https://mastodon.social/auth/sign_in', tinhte: 'https://tinhte.vn/login/',
  'vivaldi-social': 'https://social.vivaldi.net/auth/sign_in', 'pixelfed-social': 'https://pixelfed.social/login',
  'lemmy-world': 'https://lemmy.world/login', discuit: 'https://discuit.org/', minds: 'https://www.minds.com/login',
  mewe: 'https://mewe.com/login', dzone: 'https://dzone.com/', 'daily-dev': 'https://app.daily.dev/',
  differ: 'https://differ.blog/', 'product-hunt': 'https://www.producthunt.com/login', dailymotion: 'https://www.dailymotion.com/',
  'in-plain-english': 'https://plainenglish.io/', hub: 'https://hubpages.com/',
  'stack-overflow': 'https://stackoverflow.com/users/login', 'server-fault': 'https://serverfault.com/users/login',
  'unraid-forums': 'https://forums.unraid.net/login/', flipboard: 'https://flipboard.com/', 'scoop-it': 'https://www.scoop.it/login',
  'hugging-face': 'https://huggingface.co/login', 'linux-foundation-forum': 'https://forum.linuxfoundation.org/',
  'warrior-forum': 'https://www.warriorforum.com/', disqus: 'https://disqus.com/profile/login/',
  eventbrite: 'https://www.eventbrite.com/signin/', gumroad: 'https://gumroad.com/login',
  'aapanel-forum': 'https://www.aapanel.com/forum/', 'cpanel-community': 'https://support.cpanel.net/hc/en-us',
  'ubiquiti-community': 'https://community.ui.com/', 'unix-linux-stackexchange': 'https://unix.stackexchange.com/users/login',
  'redis-community-forum': 'https://forum.redis.io/login', kubeby: 'https://kubeby.com/',
};
for (const flow of EXTENSION_FLOWS) if (!loginUrls[flow.id]) loginUrls[flow.id] = flow.forumUrl + '/login';
const aliases = { hubpages: 'hub', scoopit: 'scoop-it', 'linux-foundation': 'linux-foundation-forum' };

async function main(input) {
  const owners = await db.user.findMany({ where: { enabled: true, roles: { some: { role: { name: 'ADMIN' } } } }, select: { id: true } });
  if (owners.length !== 1) throw new Error('Select the import owner explicitly');
  const ownerId = owners[0].id;
  const googleDevice = await db.extensionDevice.findFirst({ where: { id: input.googleDeviceId, ownerId, revokedAt: null } });
  if (!googleDevice) throw new Error('The selected Chrome profile is unavailable');
  const config = new ConfigService();
  const encryption = new CredentialEncryptionService(config);
  const credentials = new CredentialsService(db, encryption, config);
  const agent = new ExtensionAgentService(db, {}, {});
  const platforms = new Map((await db.platform.findMany()).map(p => [p.slug, p]));
  const grouped = new Map();
  for (const raw of input.rows) {
    const row = { ...raw, platform: aliases[raw.platform] ?? raw.platform };
    if (row.provider === 'google' && input.google) Object.assign(row, input.google, { profileUrl: '', googleOverride: true });
    const key = [row.platform, row.provider, row.loginUsername.trim().toLowerCase()].join('|');
    const group = grouped.get(key) ?? { ...row, sources: [], passwords: new Set(), seeds: new Set(), profiles: new Set() };
    group.sources.push(row.source);
    if (row.password) group.passwords.add(row.password);
    if (row.totpSecret) group.seeds.add(row.totpSecret.replace(/\s/g, '').toUpperCase());
    if (row.profileUrl) group.profiles.add(row.profileUrl);
    grouped.set(key, group);
  }
  const devices = new Map();
  for (const known of input.privateDevices ?? []) {
    if (await db.extensionDevice.count({ where: { id: known.id, ownerId, revokedAt: null } })) devices.set(known.key, known);
  }
  const report = [], privateDevices = [], accountIds = [];
  if (input.replaceSelection) {
    // Keep old credentials/accounts, but remove their test bindings so the web
    // bulk button and heartbeat cannot pick records outside the new selection.
    for (const old of await db.platformAccount.findMany({ where: { ownerId } })) {
      const settings = obj(old.settings);
      if (!settings.extensionImport) continue;
      const { extensionSession: unused, ...rest } = settings; void unused;
      await db.platformAccount.update({ where: { id: old.id }, data: { settings: { ...rest, extensionImport: { ...obj(settings.extensionImport), selected: false } } } });
    }
  }
  for (const [key, row] of grouped) {
    const platform = platforms.get(row.platform), url = loginUrls[row.platform];
    const issues = [];
    if (!platform) { report.push({ platform: row.label, sources: row.sources, issues: ['PLATFORM_NOT_IN_CATALOG'] }); continue; }
    if (!url) issues.push('LOGIN_URL_NOT_CONFIGURED');
    if (!row.loginUsername) issues.push('MISSING_USERNAME');
    if (row.provider === 'google' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(row.loginUsername)) issues.push('MISSING_GOOGLE_EMAIL');
    if (!row.passwords.size) issues.push('MISSING_PASSWORD');
    if (row.passwords.size > 1) issues.push('CONFLICTING_PASSWORDS');
    if (row.seeds.size > 1) issues.push('CONFLICTING_TOTP_KEYS');
    const seed = [...row.seeds][0];
    if (seed) try { generateTotp(seed); } catch { issues.push('INVALID_TOTP_KEY'); }
    const importKey = digest(key);
    const existing = await db.platformAccount.findFirst({ where: { ownerId, settings: { path: ['extensionImport', 'key'], equals: importKey } } });
    if (existing && (await db.extensionLoginCheck.count({ where: { platformAccountId: existing.id, status: 'RUNNING' } })
      || await db.publishJob.count({ where: { platformAccountId: existing.id, lockedAt: { not: null }, status: { in: ['PROCESSING', 'NEEDS_ACTION'] } } }))) {
      report.push({ id: existing.id, platform: platform.name, sources: row.sources, configured: false, issues: ['ACCOUNT_BUSY'] }); continue;
    }
    const settings = obj(existing?.settings);
    const importInfo = { key: importKey, sources: row.sources, issues, googleOverride: Boolean(row.googleOverride), selected: true, brand: input.brand ?? '' };
    const flow = EXTENSION_FLOWS.find(f => f.id === row.platform);
    const engine = flow?.engine ?? (row.platform === 'redis-community-forum' ? 'discourse' : 'generic');
    const target = url ? { url: engine === 'discourse' ? url.replace(/\/login\/?$/, '') : new URL(url).origin, engine } : undefined;
    const name = `${platform.name} · ${row.expectedUsername || (row.provider === 'google' ? 'Google' : row.loginUsername || row.sources[0])}`;
    const account = existing ?? await db.platformAccount.create({ data: { ownerId, platformId: platform.id, name,
      enabled: false, status: 'RECONNECT_REQUIRED', settings: { extensionImport: importInfo, ...(target ? { extensionLoginTarget: target } : {}) } } });
    let device;
    const sessionOnly = input.currentChrome && Boolean(url && row.expectedUsername) && issues.length > 0;
    if (!issues.length || sessionOnly) {
      if (input.currentChrome || row.provider === 'google') device = googleDevice;
      else {
        const deviceKey = digest(`password|${row.loginUsername.toLowerCase()}`);
        device = devices.get(deviceKey);
        if (!device) {
          const created = await agent.createDevice(ownerId, `Test social · ${devices.size + 1}`);
          device = { ...created, key: deviceKey }; devices.set(deviceKey, device);
        }
      }
      const previousSession = obj(settings.extensionSession);
      const profileUrl = input.currentChrome ? row.profileUrl : row.provider === 'google' ? '' : [...row.profiles].find(value => /\/(?:@|u\/|profile\/|members\/|users\/)[^/?]+/i.test(value)) ?? '';
      let expectedUsername = row.expectedUsername || '';
      if (!expectedUsername && profileUrl) expectedUsername = decodeURIComponent(/\/(?:@|u\/|profile\/|members\/)([^/?]+)/i.exec(profileUrl)?.[1] ?? '').replace(/\.\d+$/, '');
      const allowedOrigins = row.platform === 'vivaldi-social' ? ['https://login.vivaldi.net']
        : row.platform === 'quora' && new URL(profileUrl || url).origin === 'https://fr.quora.com' ? ['https://fr.quora.com'] : [];
      const session = { deviceId: device.id, origin: new URL(url).origin, provider: row.provider, autoLogin: !sessionOnly, autoTotp: !sessionOnly && Boolean(seed),
        loginUrl: url, loginUsername: row.loginUsername, expectedUsername: expectedUsername || previousSession.expectedUsername || '',
        discoverIdentity: !expectedUsername && !previousSession.expectedUsername, profileUrl, identitySelector: '', allowedOrigins };
      const credential = await db.platformCredential.findUnique({ where: { platformAccountId: account.id } });
      const stored = credential?.status === 'ACTIVE' ? encryption.decrypt(credential.encryptedPayload) : {};
      if (!sessionOnly) await credentials.upsert(account.id, { ...stored, extensionLogin: { username: row.loginUsername, password: [...row.passwords][0], ...(seed ? { totpSecret: seed } : {}) } }, null);
      await db.platformAccount.update({ where: { id: account.id }, data: { name, settings: { ...settings, extensionImport: importInfo, extensionLoginTarget: target, extensionSession: session } } });
      accountIds.push(account.id);
    } else {
      const { extensionSession: unused, ...rest } = settings; void unused;
      await db.platformAccount.update({ where: { id: account.id }, data: { settings: { ...rest, extensionImport: importInfo, ...(target ? { extensionLoginTarget: target } : {}) } } });
    }
    report.push({ id: account.id, platform: platform.name, sources: row.sources, expectedUsername: row.expectedUsername, configured: Boolean(device), autoLogin: Boolean(device) && !sessionOnly, issues, deviceId: device?.id });
  }
  privateDevices.push(...devices.values());
  const batch = input.queue ? await new ExtensionLoginCheckService(db, credentials).queue(ownerId, accountIds) : null;
  return { report, batch, privateDevices, googleDeviceId: googleDevice.id };
}
let input = '';
process.stdin.setEncoding('utf8'); process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => { main(JSON.parse(input)).then(result => console.log(JSON.stringify(result))).catch(() => { console.error('Private import failed; credential data suppressed'); process.exitCode = 1; }).finally(() => db.$disconnect()); });
