-- Bearer tokens for the MCP endpoint (token stored as SHA-256 only).
CREATE TABLE "mcp_tokens" (
    "id" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "scopes" TEXT[],
    "lastUsedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mcp_tokens_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "mcp_tokens_tokenHash_key" ON "mcp_tokens"("tokenHash");
CREATE INDEX "mcp_tokens_ownerId_revokedAt_idx" ON "mcp_tokens"("ownerId", "revokedAt");

ALTER TABLE "mcp_tokens" ADD CONSTRAINT "mcp_tokens_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
