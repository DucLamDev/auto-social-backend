-- Tracks the operator's "rewrite with AI" request on one draft (it runs in the
-- background for a minute or two). Nullable: existing drafts are unaffected.
ALTER TABLE "content_variants" ADD COLUMN "aiRevision" JSONB;
