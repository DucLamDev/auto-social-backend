-- Why the last AI run of a campaign failed, shown on the review screen: the
-- error code and message, the platform being written when it failed and the AI
-- provider. Nullable: existing campaigns are unaffected.
ALTER TABLE "campaigns" ADD COLUMN "automationErrorDetail" JSONB;
