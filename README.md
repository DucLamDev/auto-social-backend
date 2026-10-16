# Social Publisher Backend

Backend độc lập cho nền tảng phân phối nội dung đa kênh. Repository này là nguồn sự thật của REST/OpenAPI; frontend chỉ giao tiếp qua `/api/v1` và không truy cập database, queue hoặc social credential.

Kiểm tra đăng nhập CSV, đăng nhập thủ công trong đúng profile và tái sử dụng session được mô tả tại
[AUTH_RECOVERY.md](AUTH_RECOVERY.md#đăng-nhập-từ-danh-sách-csv-và-giữ-phiên-cục-bộ). Công cụ smoke chỉ kiểm tra
login; đăng bài dùng connector/publisher tương ứng khi có credential và hạ tầng backend hoạt động.

Kiểm thử X bằng Chrome đã cài trên máy Windows 10: [WINDOWS_X_LOGIN.md](WINDOWS_X_LOGIN.md).

## Trạng thái MVP

- NestJS 11, TypeScript strict, PostgreSQL/Prisma, RabbitMQ, Redis, MinIO/S3.
- JWT access token + rotating refresh session, RBAC `ADMIN | EDITOR | VIEWER`.
- Redis auth throttle: login theo IP `100/15 phút` và normalized-email hash `10/15 phút`; refresh theo IP `180/15 phút`.
- Credential và OAuth token mã hóa AES-256-GCM; không trả secret qua API.
- Nguồn `URL | RSS | SITEMAP | WORDPRESS | MANUAL`, sanitize HTML; crawler và các connector dùng base URL động đều có SSRF guard, DNS validation/pinning và kiểm tra redirect.
- AI đa provider (`openai | deepseek | gemini`) với structured output và kiểm tra schema; prompt SEO/theo ngữ cảnh từng destination được lưu trong database.
- Campaign → target → publish job; scheduler, retry 30s/120s/600s, DLQ, per-job lock, cross-job fingerprint lock (`account + content hash`), rate limit và idempotency key.
- Catalog có **65 destination duy nhất**, gom trong 8 nhóm `SOCIAL | BLOGGING | COMMUNITY | FORUM | DEVELOPER | MEDIA | COMMERCE | EVENT`. API `GET /api/v1/platforms` hỗ trợ phân trang, tìm kiếm và lọc theo nhóm/chế độ/mức hỗ trợ/trạng thái bật.
- Connector tự động MVP: Instagram (một ảnh), Threads (text/một ảnh), X (text), LinkedIn (text), WordPress (article), Blogger (article), dev.to (article), Discourse (topic text/article), Discord (text), Bluesky (text), Mastodon (text). Nhiều instance cùng engine dùng lại connector Discourse hoặc Mastodon bằng base URL riêng.
- Medium, Reddit, TikTok và các destination không có create API phù hợp chạy bàn giao `MANUAL/NEEDS_ACTION`: AI vẫn tạo nội dung và giữ media để người dùng copy/mở editor/xác nhận kết quả. Hệ thống không bypass CAPTCHA, 2FA, anti-bot hay chính sách nền tảng.
- OAuth hoàn chỉnh hiện có cho LinkedIn và Google→Blogger. Provider khác hiển thị rõ `API_REVIEW_REQUIRED`, `API_RESEARCH_REQUIRED` hoặc `MANUAL`.

Các connector chưa được coi là “đã kiểm chứng production” cho đến khi chạy integration test bằng app/account thật. Xem [DEVELOPMENT_PLAN.md](DEVELOPMENT_PLAN.md).

## Chạy local

Yêu cầu Node.js 22+, Corepack và Docker.

```powershell
corepack pnpm install
Copy-Item .env.example .env
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
# Dán kết quả vào CREDENTIAL_ENCRYPTION_KEY, đổi các giá trị change_me
# và đặt SEED_ADMIN_EMAIL/SEED_ADMIN_PASSWORD trước lần seed đầu.
docker compose config --quiet
docker compose up -d --build --wait
docker compose exec api corepack pnpm prisma:seed
Invoke-RestMethod http://localhost:3001/ready
```

Không dùng `npm start` như lệnh khởi động toàn bộ project: lệnh đó chỉ chạy API trên host, không khởi động PostgreSQL, Redis, RabbitMQ, MinIO hoặc worker và cũng không chạy migration/seed. Lỗi Prisma `P1012 Environment variable not found: DATABASE_URL` nghĩa là chưa có `.env`; lỗi `P1001` sau đó nghĩa là PostgreSQL chưa chạy. Với lần chạy đầu, dùng Compose như trên.

Giữ cố định và backup `CREDENTIAL_ENCRYPTION_KEY` trước khi lưu social credential. Đổi key sau khi đã lưu API key sẽ làm credential cũ không giải mã được.

### Cấu hình AI provider

Khóa AI chỉ được cấu hình trong `.env` của backend; không đưa chúng vào biến `NEXT_PUBLIC_*`, source frontend, request body hoặc Git. Chọn provider mặc định và cấu hình từng provider độc lập:

```dotenv
AI_DEFAULT_PROVIDER=deepseek
AI_TIMEOUT_MS=60000

OPENAI_API_KEY=
OPENAI_MODEL=gpt-5-mini

DEEPSEEK_API_KEY=your-deepseek-key
DEEPSEEK_MODEL=deepseek-flash

GEMINI_API_KEY=
GEMINI_MODEL=gemini-3.5-flash
GEMINI_FALLBACK_MODEL=gemini-3.5-flash-lite
```

`AI_DEFAULT_PROVIDER` chỉ nhận `openai`, `deepseek` hoặc `gemini`. Studio và luồng **Tạo tự động** cho phép chọn provider cho từng lần sinh nội dung; nếu request không chỉ định, backend dùng provider mặc định. Giao diện chỉ nhận trạng thái đã cấu hình và tên model từ `GET /api/v1/ai/providers`, không nhận API key. Provider chưa có key sẽ bị vô hiệu hóa trong danh sách chọn; vì vậy Gemini chỉ dùng được sau khi đặt `GEMINI_API_KEY` và khởi động lại API/worker. Các biến `*_MODEL` do backend kiểm soát, người dùng không gửi model tùy ý từ trình duyệt.

### Luồng một lần nhập

Tại **Chiến dịch → Tạo tự động**, người dùng nhập mô tả bài đăng, có thể đính kèm một ảnh và alt text, chọn AI provider cùng các destination, rồi chọn chạy ngay hoặc lên lịch. Backend tạo canonical content, sinh một variant riêng theo prompt/capability của từng platform, gắn media, tự duyệt variant và tạo publish job. Không dùng cùng một nội dung thô cho mọi kênh. Một lần automation nhận tối đa 12 platform khác nhau; chia thành nhiều campaign khi cần phân phối rộng hơn.

Kết quả phụ thuộc loại connector:

- `OFFICIAL_API`/`COMPATIBLE_API`: worker gọi API thật; thành công trực tiếp là `PUBLISHED`. Bài draft hoặc topic đi qua moderation có thể là `NEEDS_ACTION` dù request API đã thành công.
- `MANUAL`: worker tuyệt đối không mô phỏng đăng nhập. Job chủ động dừng ở `NEEDS_ACTION`; `GET /api/v1/publish-jobs/:id/manual-payload` trả title/body/hashtags/canonical URL/media và editor URL để giao diện **Copy & mở**. Sau khi người dùng đăng thật, endpoint mark-published lưu external ID/URL và chuyển job sang `PUBLISHED`.
- Media chỉ được gửi khi connector khai báo capability phù hợp. Với kênh manual, media vẫn nằm trong handoff để người dùng tải/chèn bằng editor chính thức.

Medium thuộc nhánh manual. Ảnh RapidAPI chỉ minh họa endpoint đọc không chính thức và làm lộ credential trên màn hình; project không dùng endpoint/key đó để publish. Hãy revoke/rotate mọi key từng được dán vào chat hoặc xuất hiện trong ảnh chụp trước khi dùng tài khoản thật.

Nếu vừa cập nhật source hoặc AI key nhưng UI vẫn không thấy OpenAI/DeepSeek/Gemini, hãy build lại image thay vì chỉ restart container:

```powershell
docker compose up -d --build --force-recreate api worker
```

Sau đó build lại frontend theo README của repository frontend. Provider có key hợp lệ sẽ chọn được; provider thiếu key vẫn hiện nhưng bị vô hiệu hóa.

API: `http://localhost:3001/api/v1`  
Swagger: `http://localhost:3001/api/docs`  
OpenAPI JSON: `http://localhost:3001/api/docs-json`  
Health: `http://localhost:3001/health`  
MinIO console: `http://localhost:9001`  
RabbitMQ console: `http://localhost:15672`

Tài khoản seed lấy từ `SEED_ADMIN_EMAIL`/`SEED_ADMIN_PASSWORD`. Production bắt buộc password riêng dài tối thiểu 12 ký tự và từ chối mật khẩu development mặc định; đặt đúng ngay trước lần seed đầu.

## Lệnh chất lượng

Browser publisher có luồng phục hồi CAPTCHA/2FA với người vận hành, persistent profile và OTP nhập ẩn:
`pnpm bot login <platform> <account>`, `pnpm bot auth-check`, `pnpm bot post`, `pnpm bot publish-all` và
`pnpm bot accounts`. `publish-all --skip-auth-blocked` bỏ qua account cần xác thực. Xem cú pháp đầy đủ, cấu hình
timeout và giới hạn nền tảng trong [AUTH_RECOVERY.md](AUTH_RECOVERY.md).
Account do bạn quản lý có thể bật `browserAutoTotp=true` để bot tự sinh/nhập TOTP từ secret được cấu hình riêng
trong environment. CAPTCHA/Cloudflare vẫn cần người dùng hoàn thành; hướng dẫn lưu secret và giới hạn ở tài liệu trên.

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
| `src/connectors` | Interface, registry và adapter API chính thức/compatible/manual | `PublishingService` chỉ biết `SocialPublisher`, không biết chi tiết từng API |
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
- [SOCIAL_API_SETUP_GUIDE.md](SOCIAL_API_SETUP_GUIDE.md) — lấy token/key từng nền tảng và điền vào form
- [OPERATIONS_REVIEW.md](OPERATIONS_REVIEW.md) — rà soát vận hành và kế hoạch hoàn thiện
- [DISCOURSE_CONFIGURATION.md](DISCOURSE_CONFIGURATION.md)
- [BROWSER_AUTOMATION.md](BROWSER_AUTOMATION.md)
- [AUTH_RECOVERY.md](AUTH_RECOVERY.md) — persistent profile, CAPTCHA/2FA thủ công, OTP nhập ẩn và CLI `pnpm bot`
- [EXTENDED_PLATFORM_CATALOG.md](EXTENDED_PLATFORM_CATALOG.md)
- [DEVELOPMENT_PLAN.md](DEVELOPMENT_PLAN.md)
