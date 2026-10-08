# Social Publisher Backend

Backend độc lập cho nền tảng phân phối nội dung đa kênh. Repository này là nguồn sự thật của REST/OpenAPI; frontend chỉ giao tiếp qua `/api/v1` và không truy cập database, queue hoặc social credential.

## Trạng thái MVP

- NestJS 11, TypeScript strict, PostgreSQL/Prisma, RabbitMQ, Redis, MinIO/S3.
- JWT access token + rotating refresh session, RBAC `ADMIN | EDITOR | VIEWER`.
- Redis auth throttle: login theo IP `100/15 phút` và normalized-email hash `10/15 phút`; refresh theo IP `180/15 phút`.
- Credential và OAuth token mã hóa AES-256-GCM; không trả secret qua API.
- Nguồn `URL | RSS | SITEMAP | WORDPRESS | MANUAL`, sanitize HTML; crawler và các connector dùng base URL động đều có SSRF guard, DNS validation/pinning và kiểm tra redirect.
- OpenAI Responses API với JSON Schema/Structured Outputs; prompt lưu trong database.
- Campaign → target → publish job; scheduler, retry 30s/120s/600s, DLQ, per-job lock, cross-job fingerprint lock (`account + content hash`), rate limit và idempotency key.
- Connector tự động MVP: Instagram (một ảnh), Threads (text/một ảnh), X (text), LinkedIn (text), WordPress (article), Blogger (article), dev.to (article), Discord (text), Bluesky (text), Mastodon (text).
- Reddit và TikTok chạy `MANUAL/NEEDS_ACTION`; hệ thống không bypass CAPTCHA, 2FA, anti-bot hay chính sách nền tảng.
- OAuth hoàn chỉnh hiện có cho LinkedIn và Google→Blogger. Provider khác hiển thị rõ `API_REVIEW_REQUIRED`, `API_RESEARCH_REQUIRED` hoặc `MANUAL`.

Các connector chưa được coi là “đã kiểm chứng production” cho đến khi chạy integration test bằng app/account thật. Xem [DEVELOPMENT_PLAN.md](DEVELOPMENT_PLAN.md).

## Chạy local

Yêu cầu Node.js 22+, Corepack và Docker.

```bash
corepack pnpm install
cp .env.example .env
# tạo khóa đúng 32 bytes base64
openssl rand -base64 32
# điền CREDENTIAL_ENCRYPTION_KEY và đổi toàn bộ change_me
docker compose up -d --build
docker compose exec api pnpm prisma:seed
```

API: `http://localhost:3001/api/v1`  
Swagger: `http://localhost:3001/api/docs`  
OpenAPI JSON: `http://localhost:3001/api/docs-json`  
Health: `http://localhost:3001/health`  
MinIO console: `http://localhost:9001`  
RabbitMQ console: `http://localhost:15672`

Tài khoản seed lấy từ `SEED_ADMIN_EMAIL`/`SEED_ADMIN_PASSWORD`. Production bắt buộc password riêng dài tối thiểu 12 ký tự và từ chối mật khẩu development mặc định; đặt đúng ngay trước lần seed đầu.

## Lệnh chất lượng

```bash
corepack pnpm prisma:generate
corepack pnpm lint
corepack pnpm typecheck
corepack pnpm test
corepack pnpm test:e2e
corepack pnpm build
corepack pnpm openapi:export
```

## Bản đồ source và cách liên kết

| Thư mục | Trách nhiệm | Liên kết chính |
|---|---|---|
| `src/config` | Đọc/validate environment | Được import global bởi API và worker |
| `src/common` | Decorator, guard metadata, error model, response envelope, request log | Bao quanh mọi controller; không chứa business logic |
| `src/database` | Một `PrismaService` dùng chung | Repository/data service của mọi domain module |
| `src/auth`, `src/users` | Login/refresh/logout/me, JWT, RBAC, user admin | Guard global bảo vệ mọi route trừ `@Public()` |
| `src/platforms` | Catalog và capability của platform | Frontend đọc capability; seed đồng bộ với connector thật |
| `src/platform-accounts`, `src/credentials`, `src/oauth` | Destination theo owner, secret mã hóa, OAuth state/token | Worker giải mã server-side ngay trước khi gọi connector |
| `src/connectors` | Interface, registry và adapter API chính thức/manual | `PublishingService` chỉ biết `SocialPublisher`, không biết chi tiết từng API |
| `src/crawler`, `src/content-sources`, `src/source-articles` | Discover/fetch/clean nội dung nguồn | Tạo `SourceArticle`, sau đó promote thành `Content` |
| `src/contents`, `src/ai`, `src/prompts`, `src/content-variants` | Nội dung chuẩn, prompt DB và bản viết theo platform | AI chỉ sinh variant, tuyệt đối không publish |
| `src/campaigns` | Chọn content, variant và nhiều account | Tạo target/job với idempotency key ổn định |
| `src/queue`, `src/scheduler`, `src/workers`, `src/publishing` | Dispatch, lock, rate-limit, retry và gọi connector | Scheduler chỉ enqueue; worker mới publish |
| `src/media`, `src/storage` | Kiểm MIME/magic bytes, chuẩn hóa extension và upload asset vào S3/MinIO | Content và Variant có thể tham chiếu media; worker hợp nhất/dedupe hai nguồn, URL public phải cấu hình đúng |
| `src/audit`, `src/logs` | Audit metadata mutation và màn hình log | Chỉ ghi actor/action/entity/request/IP; không sao chép body, token hay credential |
| `src/settings`, `src/health` | Setting admin, health/readiness | Readiness kiểm tra PostgreSQL, Redis và RabbitMQ; secret setting được AES-GCM |
| `prisma` | Schema, migration, seed role/platform/prompt | Là source of truth của persistence |
| `scripts` | Xuất OpenAPI | Frontend generate client từ `openapi.json` |
| `test`/`*.spec.ts` | Unit/E2E tests | CI chạy trước build Docker |

Luồng chính:

```text
ContentSource → SourceArticle → Content → AI ContentVariant
  → Campaign → CampaignTarget → PublishJob → RabbitMQ
  → Worker → Redis lock/rate limit → ConnectorRegistry → Social API
  → PublishAttempt + PublishedPost
```

## Tài liệu

- [ARCHITECTURE.md](ARCHITECTURE.md)
- [DATABASE.md](DATABASE.md)
- [CONNECTOR_GUIDE.md](CONNECTOR_GUIDE.md)
- [QUEUE.md](QUEUE.md)
- [SECURITY.md](SECURITY.md)
- [DEPLOYMENT.md](DEPLOYMENT.md)
- [SOCIAL_CONFIGURATION.md](SOCIAL_CONFIGURATION.md)
- [EXTENDED_PLATFORM_CATALOG.md](EXTENDED_PLATFORM_CATALOG.md)
- [DEVELOPMENT_PLAN.md](DEVELOPMENT_PLAN.md)
