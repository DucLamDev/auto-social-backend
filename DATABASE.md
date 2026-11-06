# Database

PostgreSQL là nguồn sự thật. Prisma schema ở `prisma/schema.prisma`; migration ban đầu ở `prisma/migrations/20261008000000_initial`.

## Nhóm entity

- Identity: `User`, `Role`, `UserRole`, `RefreshTokenSession`.
- Destination: `Platform`, `PlatformCapability`, `PlatformAccount`, `PlatformCredential`, `OAuthToken`, `OAuthState`.
- Content: `ContentSource`, `SourceArticle`, `Content`, `ContentVariant`, `MediaAsset`, `PromptTemplate`.
  `ContentVariant.aiRevision` (JSON, có thể trống) giữ lần "viết lại bằng AI" gần nhất: `status`
  generating/done/failed, `instruction`, `startedAt`, `finishedAt`, `error`; migration
  `20261104160000_content_variant_ai_revision`.
- Delivery: `Campaign`, `CampaignTarget`, `PublishJob`, `PublishAttempt`, `PublishedPost`.
  `Campaign.automationErrorDetail` (JSON, có thể trống) giữ nguyên nhân lần chạy AI gần nhất bị lỗi: `code`, `message`,
  `platform`, `platformName`, `provider`, `at`; được xoá khi chạy lại; migration `20261106090000_campaign_automation_error_detail`.
- Operations: `AuditLog`, `SystemSetting`.
- Agents: `ExtensionDevice` (tiện ích Chrome đã ghép nối), `McpToken` (token MCP cho Codex: chỉ lưu SHA-256, `scopes`
  `read`/`write`, `expiresAt`, `revokedAt`; migration `20261103100000_mcp_tokens`).
- Gợi ý giao diện: `ExtensionUiHint` (mỗi lần tiện ích hỏi AI: phần tử đã che dữ liệu, trạng thái RUNNING/READY/FAILED,
  kết quả) và `ExtensionSelectorSuggestion` (selector theo chủ sở hữu + engine + origin + ô, PENDING/APPROVED/REJECTED,
  unique `(ownerId, engine, origin, field, selector)`); migration `20261103110000_extension_ui_recovery`.

Quan hệ quan trọng:

```text
User 1──N PlatformAccount       Platform 1──N PlatformAccount
User 1──N ContentSource 1──N SourceArticle 0..1──1 Content
Content 1──N ContentVariant
Campaign 1──N CampaignTarget 1──N PublishJob 1──N PublishAttempt
PublishJob 0..1──1 PublishedPost
```

`PublishJob.idempotencyKey` có unique index từ `SHA256(campaignId:accountId:variantId)`. `PublishedPost` unique theo `(platformAccountId, externalPostId)`. Token/credential columns chứa ciphertext AES-GCM, không chứa plaintext.

## Migration

Development:

```bash
corepack pnpm prisma:migrate
corepack pnpm prisma:seed
```

Production:

```bash
corepack pnpm prisma:deploy
```

Luôn backup PostgreSQL trước migration. Không dùng `prisma db push` trong production.
