CREATE TABLE "extension_login_checks" (
  "id" UUID NOT NULL,
  "batchId" UUID NOT NULL,
  "platformAccountId" UUID NOT NULL,
  "deviceId" UUID NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'QUEUED',
  "message" TEXT,
  "detectedUsername" TEXT,
  "passwordIssuedAt" TIMESTAMP(3),
  "totpIssuedAt" TIMESTAMP(3),
  "startedAt" TIMESTAMP(3),
  "finishedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "extension_login_checks_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "extension_login_checks_account_fkey" FOREIGN KEY ("platformAccountId") REFERENCES "platform_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "extension_login_checks_device_fkey" FOREIGN KEY ("deviceId") REFERENCES "extension_devices"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "extension_login_checks_deviceId_status_createdAt_idx" ON "extension_login_checks"("deviceId", "status", "createdAt");
CREATE INDEX "extension_login_checks_platformAccountId_createdAt_idx" ON "extension_login_checks"("platformAccountId", "createdAt");
