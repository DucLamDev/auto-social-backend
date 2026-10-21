# Rà soát vận hành và kế hoạch hoàn thiện

> Rà soát ngày **2026-10-12** trên nhánh `feature/duclam-playwright-hardening` (backend + frontend). Các mục ghi
> `file:line` đã được đối chiếu với code; mục ghi *(cần kiểm chứng)* là suy luận chưa chạy thử.
> Hướng dẫn lấy thông tin cấu hình từng nền tảng: [SOCIAL_API_SETUP_GUIDE.md](SOCIAL_API_SETUP_GUIDE.md).

> **Cập nhật 21/10/2026 (bản 1.1.0):** đã xử lý T1 (Bluesky App Password), T3 (Meta OAuth + tự gia hạn
> Instagram/Threads), T4 (cron kiểm tra kết nối hằng ngày, nhắc token sắp hết hạn), T5 (lỗi mạng khi refresh không còn
> bắt kết nối lại), T6 (lỗi OAuth quay về UI), T7 (công tắc Đăng ngay / Lưu nháp cho Blogger, Tumblr), một phần O1/Q2
> (cảnh báo qua `ALERT_WEBHOOK_URL`, bảng **Cần xử lý**, chuông đếm số) và Q1 cho Instagram/Threads/Tumblr (timeout ở
> bước đăng → `NEEDS_ACTION` đối soát; lỗi đọc permalink sau khi đã đăng không còn gây thử lại). Thêm connector Tumblr.
> Còn mở: T2 (X), Q1 cho các connector khác, DLQ consumer, graceful shutdown, tạm giữ job khi account mất kết nối.

## 1. Kết luận nhanh

Phần lõi (chống trùng bằng khoá Redis, đối soát job treo, mã hoá credential, chặn SSRF) làm chắc. Hệ thống **chưa
vận hành trơn** vì 5 điểm nghẽn, xếp theo mức nguy hiểm:

1. **Có thể đăng trùng bài.** Timeout/lỗi mạng/5xx *sau khi* đã gửi POST được coi là "thử lại được"
   (`src/connectors/core/http-connector.base.ts:52-55`, `connector-error.ts:27`) và job bị gửi lại nguyên request
   (`src/publishing/publishing.service.ts:792-811`). Chỉ Mastodon có `Idempotency-Key`, chỉ Discourse có đối soát.
   Instagram/Threads gọi 3 bước: `media_publish` thành công nhưng bước đọc permalink lỗi → đăng lại.
2. **Token chết mà không ai biết.** Không có cơ chế làm mới token hay kiểm tra định kỳ. X và Bluesky (`accessJwt`) sống
   khoảng 2 giờ, Instagram/Threads 60 ngày, LinkedIn 60 ngày. Chỉ Google/Blogger tự refresh. Hệ quả: connector "đã có"
   trên thực tế ngừng chạy sau vài giờ đến vài tuần.
3. **Không có cảnh báo.** Không Telegram/Slack/email; DLQ `publish.dead-letter` không có consumer
   (`src/queue/rabbitmq.service.ts:104-108`); dashboard không đếm `NEEDS_ACTION`/`RETRY`
   (`publish-jobs.service.ts:95-114`); chuông trên frontend chỉ là link sang `/logs`.
4. **Mẫu đăng dễ bị coi là spam.** Mọi job của một chiến dịch cùng `scheduledAt`
   (`campaign-automation.service.ts:239`) và N account cùng nền tảng nhận **cùng một văn bản** (variant theo nền tảng,
   không theo account). Với 30 Instagram + 28 Threads, đây là dấu hiệu "trại bot" rõ nhất.
5. **Thiếu đường cấu hình/nhập liệu.** Không import hàng loạt account; account Playwright chỉ đăng nhập được qua CLI;
   CLI không chạy được trong image production (`ts-node` bị prune, `Dockerfile:18`); 4 blog WordPress.com trong
   danh sách không dùng được connector hiện tại.

## 2. Danh sách phát hiện

Mức độ: **Cao** = gây mất bài/đăng trùng/ngừng chạy; **TB** = vận hành vất vả; **Thấp** = cải thiện.

### 2.1 Luồng đăng và hàng đợi

| # | Mức | Phát hiện | Bằng chứng |
|---|---|---|---|
| Q1 | Cao | Retry mù sau khi đã gửi POST → đăng trùng | `http-connector.base.ts:52-55`, `publishing.service.ts:792-811` |
| Q2 | Cao | DLQ không có consumer, không alert, không giới hạn độ dài | `rabbitmq.service.ts:104-108` |
| Q3 | Cao | Restart/deploy worker cắt ngang job đang chạy → 15 phút sau thành `NEEDS_ACTION` hàng loạt | `rabbitmq.service.ts:81-86`, `scheduler.service.ts:73`; Compose không có `stop_grace_period` |
| Q4 | TB | Một token hết hạn làm `FAILED` toàn bộ job còn lại của account, phải retry từng job | `publishing.service.ts:192-198,818-826` |
| Q5 | TB | Worker không có healthcheck; `void bootstrap()` không bắt lỗi | `docker-compose.prod.yml:33-42`, `src/worker.ts:16` |
| Q6 | Thấp | Retry tay không reset `attemptCount` → job hết lượt chỉ thử thêm 1 lần | `publish-jobs.service.ts:128-140` |
| Q7 | Thấp | Nguồn nội dung không tự crawl theo lịch; bài crawl không tự thành chiến dịch | `content-sources.controller.ts:28` |

### 2.2 Token và kết nối

| # | Mức | Phát hiện | Bằng chứng |
|---|---|---|---|
| T1 | Cao | Bluesky dùng `accessJwt` tĩnh (~2 giờ), không `createSession`/`refreshSession` | `bluesky.connector.ts:26` |
| T2 | Cao | X dùng Bearer OAuth2 tĩnh (~2 giờ), không refresh, không đọc `X_CLIENT_*` | `x.connector.ts:26` |
| T3 | Cao | Instagram/Threads không gọi `refresh_access_token` → chết sau 60 ngày | không có lời gọi nào trong `src/` |
| T4 | Cao | Không có cron kiểm tra sức khoẻ account / cảnh báo sắp hết hạn | chỉ có 1 cron: `scheduler.service.ts:22` |
| T5 | TB | Refresh Google lỗi mạng tạm thời cũng bị đánh `RECONNECT_REQUIRED` | `connector-accounts.service.ts:106-108` |
| T6 | TB | Lỗi OAuth (người dùng bấm Từ chối) dừng ở trang JSON 400 trên domain API, không quay về UI | `oauth.controller.ts:53` |
| T7 | TB | Blogger mặc định tạo **bản nháp** (`publishImmediately=false`) và UI không có ô để đổi | `platform-catalog.ts:202` |

### 2.3 Cấu hình connector (frontend ↔ backend)

| # | Mức | Phát hiện | Bằng chứng |
|---|---|---|---|
| C1 | TB | `mastodon-social`/`vivaldi-social`: URL instance người dùng nhập bị bỏ qua (backend đọc `settings.instanceUrl` từ catalog trước) | `mastodon.connector.ts:49-52`, `platform-accounts.service.ts:180` |
| C2 | TB | Form Discourse điền sẵn `apiUsername=Lam_Ho`, `categoryId=4` (của VPSTTT) cho **mọi** diễn đàn | `auto-social-frontend/.env.example:4-6` |
| C3 | Thấp | Mặc định trên form khác code: WordPress `draft` (FE ghi `publish`), dev.to `publishImmediately=false` | `platform-catalog.ts:200,205` |
| C4 | TB | WordPress.com gói miễn phí không có Application Password theo site → 4 blog `*.wordpress.com` không dùng được connector `wordpress` | xem guide §10 |
| C5 | Thấp | Biến `META_*`, `X_*`, `REDDIT_*`, `TIKTOK_*` trong `.env.example` không được code đọc | `.env.example:71-85` |

### 2.4 Lập lịch, chống spam, media

| # | Mức | Phát hiện | Bằng chứng |
|---|---|---|---|
| S1 | Cao | Không jitter/giãn cách; nhiều account cùng nền tảng nhận văn bản giống hệt | `campaign-automation.service.ts:120,202,224,239` |
| S2 | TB | Rate limit cửa sổ cố định 10/60s, không quota ngày, không khoảng cách tối thiểu; Redis mất thì luôn cho qua | `redis.service.ts:57-66`, `publishing.service.ts:401-413` |
| S3 | TB | Media tối thiểu: IG/Threads 1 ảnh, không video/carousel; X/LinkedIn/Bluesky/Mastodon/WordPress/Blogger không ảnh | các connector; `DEVELOPMENT_PLAN.md` |
| S4 | TB | Chưa có pipeline FFmpeg (resize/convert JPEG cho Instagram, transcode video) | `Dockerfile:26` có FFmpeg nhưng không dùng |
| S5 | Thấp | Chưa giới hạn số Chromium song song (prefetch 10 → tới 10 Chromium/worker) | `rabbitmq.service.ts:112` |

### 2.5 Quan sát, bảo mật, hạ tầng

| # | Mức | Phát hiện | Bằng chứng |
|---|---|---|---|
| O1 | Cao | Không có kênh cảnh báo nào cho `NEEDS_ACTION`/`FAILED`/DLQ/token | grep `telegram|slack|smtp` rỗng |
| O2 | TB | `/ready` trả 200 kể cả khi Redis ping false; RabbitMQ lỗi thành 500 thay vì 503 | `health.controller.ts:30` |
| O3 | TB | Không `/metrics`; dashboard đếm biểu đồ 7 ngày từ `limit:1000` job phía client | `dashboard-view.tsx:14,26` |
| O4 | Cao | Không xoay được `CREDENTIAL_ENCRYPTION_KEY` (chỉ 1 key; version chỉ dùng làm AAD) | `credential-encryption.service.ts:10-19,35` |
| O5 | TB | Backup DB/MinIO chỉ có trên tài liệu | `scripts/` không có backup |
| O6 | TB | CI không chạy migration với Postgres thật; API tự `prisma:deploy` lúc khởi động → nhiều replica cùng migrate | `.github/workflows/ci.yml`, `docker-compose.prod.yml:24` |
| O7 | TB | CLI (`account:test`, `browser:login`) không chạy trong image production | `Dockerfile:18`, `package.json` |
| O8 | Thấp | File chẩn đoán browser nằm trong tmp của container, không mount volume, không có API tải về | `browser-diagnostics.ts` |

### 2.6 Giao diện vận hành (frontend)

| # | Mức | Phát hiện | Bằng chứng (`auto-social-frontend/src/`) |
|---|---|---|---|
| U1 | Cao | Không banner/đếm cho `NEEDS_ACTION`, `RECONNECT_REQUIRED`, token sắp hết hạn | `components/layout/topbar.tsx:17` |
| U2 | Cao | Không hiển thị `metadata.diagnostics` của job Playwright | `services/resources.service.ts:66-138` |
| U3 | Cao | Đăng nhập Playwright chỉ qua CLI, người không có shell không làm được | `features/accounts/browser-login-guide.tsx:10-54` |
| U4 | TB | Không có trang chi tiết chiến dịch; Publishing không lọc theo chiến dịch | `features/campaigns/campaigns-view.tsx:209` |
| U5 | TB | Không import hàng loạt account | — |
| U6 | TB | README nói kênh MANUAL chọn được trong chiến dịch tự động, code lại loại ra | `features/campaigns/campaign-utils.ts:7-10,28-31` |
| U7 | Thấp | Nút "Test" dùng chung trạng thái loading cho mọi dòng | `features/accounts/accounts-view.tsx:245` |

## 3. Ánh xạ danh sách tài khoản (`auth_v2.csv`) sang khả năng tự động

Đếm theo dòng có dữ liệu đăng nhập; chi tiết lấy config ở [SOCIAL_API_SETUP_GUIDE.md](SOCIAL_API_SETUP_GUIDE.md).

| Nhóm | Account | Đường tự động | Trạng thái hiện tại |
|---|---|---|---|
| dev.to | 10 | API key | **Cấu hình được ngay** |
| Blogger | 4 | Google OAuth | Cấu hình được; cần sửa T7 để đăng thẳng thay vì nháp |
| Mastodon.social, Vivaldi Social | 2 | Access token | **Cấu hình được ngay** |
| Discord | 1 | Webhook | Cấu hình được (cần quyền Manage Webhooks trên server) |
| Discourse (community VPSTTT) | 1+ | Admin API key | Cấu hình được trên site mình quản trị |
| Voz | 1 | Browser (session chụp tay) | Cấu hình được (xem `BROWSER_AUTOMATION.md`) |
| LinkedIn | 1 | OAuth | Cấu hình được; 60 ngày phải nối lại |
| Threads | ~15 | Threads API | Cấu hình được tay nhưng **chết sau 60 ngày** (T3); cần OAuth + refresh |
| Instagram | ~17 | Instagram API (tài khoản Professional) | Như Threads; chỉ đăng ảnh, cần `S3_PUBLIC_URL` https |
| Bluesky | 1 | App Password | Chạy được ~2 giờ (T1) → cần sửa connector |
| X | 1 | X API trả phí theo lượt | Chạy được ~2 giờ (T2) → cần sửa connector |
| WordPress.com | 4 | WordPress.com OAuth | **Chưa có connector** (C4) |
| Tumblr 5, Lemmy, Pixelfed, Reddit, Disqus, Scoop.it, Dailymotion, Eventbrite | ~12 | Có API | **Chưa có connector** |
| Forum Discourse bên thứ ba (NGINX, Caddy, TrueNAS...) | ~10 | Admin API key | Chỉ khi admin forum cấp key; thực tế → bàn giao thủ công |
| Medium 8, Substack 4, Quora, MeWe, DZone, daily.dev, Differ, Stack Exchange, các forum XenForo khác... | ~40 | Không có API phù hợp | Bàn giao thủ công (AI soạn, người bấm đăng) hoặc recipe browser khi được phép |

## 4. Kế hoạch thực hiện

Mỗi giai đoạn là một hoặc vài PR, có test, cập nhật tài liệu cùng PR. Ước lượng: **S** ≤ 1 ngày, **M** 2–3 ngày,
**L** ≥ 1 tuần.

### Giai đoạn 0 — Chốt phần đang làm (S)

- Commit Đợt A (diagnostics) và Đợt B (profile + proxy) của Playwright, mở PR.
- Sửa nhanh C1, C2, C3 (Mastodon instance, prefill Discourse, mặc định form), U7.
- Gỡ hoặc nối dây các biến env chết (C5) để không ai điền nhầm.

### Giai đoạn 1 — "Không trùng, không chết, có báo" (M–L) · **ưu tiên cao nhất**

1. **Ranh giới at-most-once cho mọi connector (Q1).** Phân biệt lỗi *trước* khi request rời máy (DNS, connect refused →
   retry an toàn) và *sau* khi đã gửi (timeout, reset, 5xx → `NEEDS_ACTION` + đối soát). Lỗi ở bước đọc permalink sau
   khi publish thành công chỉ ghi lại, không ném lỗi. Thêm idempotency key cho nền tảng hỗ trợ.
2. **Trung tâm sức khoẻ token (T1–T5).** Cron hằng ngày: refresh Instagram (`ig_refresh_token`), Threads
   (`th_refresh_token`), Google; gọi `testConnection` từng account; đánh dấu "sắp hết hạn" khi còn < 7 ngày; chỉ
   `invalid_grant` mới là `RECONNECT_REQUIRED`.
3. **Bluesky App Password (T1).** Lưu handle + App Password (mã hoá), connector tự `createSession` và dùng `refreshJwt`.
   Bluesky chính thức chấp nhận App Password cho bot.
4. **Kênh cảnh báo (O1, Q2).** `NotificationService` gửi Telegram/Slack webhook khi job `FAILED`/`NEEDS_ACTION`, account
   `RECONNECT_REQUIRED`, token sắp hết hạn, DLQ có message. Có gom nhóm (digest) để không spam.
5. **Graceful shutdown worker (Q3, Q5).** Huỷ consumer, chờ job đang chạy xong rồi mới đóng channel;
   `stop_grace_period` ≥ timeout browser; healthcheck worker bằng heartbeat Redis.
6. **Tạm giữ job khi account mất kết nối (Q4).** Job của account `RECONNECT_REQUIRED` chuyển sang trạng thái chờ và tự
   vào lại hàng đợi khi account kết nối lại, thay vì `FAILED` hàng loạt.

### Giai đoạn 2 — Kết nối thật toàn bộ kênh có API sẵn (M)

Theo [SOCIAL_API_SETUP_GUIDE.md](SOCIAL_API_SETUP_GUIDE.md), làm theo thứ tự rủi ro thấp → cao: dev.to → Mastodon/Vivaldi
→ Discord → Discourse VPSTTT → Blogger → LinkedIn → Threads → Instagram. Mỗi kênh qua checklist go-live ở cuối guide.
Song song:

- **Meta OAuth cho Threads và Instagram.** Với ~32 account, lấy token tay rồi 60 ngày lấy lại là không khả thi. Thêm
  provider OAuth `threads` và `instagram` (dùng `META_*` đang để trống), lưu token dài hạn và tự refresh (đi kèm mục 1.2).
- **Toggle "Đăng ngay" cho Blogger** trên UI (T7).
- **X:** chọn một trong hai: OAuth 1.0a user token (không hết hạn, hợp với 1 account của chính mình) hoặc OAuth 2.0 PKCE
  + `offline.access` + refresh. Đề xuất OAuth 1.0a cho nhanh.

### Giai đoạn 3 — Trải nghiệm vận hành (M)

- Banner + thẻ dashboard cho `NEEDS_ACTION`, `RECONNECT_REQUIRED`, token sắp hết hạn (U1, O3).
- Drawer chi tiết job: lịch sử attempt, lỗi đầy đủ, `diagnostics` của Playwright, nút tải screenshot/trace qua API có
  phân quyền (U2, O8; mount volume cho thư mục chẩn đoán).
- Trang chi tiết chiến dịch, lọc Publishing theo chiến dịch/nền tảng/account (U4).
- **Import hàng loạt account** (U5): endpoint/CLI nhận CSV, có dry-run, mã hoá từng dòng, chạy test hàng loạt. Dùng
  để đưa dữ liệu từ `auth_v2.csv` vào kho mã hoá rồi xoá file plaintext.
- **Đăng nhập Playwright từ xa trên UI** (U3): phiên Chromium headed trên server chiếu qua noVNC hoặc CDP screencast,
  người vận hành đăng nhập trong trình duyệt của mình; hết phụ thuộc CLI và O7.

### Giai đoạn 4 — Đăng "giống người", không giống bot (M)

- **Jitter + giãn cách theo nền tảng (S1, S2):** mỗi account lệch ngẫu nhiên trong một cửa sổ (ví dụ 5–90 phút), khoảng
  cách tối thiểu giữa 2 bài của cùng account, quota ngày theo nền tảng.
- **Biến thể theo account:** AI viết lại (paraphrase) cho từng account cùng nền tảng, kiểm tra độ trùng trước khi đăng.
- Khung giờ đăng theo múi giờ khán giả; lịch lặp.

### Giai đoạn 5 — Mở rộng phủ nền tảng (L)

Theo giá trị với danh sách tài khoản: **WordPress.com OAuth** (4 blog) → **Tumblr** (5) → Lemmy, Pixelfed → Reddit,
TikTok (chỉ sau khi được nền tảng duyệt). Media: ảnh cho Mastodon/Bluesky/X/LinkedIn/WordPress, FFmpeg chuyển JPEG cho
Instagram, video sau. Playwright: Đợt C–G (selector bền, browser pool, session health, ảnh, integration test thật).

### Giai đoạn 6 — Hạ tầng và bảo mật (M)

Keyring cho khoá mã hoá + CLI mã hoá lại (O4); backup `pg_dump` mã hoá + `mc mirror` theo lịch (O5); CI có Postgres
thật + `prisma migrate diff`, tách bước migrate khỏi API (O6); build `dist/cli.js` cho image production (O7); `/ready`
trả 503 đúng (O2); log JSON có cấu trúc + `/metrics`.

## 5. Đề xuất giải pháp đáng làm nhất

1. **"Token Health Center"**: một bảng duy nhất cho mọi account với hạn token, lần test cuối, nút refresh/nối lại; cron
   tự refresh và cảnh báo trước 7 ngày. Giải quyết gốc rễ chuyện "connector có mà không chạy".
2. **At-most-once theo ranh giới nhà cung cấp**: thà một bài cần người xác nhận còn hơn đăng 2 lần trên 30 account.
3. **Một kênh Telegram vận hành**: báo ngay khi có việc cần người, tóm tắt cuối ngày (đã đăng / cần xử lý / lỗi).
4. **Chống "trại bot" bằng thiết kế**: jitter + biến thể riêng từng account + quota ngày. Đây là yếu tố quyết định
   58 account Instagram/Threads có sống lâu hay không, quan trọng hơn mọi kỹ thuật trình duyệt.
5. **Import CSV có dry-run → kho mã hoá → xoá file plaintext**: vừa nhanh vừa đóng lỗ hổng `auth_v2.csv`. Sau khi
   import, đổi các mật khẩu/app password từng nằm trong file.
6. **Đăng nhập Playwright trên UI**: người vận hành tự xử lý 2FA/CAPTCHA trong trình duyệt của mình, không cần shell.
