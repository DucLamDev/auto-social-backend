import {
  PlatformAvailability,
  PlatformMode,
  PrismaClient,
  RoleName,
} from '@prisma/client';
import { hash } from 'bcryptjs';

const prisma = new PrismaClient();

const platforms = [
  { slug: 'instagram', name: 'Instagram', mode: PlatformMode.OFFICIAL_API, availability: PlatformAvailability.CREDENTIAL_REQUIRED, docsUrl: 'https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/content-publishing/', capability: { text: false, image: true, video: false, article: false, delete: false, schedule: false, analytics: false, maxImages: 1 } },
  { slug: 'threads', name: 'Threads', mode: PlatformMode.OFFICIAL_API, availability: PlatformAvailability.CREDENTIAL_REQUIRED, docsUrl: 'https://developers.facebook.com/docs/threads/posts/', capability: { text: true, image: true, video: false, article: false, delete: false, schedule: false, analytics: false, maxText: 500, maxImages: 1 } },
  { slug: 'x', name: 'X', mode: PlatformMode.OFFICIAL_API, availability: PlatformAvailability.CREDENTIAL_REQUIRED, docsUrl: 'https://docs.x.com/x-api/posts/create-a-post', capability: { text: true, image: false, video: false, article: false, delete: true, schedule: false, analytics: false, maxText: 280 } },
  { slug: 'linkedin', name: 'LinkedIn', mode: PlatformMode.OFFICIAL_API, availability: PlatformAvailability.CREDENTIAL_REQUIRED, docsUrl: 'https://learn.microsoft.com/linkedin/marketing/community-management/shares/posts-api', capability: { text: true, image: false, video: false, article: false, delete: false, schedule: false, analytics: false } },
  { slug: 'tiktok', name: 'TikTok', mode: PlatformMode.MANUAL, availability: PlatformAvailability.API_REVIEW_REQUIRED, docsUrl: 'https://developers.tiktok.com/products/content-posting-api', capability: { text: true, image: false, video: false, article: false, delete: false, schedule: false, analytics: false } },
  { slug: 'wordpress', name: 'WordPress', mode: PlatformMode.OFFICIAL_API, availability: PlatformAvailability.CREDENTIAL_REQUIRED, docsUrl: 'https://developer.wordpress.org/rest-api/reference/posts/', capability: { text: true, image: false, video: false, article: true, delete: true, schedule: false, analytics: false } },
  { slug: 'blogger', name: 'Blogger', mode: PlatformMode.OFFICIAL_API, availability: PlatformAvailability.CREDENTIAL_REQUIRED, docsUrl: 'https://developers.google.com/blogger/docs/3.0/reference/posts/insert', capability: { text: true, image: false, video: false, article: true, delete: true, schedule: false, analytics: false } },
  { slug: 'devto', name: 'dev.to', mode: PlatformMode.OFFICIAL_API, availability: PlatformAvailability.CREDENTIAL_REQUIRED, docsUrl: 'https://developers.forem.com/api', capability: { text: true, image: false, video: false, article: true, delete: false, schedule: false, analytics: false } },
  { slug: 'discord', name: 'Discord', mode: PlatformMode.OFFICIAL_API, availability: PlatformAvailability.CREDENTIAL_REQUIRED, docsUrl: 'https://discord.com/developers/docs/resources/webhook#execute-webhook', capability: { text: true, image: false, video: false, article: false, delete: true, schedule: false, analytics: false, maxText: 2000 } },
  { slug: 'reddit', name: 'Reddit', mode: PlatformMode.MANUAL, availability: PlatformAvailability.MANUAL_ONLY, docsUrl: 'https://developers.reddit.com/docs/capabilities/server/userActions', capability: { text: true, image: false, video: false, article: false, delete: false, schedule: false, analytics: false } },
  { slug: 'bluesky', name: 'Bluesky', mode: PlatformMode.OFFICIAL_API, availability: PlatformAvailability.CREDENTIAL_REQUIRED, docsUrl: 'https://docs.bsky.app/docs/tutorials/creating-a-post', capability: { text: true, image: false, video: false, article: false, delete: false, schedule: false, analytics: false, maxText: 300 } },
  { slug: 'mastodon', name: 'Mastodon', mode: PlatformMode.OFFICIAL_API, availability: PlatformAvailability.CREDENTIAL_REQUIRED, docsUrl: 'https://docs.joinmastodon.org/methods/statuses/', capability: { text: true, image: false, video: false, article: false, delete: true, schedule: false, analytics: false } },
] as const;

const promptRules: Record<string, string> = {
  instagram: 'Write a strong hook, readable caption, relevant hashtags, and concise CTA.',
  threads: 'Use a conversational voice, natural short paragraphs, and invite discussion.',
  x: 'Be concise and stay within the configured character limit.',
  linkedin: 'Use a professional voice: insight, problem, solution, then a clear CTA.',
  tiktok: 'Create a natural caption and relevant hashtags without engagement bait.',
  wordpress: 'Write a structured, SEO-friendly long-form article using semantic headings.',
  blogger: 'Write a useful long-form article with a clear title and readable HTML.',
  devto: 'Write a technical Markdown article with examples and a non-promotional tone.',
  discord: 'Write a concise community update without mass mentions.',
  reddit: 'Prioritize discussion and transparency; avoid promotional or spam-like wording.',
  bluesky: 'Be concise and conversational within the platform character limit.',
  mastodon: 'Use accessible language and a community-oriented, non-promotional tone.',
};

export async function seed(): Promise<void> {
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

  for (const item of platforms) {
    const platform = await prisma.platform.upsert({
      where: { slug: item.slug },
      create: {
        slug: item.slug,
        name: item.name,
        mode: item.mode,
        availability: item.availability,
        docsUrl: item.docsUrl,
        enabled: true,
      },
      update: {
        name: item.name,
        mode: item.mode,
        availability: item.availability,
        docsUrl: item.docsUrl,
      },
    });
    await prisma.platformCapability.upsert({
      where: { platformId: platform.id },
      create: { platformId: platform.id, ...item.capability },
      update: item.capability,
    });
    await prisma.promptTemplate.upsert({
      where: { platformId_name_version: { platformId: platform.id, name: 'default', version: 1 } },
      create: {
        platformId: platform.id,
        name: 'default',
        version: 1,
        active: true,
        systemPrompt: `You are an editorial assistant. Generate only truthful content grounded in the supplied source. Never publish or claim actions were performed. ${promptRules[item.slug]}`,
        userTemplate: 'Platform: {{platform}}\nTitle: {{title}}\nSummary: {{summary}}\nCanonical URL: {{canonicalUrl}}\nSource:\n{{body}}',
        schema: { name: 'content_variant', version: 1 },
      },
      update: {},
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
