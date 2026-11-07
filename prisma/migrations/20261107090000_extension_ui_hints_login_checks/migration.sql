-- AI sign-in hints for "Test" login checks: a hint belongs to a publish job or to a login check.
ALTER TABLE "extension_ui_hints" ADD COLUMN "loginCheckId" UUID,
ALTER COLUMN "publishJobId" DROP NOT NULL;

CREATE INDEX "extension_ui_hints_loginCheckId_createdAt_idx" ON "extension_ui_hints"("loginCheckId", "createdAt");

ALTER TABLE "extension_ui_hints" ADD CONSTRAINT "extension_ui_hints_loginCheckId_fkey" FOREIGN KEY ("loginCheckId") REFERENCES "extension_login_checks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Exactly one owner per hint row (Prisma cannot express this check).
ALTER TABLE "extension_ui_hints" ADD CONSTRAINT "extension_ui_hints_one_owner_check" CHECK (("publishJobId" IS NULL) <> ("loginCheckId" IS NULL));
