import {
  Prisma,
  PrismaClient,
  RoleName,
} from '@prisma/client';
import { hash } from 'bcryptjs';
import {
  assertPlatformCatalog,
  PLATFORM_CATALOG,
} from '../src/platforms/platform-catalog';

const prisma = new PrismaClient();

export async function seed(): Promise<void> {
  assertPlatformCatalog();

  for (const name of Object.values(RoleName)) {
    await prisma.role.upsert({ where: { name }, create: { name }, update: {} });
  }

  const email = (process.env.SEED_ADMIN_EMAIL ?? 'admin@example.com').toLowerCase();
  const configuredPassword = process.env.SEED_ADMIN_PASSWORD;
  if (process.env.NODE_ENV === 'production' && !configuredPassword) {
    throw new Error('SEED_ADMIN_PASSWORD is required when seeding production');
  }
  const password = configuredPassword ?? 'ChangeMe123!Change';
  if (password.length < 12) throw new Error('SEED_ADMIN_PASSWORD must contain at least 12 characters');
  if (process.env.NODE_ENV === 'production' && password === 'ChangeMe123!Change') {
    throw new Error('Refusing to seed production with the development admin password');
  }
  const adminRole = await prisma.role.findUniqueOrThrow({ where: { name: RoleName.ADMIN } });
  const admin = await prisma.user.upsert({
    where: { email },
    create: { email, displayName: 'Administrator', passwordHash: await hash(password, 12) },
    update: {},
  });
  await prisma.userRole.upsert({
    where: { userId_roleId: { userId: admin.id, roleId: adminRole.id } },
    create: { userId: admin.id, roleId: adminRole.id },
    update: {},
  });

  for (const item of PLATFORM_CATALOG) {
    const defaultSettings = item.defaultSettings as Prisma.InputJsonObject;
    const capability = {
      ...item.capability,
      metadata: item.capability.metadata as unknown as Prisma.InputJsonObject,
    };
    const platform = await prisma.platform.upsert({
      where: { slug: item.slug },
      create: {
        slug: item.slug,
        name: item.name,
        connectorKey: item.connectorKey,
        groupKey: item.groupKey,
        defaultSettings,
        mode: item.mode,
        availability: item.availability,
        docsUrl: item.docsUrl,
        enabled: item.enabled,
      },
      update: {
        name: item.name,
        connectorKey: item.connectorKey,
        groupKey: item.groupKey,
        defaultSettings,
        mode: item.mode,
        availability: item.availability,
        docsUrl: item.docsUrl,
        ...(item.enabled ? {} : { enabled: false }),
      },
    });
    await prisma.platformCapability.upsert({
      where: { platformId: platform.id },
      create: { platformId: platform.id, ...capability },
      update: capability,
    });
    await prisma.promptTemplate.updateMany({
      where: { platformId: platform.id, name: 'default', version: { not: 2 }, active: true },
      data: { active: false },
    });
    const systemPrompt = [
      'You are a multilingual editorial and SEO assistant.',
      'Generate only truthful content grounded in the supplied source.',
      'Adapt structure, length, tone, title, CTA, hashtags, and media guidance to the target platform.',
      'Never publish, claim an action was performed, invent facts, or expose secrets.',
      item.promptRule,
    ].join(' ');
    const userTemplate = 'Platform: {{platform}}\nTitle or brief: {{title}}\nSummary: {{summary}}\nCanonical URL: {{canonicalUrl}}\nSource content:\n{{body}}';
    await prisma.promptTemplate.upsert({
      where: { platformId_name_version: { platformId: platform.id, name: 'default', version: 2 } },
      create: {
        platformId: platform.id,
        name: 'default',
        version: 2,
        active: true,
        systemPrompt,
        userTemplate,
        schema: { name: 'content_variant', version: 2 },
      },
      update: {
        active: true,
        systemPrompt,
        userTemplate,
        schema: { name: 'content_variant', version: 2 },
      },
    });
  }
}

if (require.main === module) {
  seed()
    .then(() => console.log('Seed completed'))
    .catch((error: unknown) => {
      console.error(error);
      process.exitCode = 1;
    })
    .finally(async () => prisma.$disconnect());
}
