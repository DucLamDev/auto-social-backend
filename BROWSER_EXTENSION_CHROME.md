# Đăng diễn đàn bằng tiện ích Chrome

Tiện ích **VPSTTT Social Publisher** (thư mục `browser-extension/`) đăng bài đã duyệt lên diễn đàn bằng **chính
Chrome bạn đang dùng**, nơi bạn đã đăng nhập sẵn các diễn đàn. Hệ thống không lưu mật khẩu, cookie hay hồ sơ trình
duyệt; không cần Playwright, không cần máy chủ có màn hình.

| Loại diễn đàn | Ví dụ | Trang cần dán |
|---|---|---|
| XenForo 2 | voz.vn, forums.cpanel.net, forum.directadmin.com | Trang "Đăng chủ đề" của box, kết thúc `/post-thread` |
| Discourse | community.nginx.org, caddy.community, forums.truenas.com | Trang chủ diễn đàn, hoặc `/new-topic?category=<slug>` |
| phpBB 3 | forum.example.com | `posting.php?mode=post&f=<id box>` |

Mạng xã hội có API chính thức (Threads, Instagram, Tumblr, Bluesky…) vẫn đi đường API, không dùng tiện ích.

## Luồng hoạt động

```text
Chiến dịch → job → worker → ExtensionConnector: job "Chờ tiện ích Chrome"
Tiện ích (30 giây/lần) → POST /extension/agent/claim → nhận 1 bài (tiêu đề, nội dung, bộ chỉ dẫn form)
  → mở tab nền trang tạo chủ đề → điền → bấm Đăng → thấy link chủ đề mới
  → POST /extension/agent/tasks/:id/result {PUBLISHED, url} → job "Đã đăng", lưu link
```

- Gặp **CAPTCHA**, hoặc tài khoản tắt **Tự bấm Đăng**: tiện ích điền sẵn, đưa tab lên trước, job hiện "Tiện ích cần
  bạn". Bạn giải CAPTCHA / kiểm tra rồi bấm Đăng; tiện ích tự nhận ra link bài và báo "Đã đăng". Tab đang chờ không
  làm tắc các bài khác (tối đa 5 tab chờ cùng lúc).
- **Chưa đăng nhập diễn đàn**, không thấy form, tab bị đóng trước khi điền, chưa cấp quyền: job "Thất bại" kèm lý
  do. Những lỗi này chắc chắn chưa gửi gì, nên bấm **Retry** trên trang Publishing là an toàn.
- **Đã bấm Đăng nhưng không thấy bài mới / diễn đàn báo lỗi / tiện ích im lặng quá 10 phút**: không bao giờ tự đăng
  lại. Kiểm tra diễn đàn rồi bấm **Đã đăng** (dán link) hoặc **Giao lại cho tiện ích**.
- Bộ chỉ dẫn form (selector, mẫu link bài) nằm ở backend `src/connectors/extension/extension-delivery.ts` và được gửi
  kèm mỗi bài. Diễn đàn đổi giao diện thì sửa ở đó, không phải cài lại tiện ích.

## Cài đặt (mỗi máy Chrome làm một lần)

1. Lấy tiện ích: thư mục `browser-extension/` của repo backend, hoặc file zip tạo bằng
   `vpsttt-ext pack browser-extension` (ra `browser-extension/dist-ext/VPSTTT-Social-Publisher-<phiên bản>.zip`, giải nén).
2. Chrome → `chrome://extensions` → bật **Developer mode** → **Load unpacked** → chọn thư mục tiện ích.
3. Trên web quản trị: **Tài khoản → Ghép nối Chrome → Tạo mã**. Sao chép mã `spx_…` (chỉ hiện một lần).
4. Bấm biểu tượng tiện ích → **Cài đặt**: dán địa chỉ API (ví dụ `https://api.<tên-miền>`) và mã → **Lưu & kiểm tra**
   → Chrome hỏi quyền truy cập API → **Cho phép**.
5. Bấm **Cấp quyền diễn đàn** (danh sách lấy từ các tài khoản đã bật tiện ích) → **Cho phép**.
6. Đăng nhập sẵn từng diễn đàn trong chính Chrome này. Giữ Chrome mở (có thể thu nhỏ).

Mất máy hoặc lộ mã: **Tài khoản → biểu tượng thùng rác** cạnh tên Chrome để thu hồi ngay. Mỗi Chrome/hồ sơ dùng một
mã riêng. Muốn đăng bằng nhiều tài khoản trên cùng một diễn đàn thì dùng nhiều hồ sơ Chrome, mỗi hồ sơ ghép nối riêng.

## Bật cho một tài khoản diễn đàn

1. **Tài khoản → Kết nối / cấu hình** → chọn diễn đàn (mục bàn giao thủ công hoặc Discourse) → tạo tài khoản.
   Với Discourse không cần API key khi dùng tiện ích.
2. Trên dòng tài khoản bấm **Tiện ích** → bật **Đăng bằng tiện ích Chrome** → chọn loại diễn đàn → dán **Trang tạo
   chủ đề** → chọn **Tự bấm Đăng** (nên tắt vài ngày đầu với diễn đàn mới) → **Lưu**.
3. Dòng tài khoản ghi **Tiện ích Chrome · <tên miền>**. Tài khoản này chọn được trong **Chiến dịch → Tạo tự động**.

## Theo dõi

- Biểu tượng tiện ích: `…` đang đăng, số màu cam = số tab đang chờ bạn, `ERR` = không gọi được backend, `II` = tạm dừng.
  Popup hiện bài đang làm và 6 kết quả gần nhất.
- Web quản trị: trang **Publishing** ghi "Chờ tiện ích Chrome" / "Tiện ích cần bạn"; Dashboard → **Cần xử lý** báo
  "Chrome chưa chạy" khi có bài chờ mà không Chrome nào kết nối trong 3 phút.

## API (cho người phát triển)

| Endpoint | Ai gọi | Ghi chú |
|---|---|---|
| `GET/POST /api/v1/extension/devices`, `DELETE …/:id` | Web (JWT, tạo/thu hồi: ADMIN) | Mã chỉ trả một lần; DB lưu SHA-256 |
| `PUT /api/v1/extension/accounts/:id` | Web (ADMIN) | `{ enabled, engine, targetUrl, autoSubmit }`; từ chối nền tảng OFFICIAL_API |
| `POST /api/v1/extension/jobs/:id/requeue` | Web (ADMIN/EDITOR) | Chỉ job tiện ích đang chờ người vận hành |
| `POST /api/v1/extension/agent/heartbeat` | Tiện ích (`Bearer spx_…`) | Số bài chờ, danh sách tên miền cần quyền |
| `POST /api/v1/extension/agent/claim` | Tiện ích | Nhận 1 bài (khoá bằng `lockedAt`), quá 10 phút không báo → `EXTENSION_RESULT_UNKNOWN` |
| `POST /api/v1/extension/agent/tasks/:id/result` | Tiện ích | `PUBLISHED` cần link đúng tên miền và đúng mẫu link chủ đề |

Bảng `extension_devices` thêm bởi migration `20261024090000_extension_devices` (tự chạy khi API khởi động bằng
`prisma migrate deploy`).

## Demo / kiểm thử không cần Docker

`INLINE_PUBLISH_WORKER=true` (chỉ khi `NODE_ENV` khác `production`) cho API tự chạy worker trong cùng tiến trình;
kèm `SKIP_INFRA_CONNECT=true` thì chỉ cần PostgreSQL. Bộ kiểm thử đầu-cuối ở `scripts/extension-e2e/`:

1. `fake-forum.mjs <cổng> <tệp-json>`: diễn đàn giả lập XenForo/Discourse/phpBB (`/login-as` giả lập đã đăng nhập).
2. `setup.mjs <api> <forum> <tệp-bí-mật>`: qua API thật tạo mã ghép nối, 3 tài khoản dùng tiện ích, nội dung, chiến dịch
   và bấm đăng (cần `SEED_ADMIN_EMAIL`, `SEED_ADMIN_PASSWORD` trong môi trường).
3. `run-extension.cjs <playwright> <chrome> <thư-mục-tiện-ích> <tệp-bí-mật> <forum> <api> <thư-mục-ảnh>`: nạp tiện ích vào
   Chromium, ghép nối, chờ tiện ích tự đăng, in kết quả.

Kết quả chạy ngày 24/10/2026 trên Dev VPS (PostgreSQL tạm, API thật, Chromium dùng chung): 3/3 bài XenForo, Discourse,
phpBB lên diễn đàn giả lập và job chuyển `PUBLISHED`, chiến dịch `COMPLETED`; CAPTCHA dừng chờ người, giải xong tự báo
đã đăng; chế độ chờ bấm hoạt động; bài vướng CAPTCHA không chặn bài khác. Chưa thử trên diễn đàn thật.
