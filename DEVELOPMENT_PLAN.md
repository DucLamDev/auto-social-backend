# Development Plan

Ký hiệu: `[ ] TODO`, `[-] IN PROGRESS`, `[x] DONE`, `[!] BLOCKED`.

## Foundation

- [x] NestJS strict foundation. Dependencies: Node 22/pnpm. Files: `src/main.ts`, `src/app.module.ts`, config/common/database. Test: `pnpm lint && pnpm typecheck && pnpm build`. Notes: API/worker là process độc lập.
- [x] PostgreSQL/Prisma model, migration, seed. Dependencies: PostgreSQL. Files: `prisma/*`. Test: `pnpm prisma:generate`, migration diff; runtime `pnpm prisma:deploy`.
- [x] JWT rotating refresh + RBAC + tenant ownership + Redis auth limiter. Dependencies: database/JWT secrets/Redis. Files: `src/auth`, `src/users`. Test: auth service/controller specs, gồm rotating-refresh race và login/refresh `AUTH_RATE_LIMITED`.
- [x] AES-256-GCM credentials/OAuth token. Dependencies: 32-byte master key. Files: `src/credentials`. Test: encryption roundtrip/random IV/tamper.
- [x] REST envelope, Swagger/OpenAPI export. Files: common interceptors/filter, `src/swagger.ts`, `scripts/export-openapi.ts`, `openapi.json`. Test: `pnpm openapi:export`.

## Content and AI

- [x] URL/RSS/Sitemap/WordPress ingest, sanitize, duplicate hash and SSRF protection. Dependencies: public source. Files: crawler/content-sources/source-articles. Test: crawler/SSRF specs.
- [x] Canonical Content, server-side pagination/search/status filter, prompt versioning và variant review/edit. Files: contents/prompts/content-variants. Test: content service pagination + typecheck/API DTO. Notes: variant đã được campaign target tham chiếu là immutable.
- [x] AI provider runtime cho OpenAI, DeepSeek và Gemini; chọn provider theo từng lần sinh nội dung, fallback qua `AI_DEFAULT_PROVIDER`, model/key do backend quản lý và structured output được kiểm tra bằng schema. Dependencies: API key tương ứng (`OPENAI_API_KEY`, `DEEPSEEK_API_KEY`, `GEMINI_API_KEY`). Files: `src/ai`, DTO campaign/content. Test: provider catalog, parser và provider client unit tests.
- [!] Live AI provider integration test. Dependencies: billable API key/network/quota của từng provider. Files: `src/ai`. Test: generate endpoint against test content cho OpenAI, DeepSeek và Gemini. Notes: provider chưa có key trả `INFRASTRUCTURE_UNAVAILABLE`; Gemini bị vô hiệu hóa trên UI cho đến khi cấu hình `GEMINI_API_KEY`.

## Publishing platform

- [x] Registry/capability/manual adapter architecture. Files: `src/connectors/core`, bootstrap/manual. Test: registry/error mapping specs.
- [x] Campaign/jobs/scheduler/RabbitMQ worker/Redis lock and per-account rate limit. Dependencies: Postgres/Redis/RabbitMQ. Files: campaigns/queue/scheduler/workers/publishing. Test: queue routing, idempotency/retry unit tests; Compose smoke test remains below.
- [x] Internal duplicate prevention and worker-crash reconciliation. Files: publishing/scheduler/queue. Test: concurrency/persistence-boundary unit tests. Notes: Redis fingerprint lock theo `platformAccountId + contentHash` bao trọn duplicate-check → provider publish → persist; stale `PUBLISHING` chuyển `NEEDS_ACTION`, và unresolved submissions chặn cross-job duplicate cho đến khi operator đối soát.
- [x] Generic Discourse connector cho topic mới. Dependencies: Discourse instance/API key do admin cấp. Files: `src/connectors/discourse`, seed và form credential frontend. Test: validate/config, global/category permission, category tag-policy reporting, destination `defaultTags` normalization không hard-code giới hạn (không dùng AI hashtags), deterministic external ID/recovery, publish/moderation, 401/403/429/5xx/timeout và ambiguous response. Notes: dùng `Api-Key` + `Api-Username`; timeout/5xx chưa đối soát được chuyển sang human reconciliation thay vì auto-retry; chưa triển khai User API Key flow, manual fallback, reply/media/edit/delete.
- [!] API connector live verification (Instagram, Threads, X, LinkedIn, WordPress, Blogger, dev.to, Discourse, Discord, Bluesky, Mastodon). Dependencies: platform credentials, app approvals and test accounts. Files: `src/connectors/*`. Test: per-platform publish/delete where capability true. Notes: implementation và mock/unit test có sẵn; Definition of Done cần bằng chứng sandbox/staging thật. Public Discourse forum còn cần admin của forum cấp quyền.
- [x] Reddit/TikTok safe manual flow. Dependencies: none. Files: manual connector, publish job manual payload/confirmation. Test: API/unit/build. Notes: no security bypass.
- [!] Instagram/Threads OAuth and app review. Dependencies: Meta app/review/current approved scopes. Notes: manual encrypted token supported; OAuth advertised REVIEW_REQUIRED.
- [ ] Media upload pipelines per connector (Mastodon/Discord/X/LinkedIn/Bluesky), carousel/video status polling. Dependencies: platform-specific upload research. Notes: capabilities remain false until done.

## Media/operations

- [x] S3/MinIO validated upload and owner-scoped metadata. Dependencies: bucket/public URL. Files: storage/media/Compose. Test: MIME spoofing/canonical extension/ownership. Notes: magic bytes được kiểm tra; worker hợp nhất và dedupe media của Content + Variant; không attach thêm sau khi content/variant đã vào campaign.
- [ ] FFmpeg transform/thumbnail/transcode worker. Dependencies: media profiles. Notes: FFmpeg exists in Docker image, pipeline intentionally deferred.
- [ ] Playwright/browser-assisted workflow. Dependencies: an approved use case that cannot use official API. Notes: intentionally not installed; never bypass CAPTCHA/2FA/anti-bot.
- [x] Docker dev/prod Compose, health checks, persistent volumes, CI. Files: Dockerfiles, Compose, `.github/workflows/ci.yml`.
- [x] HTTP smoke E2E cho liveness/readiness và response envelope với dependency mock. Test: `pnpm test:e2e` (1 suite / 2 tests).
- [x] Local Docker image build execution. Dependencies: Docker Desktop/Linux engine. Test: `docker build --pull -t social-publisher-backend:validation .`, then run Prisma, TSX and FFmpeg checks with `--network none`. Notes: image built successfully; Prisma selected `debian-openssl-3.0.x`, and the runtime contains an offline Corepack cache so migration/seed tooling does not download pnpm at startup.
- [x] Full Compose integration/smoke test with isolated validation data. Dependencies: Docker daemon and validation-only `.env`. Test: production Compose up/wait, migrate, seed, health/readiness, login, create content/manual Reddit account, approved fixture variant, publish campaign, inspect `NEEDS_ACTION`, mark published. Notes: all infrastructure/API/two workers became healthy; the campaign reconciled to `COMPLETED` and its job to `PUBLISHED`. Real provider credentials remain a separate pre-production gate.

## Quality gate

- [x] Lint. Test: `pnpm lint`.
- [x] Typecheck. Test: `pnpm typecheck`.
- [x] Unit tests. Test: `pnpm test` (36 suites / 218 tests), gồm duplicate delivery/concurrency fingerprint lock, retry/DLQ, stale `QUEUED`/`PUBLISHING` recovery, campaign state reconciliation, OAuth query log redaction, 429/timeout/token hết hạn, auth rotation race/rate limit, encryption, media magic bytes/inheritance/upload concurrency, audit, AI multi-provider/structured output/privacy/status rollback, Meta mock API, draft semantics, content/source article/media/publish-job pagination, exact dashboard metrics, crawler SSRF streaming cap và connector SSRF/DNS-rebinding/redirect/response-size guard.
- [x] Build. Test: `pnpm build`.
- [x] OpenAPI export. Test: `pnpm openapi:export`.
- [x] Production dependency audit. Test: `pnpm audit --prod`. Notes: không có advisory production tại thời điểm bàn giao.
- [ ] End-to-end HTTP tests against disposable PostgreSQL/Redis/RabbitMQ. Dependencies: CI service containers.
- [x] DNS-pinned outbound guard cho base URL connector cấu hình động (WordPress/Forem/Mastodon/Bluesky/Discourse). Files: `src/connectors/core/connector-outbound-http.client.ts`, `HttpConnectorBase` và các connector tương ứng. Test: private/reserved IP, mixed DNS, same-origin DNS rebinding, private/cross-origin redirect và public endpoint. Notes: HTTPS/public-only + per-hop validation/pinned dispatcher đã bật; firewall/egress proxy vẫn là defense-in-depth.
