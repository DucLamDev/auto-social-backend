# Hướng dẫn test từng bước

Làm theo thứ tự A → F. Mỗi bước có **Kết quả đúng** để so. Không dán mật khẩu, token, App Secret vào chat, ticket
hay tài liệu; chỉ nhập vào `.env` của máy test hoặc form trên giao diện.

| Bước | Cần gì | Thời gian |
|---|---|---|
| A. Kiểm tra mã | Node 22 + Corepack | 5 phút |
| B. Dựng hệ thống | Máy có Docker (Docker Desktop trên Windows/macOS hoặc Linux) | 15 phút |
| C. Kênh không cần duyệt app | Discord, Bluesky, dev.to | 15 phút |
| D. Threads, Instagram, Tumblr | Tên miền **HTTPS công khai** + app Meta/Tumblr | 1–2 giờ lần đầu |
| E. Tự gia hạn, cảnh báo | Webhook kênh chat (tuỳ chọn) | 15 phút |
| F. Chống đăng trùng | Không bắt buộc | 10 phút |

## A. Kiểm tra mã (không cần database)

```bash
# backend
corepack pnpm install
corepack pnpm prisma:generate
corepack pnpm lint && corepack pnpm typecheck && corepack pnpm test && corepack pnpm build
# frontend (repo auto-social-frontend)
corepack pnpm install
corepack pnpm lint && corepack pnpm typecheck && corepack pnpm test && corepack pnpm build
```

**Kết quả đúng:** backend `Tests: 527 passed`, frontend `Tests 140 passed`, hai lệnh build không lỗi.

## B. Dựng hệ thống trên máy có Docker

1. Backend: `cp .env.example .env` (PowerShell: `Copy-Item .env.example .env`) rồi sửa trong `.env`:
   - `CREDENTIAL_ENCRYPTION_KEY`: dán kết quả `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`.
     Giữ cố định; đổi key là mất toàn bộ credential đã lưu.
   - `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`: hai chuỗi ngẫu nhiên ≥ 32 ký tự.
   - Đổi mọi giá trị `change_me`; đặt `SEED_ADMIN_EMAIL`, `SEED_ADMIN_PASSWORD` (≥ 12 ký tự).
   - Ít nhất một AI key (`DEEPSEEK_API_KEY`, `OPENAI_API_KEY` hoặc `GEMINI_API_KEY`) để luồng **Tạo tự động** viết bài.
2. Chạy:
   ```bash
   docker compose up -d --build --wait
   docker compose exec api corepack pnpm prisma:seed
   ```
   Seed cũng cập nhật danh mục nền tảng (Tumblr chuyển sang kết nối API). Chạy lại seed sau mỗi lần cập nhật mã.
3. Kiểm tra nhanh (mật khẩu chỉ nằm trong biến môi trường của phiên terminal):
   ```bash
   export SMOKE_EMAIL='<SEED_ADMIN_EMAIL>'
   read -rs SMOKE_PASSWORD && export SMOKE_PASSWORD   # gõ mật khẩu, không hiện ra
   corepack pnpm smoke:stack
   ```
   **Kết quả đúng:** các dòng `✓ API đang chạy`, `✓ PostgreSQL, Redis, RabbitMQ`, `✓ Đăng nhập — vai trò ADMIN`,
   `✓ Tài khoản đích — chưa có tài khoản nào`, cuối cùng `Tất cả mục đạt.`
4. Frontend: tạo `.env` có `NEXT_PUBLIC_API_URL=http://localhost:3001`, chạy `corepack pnpm dev`, mở
   <http://localhost:3000>, đăng nhập bằng tài khoản seed.
   **Kết quả đúng:** Dashboard có bảng **Cần xử lý** ghi "Ổn định"; chuông trên cùng không có số.

## C. Kênh không cần duyệt app (test luồng đăng trọn vẹn)

Làm ít nhất một kênh để chứng minh: AI viết bài → xếp lịch → worker đăng → có link bài thật.

| Kênh | Lấy gì | Nhập ở đâu |
|---|---|---|
| Discord | Server Settings → Integrations → Webhooks → New Webhook → Copy URL (server test riêng) | Tài khoản → Kết nối / cấu hình → Discord |
| Bluesky | bsky.app → Settings → Privacy and security → App passwords → Add | Form Bluesky: Handle + App Password |
| dev.to | dev.to → Settings → Extensions → API key; lần đầu **tắt** Publish ngay (tạo nháp) | Form dev.to |

1. **Lưu & kiểm tra** → dòng tài khoản chuyển **Đã kết nối**.
2. **Chiến dịch → Tạo tự động**: mô tả ngắn có chữ `[TEST]`, chọn AI provider, chọn tài khoản vừa nối, **Chạy ngay**.
3. Mở **Publishing**: job đi `QUEUED → PUBLISHING → PUBLISHED` (dev.to nháp: `NEEDS_ACTION`), có link bài.
4. Mở link, kiểm tra bài rồi xoá tay.

**Kết quả đúng:** có ít nhất một bài thật xuất hiện trên kênh; `pnpm smoke:stack` báo `CONNECTED 1` trở lên.

## D. Threads, Instagram, Tumblr (đăng nhập một lần, tự gia hạn)

Meta và Tumblr bắt buộc redirect URL **HTTPS** và ảnh ở URL **HTTPS công khai**, nên bước này làm trên máy chủ có tên
miền (ví dụ `https://api.<tên-miền>`, `https://app.<tên-miền>`). Trong `.env` backend đặt `OAUTH_REDIRECT_BASE_URL`,
`FRONTEND_URL`, `S3_PUBLIC_URL` theo tên miền đó.

1. Tạo app và lấy khoá theo [SOCIAL_API_SETUP_GUIDE.md](SOCIAL_API_SETUP_GUIDE.md): Threads mục 7, Instagram mục 8,
   Tumblr mục 13. Redirect URL đăng ký phải khớp **tuyệt đối**:
   - `https://api.<tên-miền>/api/v1/oauth/threads/callback`
   - `https://api.<tên-miền>/api/v1/oauth/instagram/callback`
   - `https://api.<tên-miền>/api/v1/oauth/tumblr/callback`
2. Nhờ quản trị đặt `THREADS_APP_ID/SECRET`, `INSTAGRAM_APP_ID/SECRET`, `TUMBLR_CLIENT_ID/SECRET` ở Bí mật của dự án,
   rồi khởi động lại `api` và `worker`. `pnpm smoke:stack` phải báo `sẵn sàng: … threads, instagram, tumblr`.
3. Khi app Meta chưa qua App Review: thêm từng account vào **App roles → Testers** và account đó chấp nhận lời mời
   (hướng dẫn mục 7–8). Instagram phải là tài khoản Business/Creator.
4. Trên trình duyệt đang đăng nhập đúng account: **Tài khoản → Kết nối / cấu hình → Threads → Kết nối** → đồng ý.
   **Kết quả đúng:** quay về trang Tài khoản, thông báo "Đã kết nối Threads thành công", dòng mới `@username`,
   cột *Kiểu kết nối* ghi **Token tự gia hạn**. Lặp lại cho account khác (đăng xuất hoặc dùng cửa sổ ẩn danh).
5. Bấm **Test** trên dòng đó → "Kết nối hoạt động tốt".
6. Đăng thử: **Tạo tự động** với tài khoản Threads (chữ, có thể kèm ảnh JPEG) và Instagram (**bắt buộc có ảnh JPEG**).
   **Kết quả đúng:** job `PUBLISHED` kèm link `threads.com/...` / `instagram.com/p/...`; bài hiện trên profile.
7. Tumblr: mỗi blog của account thành một dòng; công tắc **Đăng ngay / Lưu nháp** ở cột *Kiểu kết nối*.
8. Thử lỗi: bấm Kết nối rồi **Huỷ** trên trang Meta → quay về trang Tài khoản với thông báo đỏ nêu lý do, không hiện
   trang JSON.

## E. Tự gia hạn token và cảnh báo

1. (Tuỳ chọn) Đặt `ALERT_WEBHOOK_URL` = webhook một kênh Slack/Google Chat/Discord test, khởi động lại `api`.
   Dashboard → **Cần xử lý** phải ghi "Cảnh báo cũng được gửi về kênh chat đã cấu hình".
2. **Tài khoản → Kiểm tra tất cả** (ADMIN): thông báo "Đã kiểm tra N tài khoản, gia hạn M token".
3. Giả lập tài khoản bị thu hồi: trên Threads vào **Settings → Account → Website permissions → Active** → gỡ app →
   bấm lại **Kiểm tra tất cả**.
   **Kết quả đúng:** dòng đó chuyển **Cần kết nối lại**; Dashboard → Cần xử lý liệt kê nó; chuông hiện số; kênh chat
   nhận tin "Kiểm tra kết nối hằng ngày phát hiện lỗi". Bấm **Kết nối lại** trên dòng để nối lại.
4. Gia hạn tự động chạy mỗi giờ khi token còn dưới 15 ngày, nên với token mới (60 ngày) sẽ chưa thấy gia hạn ngay.
   Muốn thấy sớm **trên database test** (không làm ở production), sau khi kết nối ít nhất 24 giờ:
   ```sql
   UPDATE oauth_tokens SET "expiresAt" = now() + interval '10 days'
   WHERE "platformAccountId" = '<id tài khoản Threads>';
   ```
   rồi bấm **Kiểm tra tất cả** → "gia hạn 1 token"; token mới có hạn khoảng 60 ngày kể từ hôm nay.
5. Lịch tự chạy (múi giờ máy chủ): gia hạn Meta mỗi giờ; kiểm tra kết nối 03:15; nhắc token LinkedIn 08:00;
   báo bài bị kẹt mỗi 5 phút (mỗi bài một lần).

## F. Chống đăng trùng (không bắt buộc)

Khi Meta/Tumblr không trả lời ở đúng bước đăng (timeout, lỗi 5xx), hệ thống **không tự đăng lại** mà đưa job về
**Cần thao tác**. Trên **Publishing**: mở profile kiểm tra; nếu bài đã lên thì bấm **Đã đăng** và dán link; nếu chưa
thì bấm xác nhận "không tìm thấy" để hệ thống đăng thêm đúng một lần. Kiểm tra bằng unit test:
`corepack pnpm test -- meta-connectors tumblr`.

## G. Diễn đàn bằng tiện ích Chrome (XenForo, Discourse, phpBB)

Làm trên máy Windows/macOS có Chrome đã đăng nhập diễn đàn; backend có thể ở máy chủ. Chi tiết:
[BROWSER_EXTENSION_CHROME.md](BROWSER_EXTENSION_CHROME.md).

1. **Tài khoản → Ghép nối Chrome → Tạo mã**, cài tiện ích (`chrome://extensions` → Load unpacked thư mục
   `browser-extension`), dán địa chỉ API + mã vào Cài đặt của tiện ích, bấm **Cấp quyền diễn đàn**.
   **Kết quả đúng:** trang Tài khoản hiện tên Chrome với chấm xanh "đang chạy".
2. Tạo tài khoản diễn đàn (ví dụ Voz Forums), bấm **Tiện ích** trên dòng đó, dán trang "Đăng chủ đề" của một box thử
   nghiệm, **tắt Tự bấm Đăng** cho lần đầu, **Lưu**.
3. **Chiến dịch → Tạo tự động** chọn tài khoản đó, nội dung có `[TEST]`, **Chạy ngay**.
   **Kết quả đúng:** trong ≤ 1 phút Chrome mở tab diễn đàn, điền sẵn tiêu đề/nội dung, đưa tab lên trước; trang
   Publishing ghi "Tiện ích cần bạn". Bấm **Đăng** trên diễn đàn → vài giây sau job **Đã đăng** kèm link chủ đề.
4. Bật lại **Tự bấm Đăng**, chạy chiến dịch khác. **Kết quả đúng:** tiện ích tự đăng trong tab nền, tự đóng tab, job
   **Đã đăng**.
5. Đăng xuất diễn đàn rồi chạy lần nữa. **Kết quả đúng:** job **Thất bại** với lý do chưa đăng nhập; đăng nhập lại rồi
   bấm **Retry** thì bài được đăng.

Kiểm thử tự động không cần diễn đàn thật: `scripts/extension-e2e/` (xem cuối BROWSER_EXTENSION_CHROME.md).

## Bảng nghiệm thu

| # | Mục | Đạt khi |
|---|---|---|
| 1 | Mã | A đạt đủ lint/typecheck/test/build hai repo |
| 2 | Hạ tầng | `pnpm smoke:stack` báo `Tất cả mục đạt.` |
| 3 | Đăng trọn luồng | Ít nhất 1 bài thật qua C có link |
| 4 | Threads | Kết nối bằng nút, Test đạt, 1 bài `[TEST]` có link |
| 5 | Instagram | Như 4, bài có ảnh JPEG |
| 6 | Tumblr | Kết nối, mỗi blog một dòng, 1 bài `[TEST]` |
| 7 | Lỗi OAuth | Huỷ đăng nhập → thông báo đỏ trên trang Tài khoản |
| 8 | Theo dõi | Gỡ quyền app → Cần kết nối lại + Cần xử lý + chuông (+ tin chat nếu bật) |
| 9 | Gia hạn | Bước E.4 báo gia hạn 1 token |
| 10 | Tiện ích Chrome | G.3–G.5 đạt trên một diễn đàn thật |

## Lỗi thường gặp

| Hiện tượng | Cách xử lý |
|---|---|
| `smoke:stack` báo redis/rabbitmq `down` | `docker compose ps`; đợi container `healthy` hoặc `docker compose up -d` |
| Không có nút Kết nối cho Threads/Instagram/Tumblr | Thiếu App ID/Secret trong `.env` backend hoặc chưa khởi động lại `api` |
| "Phiên kết nối đã hết hạn" | Mỗi lần bấm Kết nối có hiệu lực 10 phút; bấm lại |
| "Nền tảng từ chối đổi mã đăng nhập" | Sai App Secret, hoặc Redirect URL đăng ký không khớp tuyệt đối với `OAUTH_REDIRECT_BASE_URL/<provider>/callback` |
| Instagram báo media không hợp lệ | Ảnh phải JPEG, ở `S3_PUBLIC_URL` HTTPS công khai, không redirect |
| Account Meta không đăng được dù đã kết nối | App chưa qua App Review và account chưa được thêm làm Tester |
| Blogger tạo nháp | Bật công tắc **Đăng ngay** trên dòng Blogger |
