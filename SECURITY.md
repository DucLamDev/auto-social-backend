# Security

## Credential

- `CREDENTIAL_ENCRYPTION_KEY` là đúng 32 random bytes dạng base64 (`openssl rand -base64 32`). AES-256-GCM dùng IV 12 bytes mới cho mỗi lần mã hóa và AAD key version.
- Không log/response password, access token, refresh token, webhook URL hoặc application password.
- OAuth access/refresh token đều được mã hóa. Google/Blogger tự refresh trước hạn; LinkedIn yêu cầu reconnect khi token hết hạn trừ khi app được cấp partner refresh token.
- Secret system setting được lưu thành ciphertext. Ưu tiên environment/Vault cho production secret.

## Web/API

- Access JWT ngắn hạn; refresh token rotate, hash SHA-256 trong session và cookie `HttpOnly`, `Secure` ở production, `SameSite=Lax`.
- Login/refresh có Redis rate limit theo IP; login còn giới hạn theo hash của email đã normalize để giảm credential stuffing mà không lưu PII trong Redis key. CDN/WAF vẫn là lớp bổ sung bắt buộc khi public.
- RBAC global; resource query lọc theo owner. Platform catalog là global nhưng account/content/campaign/media là tenant-scoped.
- Validation pipe whitelist + forbid unknown fields. Helmet, strict CORS và request ID bật mặc định.
- OAuth state random, hash trong DB, validate provider/expiry và consume một lần trước token exchange. LinkedIn/Google dùng confidential web flow với server-held client secret; PKCE không được giả vờ bật khi flow này không dùng.
- Audit interceptor chỉ ghi metadata mutation thành công (`actorId`, action, entity/id, request ID, IP); audit write là best-effort và không sao chép body, response, token hay credential.
- OpenAI Responses dùng Structured Outputs và `store: false`; source/content không cần được lưu làm application state phía OpenAI.
- VPSTTT AI (AI API của IDE công ty) nhận brief, nội dung nguồn và hồ sơ thương hiệu để viết bài; không gửi credential,
  cookie hay token. Key nằm trong `.env` backend, chỉ dùng qua https và phải khai báo IP được phép trong IDE.

## Gợi ý ô / nút bằng AI cho tiện ích

- Tắt mặc định (`EXTENSION_UI_RECOVERY_ENABLED=false`). Chỉ thiết bị đang giữ đúng việc gọi được, trang phải cùng origin
  đích của việc, tối đa 2 lần mỗi việc và 20 lần/giờ mỗi thiết bị.
- Rời trình duyệt: tối đa 60 phần tử hiển thị mô tả bằng tag, loại, role, nhãn / placeholder / chữ ngắn (che email, chuỗi
  dài, dãy số dài) và đường dẫn CSS; không gửi giá trị ô nhập, ô mật khẩu, cookie hay nội dung bài. Backend che lại lần
  nữa và không gửi đường dẫn CSS cho AI.
- AI chỉ trả số thứ tự; backend kiểm loại phần tử (nút Đăng phải có chữ kiểu Đăng / Post / Publish, không phải Huỷ / Xoá
  / Nháp), độ tin cậy, và selector luôn lấy từ danh sách gốc. Chữ trên trang được coi là dữ liệu không tin cậy.
- Gợi ý chưa duyệt chỉ được dùng để điền sẵn, tiện ích không tự bấm Đăng; ADMIN duyệt (web hoặc MCP, có `AuditLog`) thì
  mới dùng cùng tự đăng, và chỉ cho đúng chủ sở hữu, engine, origin đó. Gợi ý bị từ chối không được dùng lại.
- Bước đăng nhập (cùng cờ): khi tiện ích không nhận ra trang đăng nhập của một bài đăng hoặc lượt Test, AI chỉ số thứ tự
  của chỗ hiện tài khoản, nút mở menu tài khoản hoặc nút đăng nhập. Chỉ thiết bị đang giữ đúng bài / lượt Test gọi được,
  trang phải ở origin đích hoặc origin đăng nhập đã cấu hình của tài khoản (không bao giờ trang Google), tối đa 2 lần mỗi
  bài / lượt Test, chung hạn mức 20 lần/giờ. Không gửi ô nhập, giá trị, mật khẩu; AI chỉ biết username cần tìm.
- AI không quyết định tài khoản: tiện ích tự đọc chữ / link ở chỗ đó và so với username / URL hồ sơ đã cấu hình; nhãn
  chung ("Account") không bao giờ được tính. Backend chỉ nhận chỗ hiện tài khoản nằm ở đầu trang / điều hướng / thanh
  bên / menu, không nằm trong bài viết; nút đăng nhập phải có chữ đăng nhập, không phải nút gửi form, không đăng ký.
  Tiện ích không bấm gì nằm trong form có ô mật khẩu.
- Chỗ hiện tài khoản đã khớp được lưu làm CSS nhận diện của tài khoản (`identitySelectorSource: 'ai'`, ghi `AuditLog`);
  không bao giờ ghi đè CSS người vận hành tự đặt.

## MCP (Codex)

- `POST /mcp` tắt mặc định (`MCP_ENABLED=false` trả 404). Token `mcp_…` ngẫu nhiên 32 byte, chỉ lưu SHA-256, có quyền
  `read` hoặc `read+write`, hạn dùng tuỳ chọn và thu hồi được; vai trò của chủ token được đọc lại mỗi lượt.
- Mỗi công cụ áp cùng quyền sở hữu và vai trò như REST; lệnh ghi cần quyền `write`. Không có công cụ thực thi mã,
  selector hay lệnh tuỳ ý; kết quả chỉ chứa trường không bí mật (không settings thô, credential, cookie, mật khẩu).
- Đăng thật (`approve_campaign`) chỉ có khi `MCP_ALLOW_PUBLISH=true`, bắt `confirm: true`, 5 lần/giờ/token. Tạo nháp
  chiến dịch 10 lần/giờ/token, mọi token `MCP_RATE_LIMIT_PER_MINUTE` lượt/phút (Redis).
- Header `Origin` lạ bị từ chối (chống DNS rebinding); agent như Codex không gửi Origin. Mọi lệnh ghi và lệnh bị từ chối
  ghi `AuditLog` `MCP_<TOOL>` với `actorId` là chủ token và `tokenId`, không lưu tham số.
- Nội dung trả về (tên chiến dịch, bài viết, lỗi nền tảng) là dữ liệu do người dùng / nền tảng tạo; agent phải coi là
  dữ liệu, không phải chỉ dẫn.

## Outbound SSRF

- Chỉ HTTP/HTTPS, không credential trong URL.
- Chặn localhost, `.local`, `.internal`, IPv4 private/link-local/CGNAT/reserved/metadata và IPv6 loopback/link-local/ULA/multicast/documentation.
- Kiểm tra lại DNS trong custom connection lookup để giảm DNS rebinding/TOCTOU.
- Redirect manual tối đa 5, mỗi hop được kiểm tra; timeout 15 giây; response tối đa 5 MiB; MIME allowlist; HTML sanitize.
- Base URL động của WordPress, Forem/dev.to, Mastodon và Bluesky luôn bắt buộc HTTPS, không cho URL userinfo, hostname local/reserved hoặc bất kỳ DNS record private/reserved nào.
- Connector dùng Undici dispatcher riêng được pin vào tập IP vừa validate. Redirect được xử lý manual tối đa 5 hop, resolve/validate lại ở mỗi hop và chỉ cho cùng origin để không chuyển tiếp Basic/Bearer/API key sang host khác.
- Network egress firewall/proxy vẫn là defense-in-depth bắt buộc: chặn loopback, metadata endpoint và mạng quản trị ngay cả khi application guard đang bật. Chỉ ADMIN tin cậy được sửa connector credential/base URL.

## Media upload

- Upload tối đa 50 MiB và chỉ nhận allowlist MIME của release; service đối chiếu magic bytes thay vì tin riêng header/tên file từ client.
- Redis lock chỉ cho một multipart upload đồng thời trên mỗi user trước khi Multer bắt đầu buffer; ingress vẫn phải đặt request-body/rate/concurrency limit toàn cục để bảo vệ trước nhiều user độc hại.
- Object key dùng extension canonical suy ra từ định dạng đã xác minh. Content/Variant đã được campaign tham chiếu không nhận thêm asset để payload đã duyệt không đổi ngầm.
- Worker hợp nhất rồi dedupe asset gắn ở Content và Variant. `S3_PUBLIC_URL` phải là HTTPS origin mà provider bên ngoài truy cập được; không public MinIO Console.

## Production checklist

- Đổi toàn bộ placeholder, không commit `.env`; giới hạn quyền file `.env` (`chmod 600`).
- Chỉ expose reverse proxy/API; PostgreSQL, Redis, RabbitMQ và MinIO console ở internal network/firewall.
- Dùng HTTPS; đặt `FRONTEND_URL` chính xác; xoay encryption key theo kế hoạch có migration/re-encrypt.
- Backup PostgreSQL/MinIO; bật log aggregation và alert DLQ/FAILED spike.
