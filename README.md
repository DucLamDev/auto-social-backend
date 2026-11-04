# Social Publisher Backend

Backend độc lập cho nền tảng phân phối nội dung đa kênh. Repository này là nguồn sự thật của REST/OpenAPI; frontend chỉ giao tiếp qua `/api/v1` và không truy cập database, queue hoặc social credential.

Kiểm tra đăng nhập CSV, đăng nhập thủ công trong đúng profile và tái sử dụng session được mô tả tại
[AUTH_RECOVERY.md](AUTH_RECOVERY.md#đăng-nhập-từ-danh-sách-csv-và-giữ-phiên-cục-bộ). Công cụ smoke chỉ kiểm tra
login; đăng bài dùng connector/publisher tương ứng khi có credential và hạ tầng backend hoạt động.

Kiểm thử X bằng Chrome đã cài trên máy Windows 10: [WINDOWS_X_LOGIN.md](WINDOWS_X_LOGIN.md).

**Đăng diễn đàn bằng tiện ích Chrome (XenForo, Discourse, phpBB): [BROWSER_EXTENSION_CHROME.md](BROWSER_EXTENSION_CHROME.md).**

**Hướng dẫn test thực tế chi tiết trên máy Windows: [HUONG_DAN_TEST_THUC_TE.md](HUONG_DAN_TEST_THUC_TE.md).**

**Hướng dẫn dựng và test từng bước: [TESTING.md](TESTING.md).** Sau khi dựng, `pnpm smoke:stack` kiểm tra nhanh API, hạ tầng, đăng nhập, OAuth và việc cần xử lý.

## Trạng thái MVP

- NestJS 11, TypeScript strict, PostgreSQL/Prisma, RabbitMQ, Redis, MinIO/S3.
- JWT access token + rotating refresh session, RBAC `ADMIN | EDITOR | VIEWER`.
- Redis auth throttle: login theo IP `100/15 phút` và normalized-email hash `10/15 phút`; refresh theo IP `180/15 phút`.
- Credential và OAuth token mã hóa AES-256-GCM; không trả secret qua API.
- Nguồn `URL | RSS | SITEMAP | WORDPRESS | MANUAL`, sanitize HTML; crawler và các connector dùng base URL động đều có SSRF guard, DNS validation/pinning và kiểm tra redirect.
- AI đa provider (`openai | deepseek | gemini`) với structured output và kiểm tra schema; prompt SEO/theo ngữ cảnh từng destination được lưu trong database.
- Campaign → target → publish job; scheduler, retry 30s/120s/600s, DLQ, per-job lock, cross-job fingerprint lock (`account + content hash`), rate limit và idempotency key.
- Catalog có **65 destination duy nhất**, gom trong 8 nhóm `SOCIAL | BLOGGING | COMMUNITY | FORUM | DEVELOPER | MEDIA | COMMERCE | EVENT`. API `GET /api/v1/platforms` hỗ trợ phân trang, tìm kiếm và lọc theo nhóm/chế độ/mức hỗ trợ/trạng thái bật.
- Connector tự động MVP: Instagram (một ảnh), Threads (text/một ảnh), X (text), LinkedIn (text), WordPress (article), Blogger (article), dev.to (article), Discourse (topic text/article), Discord (text), Bluesky (text, App Password), Mastodon (text), Tumblr (text, OAuth2 tự làm mới). Nhiều instance cùng engine dùng lại connector Discourse hoặc Mastodon bằng base URL riêng.
- Medium, Reddit, TikTok và các destination không có create API phù hợp chạy bàn giao `MANUAL/NEEDS_ACTION`: AI vẫn tạo nội dung và giữ media để người dùng copy/mở editor/xác nhận kết quả. Hệ thống không bypass CAPTCHA, 2FA, anti-bot hay chính sách nền tảng.
- OAuth hoàn chỉnh cho LinkedIn, Google→Blogger, Instagram (Instagram Login), Threads và Tumblr: bấm **Kết nối** một lần, token Instagram/Threads/Blogger/Tumblr được tự gia hạn. Provider khác hiển thị rõ `API_REVIEW_REQUIRED`, `API_RESEARCH_REQUIRED` hoặc `MANUAL`.
- `src/account-health`: cron gia hạn token Meta, kiểm tra kết nối hằng ngày, cảnh báo qua `ALERT_WEBHOOK_URL`; `GET /api/v1/account-health` cấp dữ liệu cho bảng **Cần xử lý**.

Các connector chưa được coi là “đã kiểm chứng production” cho đến khi chạy integration test bằng app/account thật. Xem [DEVELOPMENT_PLAN.md](DEVELOPMENT_PLAN.md).

## Chạy local

Luồng AI chạy ngầm: `POST /campaigns/automate` lưu tác vụ vào database và trả về ngay. Cron của API xử lý lần lượt dưới Redis lease, khôi phục tác vụ sau khi API khởi động lại. Mỗi kênh viết xong (và có ảnh, nếu kênh đó có ảnh) là **duyệt được ngay** trong lúc AI viết tiếp các kênh khác: `POST /campaigns/:id/variants/:variantId/approve` hoặc `POST /campaigns/:id/approve` (duyệt mọi bài đã sẵn sàng) tạo publish jobs và kích hoạt chiến dịch, bài tự đăng không cần bấm thêm. Body nhận `publishMode: NOW` hoặc `publishMode: SCHEDULED` kèm `scheduledAt` trong tương lai. Bài có ảnh đang tạo (`mediaRecommendation.status` = `pending` / `generating`) chưa duyệt được. Lượt kết thúc ở `WAITING_REVIEW` nếu còn bài chờ, hoặc `APPROVED` / `REJECTED` khi mọi bài đã được quyết. Gửi `autoPublish: true` khi tạo thì bài AI tự chấm đạt được duyệt và đăng ngay khi xong, bài chưa đạt vẫn chờ duyệt. `/reject` từ chối các bài còn chờ; `/retry-generation` đưa lượt lỗi trở lại hàng đợi. Cần chạy migration `20261102100000_background_ai_review` trước khi khởi động mã mới (Compose tự chạy `prisma:deploy`).

Blogger và dev.to đăng thật bài đã duyệt (từ 1.12.0, migration `20261104090000_publish_blogger_devto_live` chuyển các tài khoản cũ); muốn chỉ lưu nháp thì đổi ở từng tài khoản (Tài khoản → Đăng ngay / Lưu nháp).

Khôi phục khi từ chối nhầm: `POST /campaigns/:id/restore` đưa các bài đã từ chối về chờ duyệt; `POST /campaigns/:id/variants/:variantId/restore` khôi phục riêng một bài. Chỉ ADMIN/EDITOR sở hữu chiến dịch được gọi. Nội dung và ảnh giữ nguyên, không gọi AI hay tạo việc đăng; bài đã gắn vào đích đăng không được khôi phục. Hỗ trợ cả lượt cũ chỉ lưu trạng thái từ chối ở cấp chiến dịch. Sau khôi phục, người dùng sửa và duyệt/hẹn lịch lại theo luồng hiện có.


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

VPSTTT_AI_BASE_URL=https://<ide-host>/ai-api/v1
VPSTTT_AI_API_KEY=
VPSTTT_AI_MODEL=claude:sonnet
VPSTTT_AI_TIMEOUT_MS=180000
VPSTTT_AI_MAX_CONCURRENCY=2
VPSTTT_AI_RPM=10
```

`AI_DEFAULT_PROVIDER` nhận `openai`, `deepseek`, `gemini` hoặc `vpsttt`. Studio và luồng **Tạo tự động** cho phép chọn provider cho từng lần sinh nội dung; nếu request không chỉ định, backend dùng provider mặc định. Giao diện chỉ nhận trạng thái đã cấu hình và tên model từ `GET /api/v1/ai/providers`, không nhận API key đã lưu. Provider chưa có key sẽ bị vô hiệu hóa trong danh sách chọn. Các biến `*_MODEL` do backend kiểm soát, người dùng không gửi model tùy ý từ trình duyệt.

**VPSTTT AI** là mục **AI API** của IDE công ty: tạo key trong IDE (khai báo IP công khai của máy chạy backend, quyền
sinh nội dung, hạn mức), dán địa chỉ hiện trong mục đó vào `VPSTTT_AI_BASE_URL` (chỉ nhận https; http chỉ cho máy thử
`127.0.0.1` ngoài production). API này chỉ nhận `model`, `messages` dạng chữ và `stream=false`, tối đa 100.000 ký tự mỗi
lượt; backend đưa khuôn JSON vào lời dặn hệ thống, cắt phần nhập quá dài, bóc JSON khỏi khối code và kiểm tra lại như
các provider khác. Mỗi lượt chạy một phiên Claude/Codex nên chậm: backend giới hạn `VPSTTT_AI_MAX_CONCURRENCY` lượt cùng
lúc và rải đều `VPSTTT_AI_RPM` lượt mỗi phút, đặt hai số này không vượt hạn mức của key (mặc định của IDE: 2 và 10). Một
bài cho mỗi nền tảng cần 2–7 lượt (viết, chấm, viết lại tối đa 2 lần khi chưa đạt, thêm 1 lượt rút gọn khi còn quá dài; giữ bản điểm cao nhất), nên với 10
lượt/phút nên chọn khoảng 6–8 nền tảng mỗi lần tạo tự động. Model: `claude:haiku` (nhanh), `claude:sonnet`, `claude:opus`, `gpt:`.

**Giới hạn ký tự (từ backend 1.17.0).** Một hàm đếm chung (`src/platforms/post-length.ts`) được dùng ở mọi chỗ:
khi AI viết, khi duyệt, khi sửa, khi giao bài cho tiện ích và trong connector API. Nên bài vừa ở đây là vừa trên trang:
- Ngân sách trong lời nhắc đã trừ dòng "Nguồn"; hashtag và link đều được tính.
- Mastodon / Vivaldi tính mỗi link 23 ký tự. X tính cả tên miền viết trần (`example.com/x`) là 23.
- Dòng "Nguồn" không thêm lần nữa khi bài đã có link đó. Nơi không có ô tiêu đề (Quora) thì không lấy dòng đầu làm tiêu đề.
- Viết lại 2 lần mà vẫn dài: AI rút gọn thêm 1 lần theo đúng số ký tự. Vẫn dài thì máy cắt:
  1. bỏ bớt hashtag cuối bài;
  2. cắt sau câu trọn vẹn cuối cùng còn vừa;
  3. bất đắc dĩ thì cắt sau từ, thêm "…".
- Bài bị máy cắt luôn chờ người duyệt, có ghi chú trong lý do. Bản dài hơn giới hạn luôn xếp dưới mọi bản vừa.
- Duyệt / sửa / tạo tay một bài vượt giới hạn: trả 400 kèm số ký tự. "Duyệt tất cả" giữ bài quá dài ở chờ duyệt, trả về
  `overLimitVariants`, các bài khác vẫn đăng.
- Tiện ích không bao giờ nhận bài quá dài: job chuyển "Tiện ích cần bạn" (`EXTENSION_CONTENT_TOO_LONG`), các bài sau vẫn
  chạy. Rút gọn rồi bấm **Giao lại cho tiện ích**.

**Chấm điểm và viết lại từng bài.** Người viết được dặn đúng thang chấm của biên tập AI:
- mở bài giữ chân người đọc;
- chi tiết cụ thể;
- hợp cộng đồng nơi đăng;
- tự nhiên, không câu sáo;
- riêng Stack Exchange là câu hỏi kỹ thuật thật.

Bài đạt từ 7/10. Ở Content đợi duyệt:
- bài chưa đạt (hoặc bất kỳ bài chờ duyệt nào) có thể **viết lại bằng AI** kèm hướng dẫn của bạn qua
  `POST /api/v1/content-variants/{id}/rewrite` (`instruction`, tuỳ chọn `aiProvider`);
- **sửa theo khuyến nghị**: gửi thêm `notes` (mảng, tối đa 20 mục, mỗi mục tối đa 1.000 ký tự) là các khuyến nghị
  bạn chọn trong ghi chú chấm điểm. Khi có `notes`, AI chỉ sửa theo các mục đó thay vì toàn bộ ghi chú lần chấm trước;
  `notes` rỗng thì phải có `instruction`;
- việc này chạy nền 1–3 phút. Trạng thái nằm ở trường `aiRevision` của biến thể (`generating`, `done`, `failed`);
- bài mới thay bài cũ tại chỗ, được chấm lại; bài đã duyệt nhưng chưa vào chiến dịch quay về chờ duyệt;
- bạn sửa tay trong lúc AI đang viết thì giữ bản bạn sửa.

**Ảnh AI cho chiến dịch** (từ backend 1.7.0) dùng cùng địa chỉ và key VPSTTT AI, gọi `POST /images/generations` với
model `vpsttt-image`; key phải được quản trị cấp thêm quyền **image**. Chỉ kênh mà đường đăng gửi được ảnh mới có ảnh,
mỗi kênh một ảnh riêng: Pixelfed (bắt buộc), Bluesky, Mastodon / Vivaldi, Tumblr, LinkedIn qua tiện ích Chrome; X, Discord,
dev.to (ảnh bìa), Threads, Instagram qua API. Diễn đàn và các kênh khác chỉ đăng chữ, và AI được dặn không nhắc tới ảnh
trong bài chữ. AI viết bài viết luôn mô tả ảnh (tiếng Anh, không chữ, không logo, không người thật) theo khổ và phong cách
của kênh (vuông cho Pixelfed, Instagram, Threads; ngang cho các kênh còn lại), rồi backend tạo ảnh và gắn vào biến thể
trước khi chờ duyệt. Ảnh lỗi không làm mất bài chữ; riêng kênh bắt buộc ảnh thì bài chờ duyệt tay. Bạn tự tải ảnh lên thì
ảnh đó dùng thay ảnh AI. Ở tab Content đợi duyệt có thể tạo lại (`POST /api/v1/content-variants/{id}/image`, chạy nền),
bỏ (`DELETE /api/v1/content-variants/{id}/image/{mediaId}`) hoặc thay ảnh. Bài chưa có ảnh cũng tạo được bằng lệnh tạo lại
đó: không gửi `prompt` thì AI tự thiết kế mô tả ảnh từ nội dung bài rồi tạo ảnh. Trạng thái: `GET /api/v1/ai/image-status`.
Mỗi ảnh mất khoảng 30 giây đến 2 phút; `VPSTTT_AI_IMAGE_CONCURRENCY` (mặc định 1) và `VPSTTT_AI_IMAGE_RPM` giữ trong hạn
mức của key; `AI_IMAGE_ENABLED=false` tắt hẳn ảnh AI.

ADMIN có thể vào **Cài đặt → API key Gemini** để lưu tối đa 10 key, áp dụng ngay cho lần tạo nội dung tiếp theo. Key cũ trong `GEMINI_API_KEY` được giữ ở ô 1 cho đến khi lưu cấu hình trên web; các ô để trống giữ nguyên key đã lưu, nút Xóa loại bỏ key khi lưu. Backend mã hóa danh sách trong `SystemSetting`, chỉ trả trạng thái từng ô qua `GET /api/v1/ai/gemini-keys`; cập nhật bằng `PUT` cùng đường dẫn. Khi gặp quota/giới hạn (429 hoặc 402), hệ thống chuyển sang key tiếp theo, nhớ key thành công và tạm bỏ qua key vừa lỗi ít nhất 60 giây (tôn trọng `Retry-After` dài hơn). Mỗi yêu cầu thử mỗi key tối đa một lần; nếu tất cả bị giới hạn thì trả lỗi rõ ràng. Các key cùng Google Cloud project dùng chung quota: https://ai.google.dev/gemini-api/docs/rate-limits.

### Luồng một lần nhập

Tại **Chiến dịch → Tạo tự động**, người dùng nhập mô tả bài đăng, có thể đính kèm một ảnh và alt text, chọn AI provider cùng các destination, rồi chọn chạy ngay hoặc lên lịch. Backend tạo canonical content, sinh một variant riêng theo prompt/capability của từng platform, gắn media, tự duyệt variant và tạo publish job. Không dùng cùng một nội dung thô cho mọi kênh. Một lần automation nhận tối đa 12 platform khác nhau; chia thành nhiều campaign khi cần phân phối rộng hơn.

Kết quả phụ thuộc loại connector:

- `OFFICIAL_API`/`COMPATIBLE_API`: worker gọi API thật; thành công trực tiếp là `PUBLISHED`. Bài draft hoặc topic đi qua moderation có thể là `NEEDS_ACTION` dù request API đã thành công.
- `MANUAL`: worker tuyệt đối không mô phỏng đăng nhập. Job chủ động dừng ở `NEEDS_ACTION`; `GET /api/v1/publish-jobs/:id/manual-payload` trả title/body/hashtags/canonical URL/media và editor URL để giao diện **Copy & mở**. Sau khi người dùng đăng thật, endpoint mark-published lưu external ID/URL và chuyển job sang `PUBLISHED`.
- Media chỉ được gửi khi connector khai báo capability phù hợp. Với kênh manual, media vẫn nằm trong handoff để người dùng tải/chèn bằng editor chính thức.

### Chất lượng nội dung AI

Mỗi bài AI viết đi qua bốn lớp kiểm soát:

1. **Quy cách nơi đăng.** Phần này do mã tự ghép vào prompt, lấy từ `src/platforms/platform-contract.ts`. Gồm:
   - Ngôn ngữ người đọc: diễn đàn và cộng đồng lập trình quốc tế dùng tiếng Anh; Tinhte và Voz dùng tiếng Việt; các nơi còn lại theo ngôn ngữ của mô tả.
   - Định dạng: Markdown, văn bản thường, hoặc HTML cho WordPress / Blogger.
   - Giới hạn ký tự, tính cả hashtag và link. X tính chữ có dấu tiếng Việt là 2 ký tự.
   - Cách dùng hashtag và việc có cần tiêu đề hay không.
2. **Hồ sơ thương hiệu.** ADMIN lưu một lần bằng `PUT /api/v1/settings/ai.brand-profile`, body `{ "value": { … } }`. Các trường:
   - `brandName`, `oneLiner`, `audience`, `voice`
   - `facts[]`: sản phẩm, số liệu, bằng chứng có thật
   - `links[]`: mỗi mục gồm `label` và `url`
   - `disclosure`: câu tự giới thiệu khi đăng diễn đàn
   - `avoid[]`: điều cấm nói
   - `defaultLanguage`: `vi` hoặc `en`
   - `platformLanguages`: ngôn ngữ riêng theo nền tảng, ví dụ `{ "quora": "vi" }`

   Thông tin về thương hiệu (giá, số liệu, khách hàng, ưu đãi) chỉ được lấy từ mô tả hoặc hồ sơ này. Hồ sơ thiếu hay sai thì bị bỏ qua và ghi cảnh báo, không chặn việc tạo bài.
3. **Kiểm tra máy.** Kiểm độ dài sau khi dựng văn bản cuối, đúng ngôn ngữ, đủ tiêu đề, không còn Markdown ở nơi cần HTML, số hashtag và câu sáo.
4. **AI chấm điểm.** AI chấm từ 1 đến 10 cho câu mở đầu, độ cụ thể, độ hợp nền tảng và độ tự nhiên, rồi liệt kê các thông tin chưa có căn cứ.
   - Đạt khi điểm từ 7 trở lên, đúng ngôn ngữ và không có thông tin chưa có căn cứ.
   - Chưa đạt thì AI viết lại đúng một lần.
   - Vẫn chưa đạt, hoặc AI tự đánh giá bài không hợp nơi đăng: biến thể giữ `recommended=false` cùng nhận xét. Job chuyển `NEEDS_ACTION` với mã `CONTENT_REVIEW_REQUIRED`, không tự đăng.
   - Người vận hành duyệt bằng `POST /api/v1/publish-jobs/:id/approve-content`, có thể kèm `title`, `body`, `hashtags` đã sửa. Hệ thống tạo phiên bản biến thể mới đã duyệt và xếp lịch lại job. Không có gì đã gửi đi nên không lo đăng trùng.

Mỗi nền tảng tốn từ 2 lượt gọi AI (viết và chấm) tới 4 lượt (khi phải viết lại). Lỗi tạm thời của nhà cung cấp AI (429, 5xx, hết thời gian, JSON sai) được thử lại một lần sau 2 giây. Nếu chỉ riêng bước chấm lỗi, bài vẫn được lưu với ghi chú "AI chưa chấm được" và vẫn qua kiểm tra máy.

Prompt mặc định hiện là phiên bản 3 (`src/prompts/default-prompts.ts`). Cài mới thì seed tạo sẵn. Với database đang chạy, đồng bộ riêng prompt mà không chạy lại seed:

```powershell
Get-Content scripts/sync-ai-prompts.cjs -Raw -Encoding UTF8 | docker compose exec -T api node -
Get-Content scripts/sync-ai-prompts.cjs -Raw -Encoding UTF8 | docker compose exec -T api node - --apply
# Quay lại prompt cũ nếu cần:
Get-Content scripts/sync-ai-prompts.cjs -Raw -Encoding UTF8 | docker compose exec -T api node - --rollback 2 --apply
```

- Lệnh đầu chỉ xem trước. `--apply` tạo hoặc cập nhật bản v3 rồi bật nó lên; các bản cũ chỉ bị tắt, không bị xoá.
- Nếu một phiên bản cùng số đã được tạo trên web, script dừng lại, không ghi đè.

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

### Codex điều phối hệ thống qua MCP

Backend có endpoint MCP (Model Context Protocol) tại `POST /mcp` (cùng host với API, ngoài tiền tố `api/v1`, không có
trong Swagger) để Codex hoặc agent khác xem và điều phối hệ thống bằng chat. Mặc định tắt (`MCP_ENABLED=false`).

1. Bật `MCP_ENABLED=true` trong `.env` backend, khởi động lại `api`.
2. Tạo token trong container API (in ra một lần, chỉ lưu mã băm):
   `pnpm mcp:token create --email <email ADMIN/EDITOR> --name codex` (thêm `--read-only` nếu chỉ cho xem,
   `--expires-days 90` để hết hạn). Xem / thu hồi: `pnpm mcp:token list|revoke --email … [--id …]`.
3. Trên máy chạy Codex, đặt token vào biến môi trường `AUTO_SOCIAL_MCP_TOKEN` và thêm vào `~/.codex/config.toml`:

   ```toml
   [mcp_servers.auto_social]
   url = "https://api.example.com/mcp"
   bearer_token_env_var = "AUTO_SOCIAL_MCP_TOKEN"
   ```

   hoặc `codex mcp add auto_social --url https://api.example.com/mcp --bearer-token-env-var AUTO_SOCIAL_MCP_TOKEN`.

Công cụ (quyền giống API web của chủ token, chỉ trả dữ liệu không bí mật): `list_accounts`, `list_extension_devices`,
`list_login_checks`, `queue_login_checks` (ADMIN), `list_publish_jobs`, `get_publish_job`, `retry_publish_job`,
`requeue_extension_job`, `list_campaigns`, `get_campaign`, `ai_providers`, `list_selector_suggestions`,
`approve_selector_suggestion` / `reject_selector_suggestion` (ADMIN), `create_ai_campaign_draft` (AI viết bài,
dừng ở chờ duyệt, tối đa 10 lần/giờ). `approve_campaign` (duyệt và đăng thật) chỉ xuất hiện khi `MCP_ALLOW_PUBLISH=true`,
bắt `confirm: true`, tối đa 5 lần/giờ. Lệnh ghi cần token có quyền `write` và vai trò ADMIN/EDITOR; mọi lệnh ghi, kể cả
bị từ chối, được ghi `AuditLog` (`MCP_<TÊN_CÔNG_CỤ>`, không lưu tham số). Mỗi token tối đa `MCP_RATE_LIMIT_PER_MINUTE`
lượt/phút; trình duyệt chỉ gọi được từ origin trong `FRONTEND_URL`.

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
| `src/account-health` | Gia hạn token Meta, kiểm tra kết nối định kỳ, tổng hợp việc cần xử lý, cảnh báo webhook | Chạy trong process API (cron + khoá Redis); dùng `ConnectorAccountsService` và `MetaTokenService` |
| `src/extension-agent`, `src/connectors/extension`, `browser-extension/` | Tiện ích Chrome: ghép nối thiết bị, nhận bài, báo kết quả; bộ chỉ dẫn form theo loại diễn đàn | Tài khoản bật `delivery=extension` đi qua `ExtensionConnector`; tiện ích gọi `/api/v1/extension/agent/*` |
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
  (hoặc nhập cả loạt bằng file: mục **Nhập nhiều tài khoản bằng file**, `POST /api/v1/platform-accounts/import-api`)
- [OPERATIONS_REVIEW.md](OPERATIONS_REVIEW.md) — rà soát vận hành và kế hoạch hoàn thiện
- [DISCOURSE_CONFIGURATION.md](DISCOURSE_CONFIGURATION.md)
- [BROWSER_AUTOMATION.md](BROWSER_AUTOMATION.md)
- [AUTH_RECOVERY.md](AUTH_RECOVERY.md) — persistent profile, CAPTCHA/2FA thủ công, OTP nhập ẩn và CLI `pnpm bot`
- [EXTENDED_PLATFORM_CATALOG.md](EXTENDED_PLATFORM_CATALOG.md)
- [DEVELOPMENT_PLAN.md](DEVELOPMENT_PLAN.md)
