-- Kết nối chat VPSTTT: sổ gửi (outbox) và liên kết bài ↔ yêu cầu duyệt bên chat.
CREATE TABLE "chat_outbox_events" (
    "id" UUID NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastError" TEXT,
    "lastAttemptAt" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "chat_outbox_events_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "chat_outbox_events_dedupeKey_key" ON "chat_outbox_events"("dedupeKey");
CREATE INDEX "chat_outbox_events_status_nextAttemptAt_idx" ON "chat_outbox_events"("status", "nextAttemptAt");
CREATE INDEX "chat_outbox_events_lastAttemptAt_idx" ON "chat_outbox_events"("lastAttemptAt");

CREATE TABLE "chat_approval_links" (
    "id" UUID NOT NULL,
    "campaignId" UUID NOT NULL,
    "variantId" UUID NOT NULL,
    "cycle" INTEGER NOT NULL,
    "externalKey" TEXT NOT NULL,
    "approvalId" TEXT,
    "contentHash" TEXT,
    "requestBody" JSONB,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "resultRecordedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "chat_approval_links_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "chat_approval_links_externalKey_key" ON "chat_approval_links"("externalKey");
CREATE UNIQUE INDEX "chat_approval_links_approvalId_key" ON "chat_approval_links"("approvalId");
CREATE UNIQUE INDEX "chat_approval_links_variantId_cycle_key" ON "chat_approval_links"("variantId", "cycle");
CREATE INDEX "chat_approval_links_campaignId_status_idx" ON "chat_approval_links"("campaignId", "status");
CREATE INDEX "chat_approval_links_status_updatedAt_idx" ON "chat_approval_links"("status", "updatedAt");
