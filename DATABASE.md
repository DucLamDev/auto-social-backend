# Database

PostgreSQL là nguồn sự thật. Prisma schema ở `prisma/schema.prisma`; migration ban đầu ở `prisma/migrations/20261008000000_initial`.

## Nhóm entity

- Identity: `User`, `Role`, `UserRole`, `RefreshTokenSession`.
- Destination: `Platform`, `PlatformCapability`, `PlatformAccount`, `PlatformCredential`, `OAuthToken`, `OAuthState`.
- Content: `ContentSource`, `SourceArticle`, `Content`, `ContentVariant`, `MediaAsset`, `PromptTemplate`.
- Delivery: `Campaign`, `CampaignTarget`, `PublishJob`, `PublishAttempt`, `PublishedPost`.
- Operations: `AuditLog`, `SystemSetting`.

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
