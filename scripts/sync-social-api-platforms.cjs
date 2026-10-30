// Reconcile only the existing API implementations requested alongside extension
// flows. Does not seed users, prompts, credentials, accounts or publish jobs.
// Dry-run by default; pass --apply after reviewing the diff summary.
const path = require('node:path');
const { isDeepStrictEqual } = require('node:util');
const { PrismaClient } = require('@prisma/client');
const { PLATFORM_CATALOG } = require(path.join(process.cwd(), 'dist/platforms/platform-catalog'));
const db = new PrismaClient();
const slugs = ['tumblr', 'bluesky', 'mastodon-social', 'vivaldi-social'];

async function main() {
  const apply = process.argv.includes('--apply');
  const changes = [];
  for (const slug of slugs) {
    const entry = PLATFORM_CATALOG.find(item => item.slug === slug);
    if (!entry || !['tumblr', 'bluesky', 'mastodon'].includes(entry.connectorKey)) throw new Error(`No API implementation for ${slug}`);
    const current = await db.platform.findUniqueOrThrow({ where: { slug }, include: { capability: true } });
    const defaults = current.defaultSettings && typeof current.defaultSettings === 'object' && !Array.isArray(current.defaultSettings) ? current.defaultSettings : {};
    const platform = { connectorKey: entry.connectorKey, mode: entry.mode, availability: entry.availability, docsUrl: entry.docsUrl,
      defaultSettings: { ...defaults, ...entry.defaultSettings } };
    const capability = { ...entry.capability, metadata: { ...(current.capability?.metadata ?? {}), ...entry.capability.metadata } };
    const fields = Object.entries(platform).filter(([key, value]) => !isDeepStrictEqual(current[key], value)).map(([key]) => key);
    const capabilityChanged = Object.entries(capability).some(([key, value]) => !isDeepStrictEqual(current.capability?.[key], value));
    if (fields.length || capabilityChanged) changes.push({ current, platform, capability, fields, capabilityChanged });
  }
  if (apply && changes.length) await db.$transaction(async tx => {
    for (const change of changes) {
      const updated = await tx.platform.updateMany({ where: { id: change.current.id, updatedAt: change.current.updatedAt }, data: change.platform });
      if (updated.count !== 1) throw new Error(`Concurrent platform update: ${change.current.slug}; rerun`);
      if (change.capabilityChanged) await tx.platformCapability.upsert({ where: { platformId: change.current.id },
        create: { platformId: change.current.id, ...change.capability }, update: change.capability });
    }
  });
  console.log(JSON.stringify({ apply, changes: changes.map(change => ({ slug: change.current.slug, fields: change.fields, capability: change.capabilityChanged })) }));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; }).finally(() => db.$disconnect());
