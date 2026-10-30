// Run against the built app. All fixture writes stay inside a rolled-back transaction.
// Example: Get-Content -Raw scripts/published-posts-db-smoke.cjs | docker compose exec -T api node -
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const path = require('node:path');
const { PrismaClient } = require('@prisma/client');
const { PublishedPostsController } = require(path.resolve('dist/publishing/published-posts.controller'));
const { ListPublishedPostsQueryDto } = require(path.resolve('dist/publishing/dto/list-published-posts-query.dto'));
const prisma = new PrismaClient();
const rollback = new Error('ROLLBACK_HISTORY_FIXTURES');
const marker = `history-check-${randomUUID()}`;

(async () => {
  const baseline = await prisma.publishedPost.count();
  let checked = false;
  try {
    await prisma.$transaction(async (tx) => {
      const existing = await tx.campaignTarget.findFirstOrThrow({ include: { campaign: true } });
      const campaign = await tx.campaign.create({ data: { ownerId: existing.campaign.ownerId, contentId: existing.campaign.contentId, name: marker } });
      const target = await tx.campaignTarget.create({ data: { campaignId: campaign.id, platformAccountId: existing.platformAccountId, contentVariantId: existing.contentVariantId } });
      for (const [index, [jobStatus, postStatus, url]] of [
        ['PUBLISHED', 'PUBLISHED', 'https://forum.example.com/t/history/123'],
        ['PUBLISHED', 'PUBLISHED', null],
        ['NEEDS_ACTION', 'PUBLISHED', 'https://forum.example.com/t/pending/124'],
        ['PUBLISHED', 'DELETED', 'https://forum.example.com/t/deleted/125'],
      ].entries()) {
        await tx.publishJob.create({ data: {
          campaignTargetId: target.id, platformAccountId: target.platformAccountId,
          idempotencyKey: `${marker}-${index}`, status: jobStatus, scheduledAt: new Date(),
          publishedPost: { create: { platformAccountId: target.platformAccountId, externalPostId: `${marker}-${index}`, status: postStatus, url } },
        } });
      }
      const controller = new PublishedPostsController({ publishedPost: tx.publishedPost, $transaction: (ops) => Promise.all(ops) });
      const user = { id: campaign.ownerId };
      const query = (extra = {}) => Object.assign(new ListPublishedPostsQueryDto(), { campaignId: campaign.id, limit: 1, ...extra });
      const first = await controller.list(user, query());
      const second = await controller.list(user, query({ page: 2 }));
      assert.equal(first.pagination.total, 2, 'Only confirmed, non-deleted posts should appear');
      assert.equal(first.pagination.totalPages, 2);
      assert.notEqual(first.items[0].id, second.items[0].id);
      assert.deepEqual([first.items[0].url, second.items[0].url].sort(), ['https://forum.example.com/t/history/123', null].sort());
      assert.equal((await controller.list({ id: randomUUID() }, query())).pagination.total, 0, 'Other owners must not see these posts');
      assert.equal((await controller.list(user, query({ search: marker, accountId: target.platformAccountId }))).pagination.total, 2);
      assert.equal((await controller.list(user, query({ search: 'not-present-in-history' }))).pagination.total, 0);
      checked = true;
      throw rollback;
    }, { timeout: 20_000 });
  } catch (error) { if (error !== rollback) throw error; }
  assert.equal(checked, true);
  assert.equal(await prisma.campaign.count({ where: { name: marker } }), 0, 'Fixtures must roll back');
  console.log(JSON.stringify({ passed: true, checks: ['owner isolation', 'published only', 'pagination', 'search and account filter', 'exact and missing links', 'fixture rollback'], publishedCountBefore: baseline, publishedCountAfter: await prisma.publishedPost.count() }));
})().catch((error) => { console.error(error instanceof assert.AssertionError ? error.message : 'Published history DB smoke failed'); process.exitCode = 1; }).finally(() => prisma.$disconnect());
