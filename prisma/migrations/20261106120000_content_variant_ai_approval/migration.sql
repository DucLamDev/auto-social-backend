-- Stores the final AI approver's verdict on one variant (status, the hash of the
-- text it read, reasons). Nullable: variants approved before the approver
-- existed keep publishing as before.
ALTER TABLE "content_variants" ADD COLUMN "aiApproval" JSONB;
