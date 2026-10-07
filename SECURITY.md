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
