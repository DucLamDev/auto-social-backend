ALTER TABLE "publish_jobs"
  ADD COLUMN "extensionClaimDeviceId" UUID,
  ADD COLUMN "extensionPasswordIssuedAt" TIMESTAMP(3),
  ADD COLUMN "extensionTotpIssuedAt" TIMESTAMP(3);
ALTER TABLE "publish_jobs" ADD CONSTRAINT "publish_jobs_extensionClaimDeviceId_fkey"
  FOREIGN KEY ("extensionClaimDeviceId") REFERENCES "extension_devices"("id") ON DELETE SET NULL ON UPDATE CASCADE;
