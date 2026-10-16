# Đăng bài bằng trình duyệt (browser-assisted)

Dùng cho nền tảng **không có API chính thức phù hợp** và đã có recipe được review trong
`src/connectors/browser/browser-recipe.manifest.ts` (hiện tại: Voz / XenForo). Nền tảng có API thì đi connector API.

## Nguyên tắc

- **Chụp session, không lưu mật khẩu.** Người vận hành tự đăng nhập một lần trong Chromium (tự xử lý 2FA/CAPTCHA);
  hệ thống lưu session (cookies + localStorage) đã mã hoá AES-256-GCM và tái dùng khi đăng.
- Gặp CAPTCHA, 2FA, security check hoặc session hết hạn khi đăng → dừng an toàn, job `NEEDS_ACTION`, account
  `RECONNECT_REQUIRED`. Hệ thống **không** giải CAPTCHA, không nhập OTP, không che dấu hiệu automation
  (`navigator.webdriver`), không giả User-Agent, không random fingerprint.
- Sau khi đã bấm submit mà không xác minh được kết quả → `SUBMISSION_UNCERTAIN`, không tự gửi lại.

Chế độ [Authentication Recovery](AUTH_RECOVERY.md) bổ sung persistent profile và CLI `pnpm bot`:
người dùng xử lý CAPTCHA, nhập ẩn OTP rồi tự tiếp tục khi đã xác thực. Chế độ cũ ở trên vẫn là mặc định của worker;
recovery được bật bằng `BROWSER_AUTH_RECOVERY_ENABLED=true`. Không đổi giới hạn recipe/permission của nền tảng.

## Bật và chuẩn bị

1. Cài Chromium: `pnpm browser:install`, hoặc trỏ `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` tới Chromium có sẵn.
   Khi chưa đặt biến này, publish chạy bản Chromium đầy đủ ở chế độ headless mới (`channel: 'chromium'`), cùng
   engine với cửa sổ đăng nhập.
2. Đặt `BROWSER_AUTOMATION_ENABLED=true` cho API và worker.
3. Tạo account cho nền tảng browser-assisted, cấu hình settings (bảng dưới), rồi chụp session:

   ```bash
   pnpm browser:login <platform-account-uuid>
   ```

4. Chủ account xác nhận nền tảng cho phép tự động hoá (`automationPermissionAttested=true`) và bật
   `browserAutoSubmit=true` nếu muốn tự submit; nếu không, job dừng trước bước submit để người duyệt.

## Settings của account

| Key | Ý nghĩa | Mặc định |
|---|---|---|
| `forumPath` | Đường dẫn box/forum để tạo thread (theo recipe) | — |
| `threadPrefixId` | Prefix thread (XenForo), rỗng hoặc số | rỗng |
| `automationPermissionAttested` | Chủ account xác nhận nền tảng cho phép automation | `false` |
| `browserAutoSubmit` | Tự bấm submit sau khi soạn xong | `false` |
| `browserProxy` | **Tên** proxy ra ngoài do admin cấu hình trong `BROWSER_PROXIES` | không dùng proxy |
| `browserLocale` | Locale trình duyệt, ví dụ `vi-VN`, `en-US` (quyết định cả `Accept-Language`) | `vi-VN` |
| `browserTimezone` | Múi giờ IANA, ví dụ `Asia/Ho_Chi_Minh` | `Asia/Ho_Chi_Minh` |
| `browserViewport` | `RỘNGxCAO`, trong khoảng 800–2560 × 600–1600 | `1366x768` |

Login capture và publish dùng **cùng** profile và proxy của account. Đổi `forumPath`, `browserProxy` hoặc
`browserLocale`/`browserTimezone`/`browserViewport` sẽ đưa account về `RECONNECT_REQUIRED`: kiểm tra lại kết nối,
và nếu đổi proxy thì nên chụp lại session qua proxy mới.

## Proxy ra ngoài theo account

Admin khai báo proxy trong **Bí mật của dự án** (không ghi vào repo, tài liệu hay DB):

```dotenv
BROWSER_PROXIES={"vn-1":"http://user:pass@proxy.example.com:3128","office":"http://10.1.2.3:8080"}
```

- Chỉ hỗ trợ proxy HTTP `CONNECT` (`http://`). Account chỉ lưu tên (`browserProxy=vn-1`).
- Tên proxy chưa khai báo → job `NEEDS_ACTION` với thông báo rõ ràng; hệ thống **không** âm thầm quay về IP máy chủ.
- Lớp chống SSRF vẫn áp dụng: hostname được resolve và kiểm tra là IP public trước, rồi tunnel tới **IP đã kiểm tra**
  qua proxy, nên proxy không thể bị dùng để vào mạng nội bộ.
- `BROWSER_PROXIES` sai định dạng làm tiến trình dừng ngay khi khởi động; thông báo lỗi chỉ nêu tên proxy, không lộ URL.

## Chẩn đoán khi lỗi

Khi job dừng vì `EDITOR_NOT_FOUND`, `SUBMISSION_UNCERTAIN`, `AUTOMATION_FAILED`, `CAPTCHA_REQUIRED` hoặc
`SECURITY_CHECK_REQUIRED`, worker lưu `screenshot.png`, `page.html` và `trace.zip` (Playwright trace) vào một thư mục
`incident-*` riêng trên máy chạy worker. Metadata của job có `diagnostics.incidentId` và `diagnostics.directory`;
log có sự kiện `BROWSER_DIAGNOSTICS_CAPTURED`.

| Biến | Ý nghĩa | Mặc định |
|---|---|---|
| `BROWSER_DIAGNOSTICS_ENABLED` | Bật/tắt chụp bằng chứng | `true` |
| `BROWSER_DIAGNOSTICS_DIR` | Thư mục gốc lưu incident | `<tmpdir>/social-publisher-browser-diagnostics` |
| `BROWSER_DIAGNOSTICS_RETENTION_HOURS` | Xoá incident cũ hơn số giờ này (lần chụp kế tiếp) | `72` |

Xem trace: `npx playwright show-trace <directory>/trace.zip`. Ảnh và HTML có thể chứa nội dung bài và giao diện đã
đăng nhập: chỉ người vận hành được xem, không đính kèm vào ticket công khai.
