ALTER TABLE "platforms"
ADD COLUMN "connectorKey" TEXT NOT NULL DEFAULT 'manual',
ADD COLUMN "groupKey" TEXT NOT NULL DEFAULT 'COMMUNITY',
ADD COLUMN "defaultSettings" JSONB NOT NULL DEFAULT '{}';

UPDATE "platforms"
SET "connectorKey" = CASE "slug"
  WHEN 'instagram' THEN 'instagram'
  WHEN 'threads' THEN 'threads'
  WHEN 'x' THEN 'x'
  WHEN 'linkedin' THEN 'linkedin'
  WHEN 'wordpress' THEN 'wordpress'
  WHEN 'blogger' THEN 'blogger'
  WHEN 'devto' THEN 'devto'
  WHEN 'discourse' THEN 'discourse'
  WHEN 'discord' THEN 'discord'
  WHEN 'bluesky' THEN 'bluesky'
  WHEN 'mastodon' THEN 'mastodon'
  ELSE 'manual'
END,
"groupKey" = CASE
  WHEN "slug" IN ('wordpress', 'blogger', 'devto') THEN 'BLOGGING'
  WHEN "slug" IN ('discourse', 'reddit') THEN 'FORUM'
  WHEN "slug" = 'discord' THEN 'COMMUNITY'
  WHEN "slug" = 'tiktok' THEN 'MEDIA'
  ELSE 'SOCIAL'
END;

CREATE INDEX "platforms_groupKey_enabled_idx" ON "platforms"("groupKey", "enabled");
CREATE INDEX "platforms_connectorKey_idx" ON "platforms"("connectorKey");
