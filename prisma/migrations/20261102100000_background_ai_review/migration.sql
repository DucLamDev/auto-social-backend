ALTER TABLE "campaigns"
  ADD COLUMN "automationState" TEXT,
  ADD COLUMN "automationRequest" JSONB,
  ADD COLUMN "automationVariantIds" UUID[] NOT NULL DEFAULT ARRAY[]::UUID[];

CREATE INDEX "campaigns_automationState_updatedAt_idx" ON "campaigns"("automationState", "updatedAt");
