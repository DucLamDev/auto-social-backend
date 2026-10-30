// Run from the backend root after building. Dry-run unless --apply is supplied.
// PowerShell + Docker: Get-Content scripts/sync-extension-flows.cjs -Raw | docker compose exec -T api node - --apply
const path = require('node:path');
const { PrismaClient } = require('@prisma/client');
const { EXTENSION_FLOWS, extensionFlowDefaults } = require(path.join(process.cwd(), 'dist/connectors/extension/extension-flows'));

const db = new PrismaClient();
async function main() {
  const apply = process.argv.includes('--apply');
  const platforms = await db.platform.findMany({
    where: { slug: { in: EXTENSION_FLOWS.map(flow => flow.id) } },
    select: { id: true, slug: true, defaultSettings: true, updatedAt: true },
  });
  const missing = EXTENSION_FLOWS.filter(flow => !platforms.some(platform => platform.slug === flow.id));
  if (missing.length) throw new Error(`Missing platforms: ${missing.map(flow => flow.id).join(', ')}`);
  const changes = platforms.flatMap(platform => {
    const defaults = extensionFlowDefaults(platform.slug);
    const current = platform.defaultSettings && typeof platform.defaultSettings === 'object' && !Array.isArray(platform.defaultSettings) ? platform.defaultSettings : {};
    return Object.entries(defaults).every(([key, value]) => current[key] === value) ? [] : [{ ...platform, merged: { ...current, ...defaults } }];
  });
  if (apply && changes.length) await db.$transaction(async tx => {
    for (const platform of changes) {
      const result = await tx.platform.updateMany({
        where: { id: platform.id, updatedAt: platform.updatedAt },
        data: { defaultSettings: platform.merged },
      });
      if (result.count !== 1) throw new Error(`Platform changed during sync: ${platform.slug}; rerun`);
    }
  });
  console.log(JSON.stringify({ apply, profiles: platforms.length, changed: changes.map(platform => platform.slug) }));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; }).finally(() => db.$disconnect());
