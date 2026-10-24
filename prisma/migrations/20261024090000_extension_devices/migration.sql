-- Paired Chrome extension devices (token stored as SHA-256 only).
CREATE TABLE "extension_devices" (
    "id" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "lastSeenAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "extension_devices_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "extension_devices_tokenHash_key" ON "extension_devices"("tokenHash");
CREATE INDEX "extension_devices_ownerId_revokedAt_idx" ON "extension_devices"("ownerId", "revokedAt");

ALTER TABLE "extension_devices" ADD CONSTRAINT "extension_devices_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
