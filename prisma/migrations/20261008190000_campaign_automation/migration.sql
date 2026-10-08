-- Add durable idempotency and resumable failure state for one-click campaign automation.
ALTER TABLE "campaigns"
ADD COLUMN "automationKey" TEXT,
ADD COLUMN "automationRequestHash" TEXT,
ADD COLUMN "automationErrorCode" TEXT;

CREATE UNIQUE INDEX "campaigns_ownerId_automationKey_key"
ON "campaigns"("ownerId", "automationKey");
