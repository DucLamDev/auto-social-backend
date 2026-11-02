// Run from the backend root after building. Dry-run unless --apply is supplied.
// Activates the built-in "default" prompt version from dist/prompts/default-prompts for every catalog platform,
// keeping older versions (inactive) for rollback. --rollback <version> re-activates an older stored version.
// PowerShell + Docker: Get-Content scripts/sync-ai-prompts.cjs -Raw | docker compose exec -T api node - --apply
const path = require('node:path');
const { PrismaClient } = require('@prisma/client');
const { PLATFORM_CATALOG } = require(path.join(process.cwd(), 'dist/platforms/platform-catalog'));
const { DEFAULT_PROMPT_NAME, DEFAULT_PROMPT_VERSION, defaultPromptFor } = require(path.join(process.cwd(), 'dist/prompts/default-prompts'));

const db = new PrismaClient();

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

async function main() {
  const apply = process.argv.includes('--apply');
  const rollback = argumentValue('--rollback');
  const targetVersion = rollback === undefined ? DEFAULT_PROMPT_VERSION : Number(rollback);
  if (!Number.isSafeInteger(targetVersion) || targetVersion < 1) throw new Error('--rollback needs a stored prompt version number');
  const platforms = await db.platform.findMany({
    where: { slug: { in: PLATFORM_CATALOG.map(entry => entry.slug) } },
    select: { id: true, slug: true, prompts: { where: { name: DEFAULT_PROMPT_NAME } } },
  });
  const changes = [];
  for (const platform of platforms) {
    const entry = PLATFORM_CATALOG.find(item => item.slug === platform.slug);
    const stored = platform.prompts.find(prompt => prompt.version === targetVersion);
    const active = platform.prompts.filter(prompt => prompt.active).map(prompt => prompt.version);
    const wanted = rollback === undefined ? defaultPromptFor(entry) : null;
    if (rollback !== undefined && !stored) throw new Error(`${platform.slug} has no stored prompt version ${targetVersion}`);
    // Versions created on the web (PromptsController) share the numbering; never overwrite one of them.
    if (wanted && stored && stored.schema?.version !== targetVersion) {
      throw new Error(`${platform.slug}: prompt version ${targetVersion} was created on the web; resolve it manually before syncing`);
    }
    const contentChanged = wanted && (!stored || stored.systemPrompt !== wanted.systemPrompt || stored.userTemplate !== wanted.userTemplate);
    if (!contentChanged && active.length === 1 && active[0] === targetVersion) continue;
    changes.push({ platform, wanted, active });
  }
  if (apply && changes.length) await db.$transaction(async tx => {
    for (const { platform, wanted } of changes) {
      await tx.promptTemplate.updateMany({
        where: { platformId: platform.id, name: DEFAULT_PROMPT_NAME, active: true, version: { not: targetVersion } },
        data: { active: false },
      });
      if (wanted) {
        await tx.promptTemplate.upsert({
          where: { platformId_name_version: { platformId: platform.id, name: DEFAULT_PROMPT_NAME, version: targetVersion } },
          create: { platformId: platform.id, name: DEFAULT_PROMPT_NAME, version: targetVersion, active: true, ...wanted },
          update: { active: true, ...wanted },
        });
      } else {
        await tx.promptTemplate.update({
          where: { platformId_name_version: { platformId: platform.id, name: DEFAULT_PROMPT_NAME, version: targetVersion } },
          data: { active: true },
        });
      }
    }
  });
  console.log(JSON.stringify({
    apply,
    version: targetVersion,
    platforms: platforms.length,
    changed: changes.map(({ platform, active }) => ({ slug: platform.slug, activeBefore: active })),
  }));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; }).finally(() => db.$disconnect());
