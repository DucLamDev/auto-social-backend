-- AI-assisted recovery when the extension cannot find a composer control.
CREATE TABLE "extension_ui_hints" (
    "id" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "publishJobId" UUID NOT NULL,
    "deviceId" UUID NOT NULL,
    "engine" TEXT NOT NULL,
    "origin" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "missing" TEXT[],
    "candidates" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'RUNNING',
    "provider" TEXT,
    "result" JSONB,
    "errorCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "extension_ui_hints_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "extension_selector_suggestions" (
    "id" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "engine" TEXT NOT NULL,
    "origin" TEXT NOT NULL,
    "field" TEXT NOT NULL,
    "selector" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "sampleUrl" TEXT NOT NULL,
    "elementSummary" JSONB NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "seenCount" INTEGER NOT NULL DEFAULT 1,
    "lastHintId" UUID,
    "reviewedById" UUID,
    "reviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "extension_selector_suggestions_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "extension_ui_hints_publishJobId_createdAt_idx" ON "extension_ui_hints"("publishJobId", "createdAt");
CREATE INDEX "extension_ui_hints_ownerId_createdAt_idx" ON "extension_ui_hints"("ownerId", "createdAt");
CREATE UNIQUE INDEX "extension_selector_suggestions_ownerId_engine_origin_field_selector_key" ON "extension_selector_suggestions"("ownerId", "engine", "origin", "field", "selector");
CREATE INDEX "extension_selector_suggestions_ownerId_status_updatedAt_idx" ON "extension_selector_suggestions"("ownerId", "status", "updatedAt");
CREATE INDEX "extension_selector_suggestions_ownerId_engine_origin_status_idx" ON "extension_selector_suggestions"("ownerId", "engine", "origin", "status");

ALTER TABLE "extension_ui_hints" ADD CONSTRAINT "extension_ui_hints_publishJobId_fkey" FOREIGN KEY ("publishJobId") REFERENCES "publish_jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "extension_ui_hints" ADD CONSTRAINT "extension_ui_hints_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "extension_devices"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "extension_selector_suggestions" ADD CONSTRAINT "extension_selector_suggestions_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
