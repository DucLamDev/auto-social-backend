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
- [x] OpenAI Responses Structured Outputs integration. Dependencies: `OPENAI_API_KEY`. Files: `src/ai`. Test: structured parser unit tests.
- [!] Live OpenAI integration test. Dependencies: billable API key/network. Files: `src/ai`. Test: generate endpoint against test content. Notes: `CREDENTIAL_REQUIRED`.

## Publishing platform

- [x] Registry/capability/manual adapter architecture. Files: `src/connectors/core`, bootstrap/manual. Test: registry/error mapping specs.
- [x] Campaign/jobs/scheduler/RabbitMQ worker/Redis lock and per-account rate limit. Dependencies: Postgres/Redis/RabbitMQ. Files: campaigns/queue/scheduler/workers/publishing. Test: queue routing, idempotency/retry unit tests; Compose smoke test remains below.
- [x] Internal duplicate prevention and worker-crash `POSSIBLE_DUPLICATE` recovery. Files: publishing/scheduler/queue. Test: concurrency unit tests. Notes: Redis fingerprint lock theo `platformAccountId + contentHash` bao trọn duplicate-check → provider publish → persist, ngoài per-job lock và DB idempotency.
- [!] Official connector live verification (Instagram, Threads, X, LinkedIn, WordPress, Blogger, dev.to, Discord, Bluesky, Mastodon). Dependencies: platform credentials, app approvals and test accounts. Files: `src/connectors/*`. Test: per-platform publish/delete where capability true. Notes: implementation and mocks exist; Definition of Done needs real sandbox evidence.
- [x] Reddit/TikTok safe manual flow. Dependencies: none. Files: manual connector, publish job manual payload/confirmation. Test: API/unit/build. Notes: no security bypass.
- [!] Instagram/Threads OAuth and app review. Dependencies: Meta app/review/current approved scopes. Notes: manual encrypted token supported; OAuth advertised REVIEW_REQUIRED.
- [ ] Media upload pipelines per connector (Mastodon/Discord/X/LinkedIn/Bluesky), carousel/video status polling. Dependencies: platform-specific upload research. Notes: capabilities remain false until done.

## Media/operations

- [x] S3/MinIO validated upload and owner-scoped metadata. Dependencies: bucket/public URL. Files: storage/media/Compose. Test: MIME spoofing/canonical extension/ownership. Notes: magic bytes được kiểm tra; worker hợp nhất và dedupe media của Content + Variant; không attach thêm sau khi content/variant đã vào campaign.
- [ ] FFmpeg transform/thumbnail/transcode worker. Dependencies: media profiles. Notes: FFmpeg exists in Docker image, pipeline intentionally deferred.
- [ ] Playwright/browser-assisted workflow. Dependencies: an approved use case that cannot use official API. Notes: intentionally not installed; never bypass CAPTCHA/2FA/anti-bot.
- [x] Docker dev/prod Compose, health checks, persistent volumes, CI. Files: Dockerfiles, Compose, `.github/workflows/ci.yml`.
- [x] HTTP smoke E2E cho liveness/readiness và response envelope với dependency mock. Test: `pnpm test:e2e` (1 suite / 2 tests).
- [!] Local Docker image build execution. Dependencies: running Docker daemon. Test: `docker build -t social-publisher-backend:validation .`. Notes: Compose YAML validated; Docker Desktop engine was unavailable in the handoff environment, so CI/VPS must execute the image build.
- [!] Full Compose integration/smoke test. Dependencies: Docker daemon and real local `.env`. Test: `docker compose up`, migrate/seed, login→campaign→manual publish. Notes: validate before production cutover.

## Quality gate

- [x] Lint. Test: `pnpm lint`.
- [x] Typecheck. Test: `pnpm typecheck`.
- [x] Unit tests. Test: `pnpm test` (31 suites / 102 tests at handoff), gồm duplicate delivery/concurrency fingerprint lock, retry/DLQ, stale `QUEUED`/`PUBLISHING` recovery, campaign state reconciliation, OAuth query log redaction, 429/timeout/token hết hạn, auth rotation race/rate limit, encryption, media magic bytes/inheritance/upload concurrency, audit, OpenAI structured output/privacy/status rollback, Meta mock API, draft semantics, content/source article/media/publish-job pagination, exact dashboard metrics, crawler SSRF streaming cap và connector SSRF/DNS-rebinding/redirect/response-size guard.
- [x] Build. Test: `pnpm build`.
- [x] OpenAPI export. Test: `pnpm openapi:export`.
- [x] Production dependency audit. Test: `pnpm audit --prod`. Notes: không có advisory production tại thời điểm bàn giao.
- [ ] End-to-end HTTP tests against disposable PostgreSQL/Redis/RabbitMQ. Dependencies: CI service containers.
- [x] DNS-pinned outbound guard cho base URL connector cấu hình động (WordPress/Forem/Mastodon/Bluesky). Files: `src/connectors/core/connector-outbound-http.client.ts`, `HttpConnectorBase` và bốn connector. Test: private/reserved IP, mixed DNS, same-origin DNS rebinding, private/cross-origin redirect và public endpoint. Notes: HTTPS/public-only + per-hop validation/pinned dispatcher đã bật; firewall/egress proxy vẫn là defense-in-depth.
