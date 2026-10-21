# Hướng dẫn lấy thông tin cấu hình cho từng mạng xã hội có API

> Cập nhật **2026-10-12**. Dành cho người vận hành: lấy token/key ở đâu, điền vào ô nào trong
> **Tài khoản → Kết nối / cấu hình**, kiểm tra thế nào và phải làm lại khi nào.
> Giao diện nhà cung cấp hay đổi tên menu; nếu khác, đối chiếu link chính thức ở từng mục.
> Lý do kỹ thuật và giới hạn chi tiết: [SOCIAL_CONFIGURATION.md](SOCIAL_CONFIGURATION.md). Kế hoạch sửa các điểm
> còn thiếu: [OPERATIONS_REVIEW.md](OPERATIONS_REVIEW.md).

## Bảng tổng hợp

| # | Nền tảng | Account trong danh sách | Cách xác thực | Sẵn sàng? | Phải làm lại |
|---|---|---|---|---|---|
| 1 | dev.to | 10 | API key | ✅ Ngay | Không hết hạn |
| 2 | Mastodon.social / Vivaldi Social | 2 | Access token | ✅ Ngay | Không hết hạn |
| 3 | Discord | 1 | Webhook URL | ✅ Ngay | Không hết hạn |
| 4 | Discourse (community VPSTTT) | 1+ | Admin API key | ✅ Ngay | Không hết hạn |
| 5 | Blogger | 4 | Google OAuth (env server) | ✅, mặc định tạo nháp | Tự refresh |
| 6 | LinkedIn | 1 | LinkedIn OAuth (env server) | ✅ | Nối lại mỗi ~60 ngày |
| 7 | Threads | ~15 | Nút **Kết nối** (Meta OAuth, env server) | ✅ | Tự gia hạn |
| 8 | Instagram | ~17 | Nút **Kết nối** (Meta OAuth, env server) | ✅, chỉ đăng ảnh | Tự gia hạn |
| 9 | Bluesky | 1 | Access JWT nhập tay | ⛔ Chỉ để thử, ~2 giờ | Chờ sửa connector |
| 10 | X | 1 | OAuth 2.0 user token | ⛔ Chỉ để thử, ~2 giờ, tốn phí | Chờ sửa connector |
| 11 | WordPress self-hosted / WordPress.com | 4 (đều WordPress.com) | Application Password | ⛔ WordPress.com gói miễn phí chưa hỗ trợ | — |
| 12 | Voz (trình duyệt) | 1 | Session chụp tay | ✅ | Khi session hết hạn |

Thứ tự nên làm: 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8. Mục 9–11 đợi các bản sửa ở Giai đoạn 1–2/5 của kế hoạch.

---

## 0. Chuẩn bị chung (làm một lần)

**Hạ tầng.** OAuth (Blogger, LinkedIn) và ảnh cho Instagram/Threads cần backend chạy trên tên miền **HTTPS công khai**:

- API, ví dụ `https://api.<tên-miền>`; frontend, ví dụ `https://app.<tên-miền>`.
- Kho ảnh công khai `S3_PUBLIC_URL` (HTTPS, không redirect) để Meta tải ảnh về.

**Bí mật.** Mọi giá trị dưới đây đặt ở **Bí mật của dự án** (quản trị đặt, tự ghi vào `.env` khi triển khai), không
ghi vào repo, tài liệu, ticket hay chat:

| Biến | Lấy ở đâu |
|---|---|
| `CREDENTIAL_ENCRYPTION_KEY` | Sinh một lần: `openssl rand -base64 32`. **Mất khoá = mất toàn bộ credential đã lưu.** |
| `OAUTH_REDIRECT_BASE_URL` | `https://api.<tên-miền>/api/v1/oauth` |
| `FRONTEND_URL` | `https://app.<tên-miền>` (nơi OAuth quay về sau khi kết nối) |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Mục 5 |
| `LINKEDIN_CLIENT_ID`, `LINKEDIN_CLIENT_SECRET`, `LINKEDIN_API_VERSION` | Mục 6 |
| `THREADS_APP_ID`, `THREADS_APP_SECRET` | Mục 7 |
| `INSTAGRAM_APP_ID`, `INSTAGRAM_APP_SECRET` | Mục 8 |
| `ALERT_WEBHOOK_URL` (tuỳ chọn) | Webhook kênh chat (Slack, Google Chat, Discord) nhận cảnh báo tài khoản/bài đăng |
| `BROWSER_AUTOMATION_ENABLED`, `BROWSER_PROXIES` | [BROWSER_AUTOMATION.md](BROWSER_AUTOMATION.md) |

**Thao tác trên giao diện (chung cho mọi kênh):** đăng nhập bằng tài khoản `ADMIN` → **Tài khoản** → **Kết nối / cấu
hình** → chọn nền tảng → điền form → **Lưu & kiểm tra**. Chỉ khi kiểm tra thành công account mới chuyển `CONNECTED`;
sau đó bật **Enabled**. Form không bao giờ tải secret cũ về: muốn đổi phải nhập lại toàn bộ.

**Nguyên tắc an toàn**
- Mỗi kênh tạo **key riêng tên `Social Publisher`**, không dùng mật khẩu đăng nhập chính.
- Bước đổi token có dùng *app secret* (mục 7, 8) chỉ chạy trên máy quản trị hoặc server, không dán secret vào website
  bên thứ ba.
- Lần đầu mỗi kênh: đăng một bài `[TEST]` ở chế độ nháp/không công khai nếu có, kiểm tra rồi mới bật chạy thật.

---

## 1. dev.to — API key (10 account)

**Lấy key** (làm cho từng account)
1. Đăng nhập dev.to bằng account đó (các account trong danh sách đăng nhập qua Google).
2. Mở <https://dev.to/settings/extensions> → mục **DEV Community API Keys**.
3. Đặt tên `Social Publisher` → **Generate API Key** → copy key.

**Điền form** (chọn nền tảng **dev.to**)

| Ô | Giá trị |
|---|---|
| Tên hiển thị | Ví dụ `dev.to – vpstttt` |
| DEV API key | Key vừa tạo |
| Forem API URL | Giữ `https://dev.to/api` |
| Publish ngay | Lần đầu **tắt** (tạo nháp → job `NEEDS_ACTION`, vào dev.to kiểm tra). Chạy thật thì bật. |

**Kiểm tra:** gọi `GET /users/me`, phải trả đúng username của account.
**Lưu ý:** dev.to cấm spam; 10 account đăng cùng bài sẽ bị gắn cờ. Đặt canonical URL về bài gốc khi đăng lại.
Nguồn: [Forem API](https://developers.forem.com/api).

## 2. Mastodon.social và Vivaldi Social — access token (2 account)

**Lấy token**
1. Đăng nhập instance (`mastodon.social` hoặc `social.vivaldi.net`).
2. **Preferences (Tuỳ chọn) → Development (Phát triển) → New application**.
3. Tên `Social Publisher`. Scope: bỏ chọn mặc định, chỉ tích `read:accounts` (hoặc `profile` nếu instance có) và
   `write:statuses`. **Submit**.
4. Mở ứng dụng vừa tạo → copy **Your access token**.

**Điền form** (chọn **Mastodon.social** hoặc **social.vivaldi.net**)

| Ô | Giá trị |
|---|---|
| Instance URL | Để nguyên giá trị điền sẵn (`https://mastodon.social` / `https://social.vivaldi.net`) |
| Access token | Token vừa copy |
| Visibility | Lần đầu `unlisted`; chạy thật `public` |

**Kiểm tra:** `GET /api/v1/accounts/verify_credentials` trả đúng account.
**Lưu ý:** với hai lựa chọn trên, hệ thống luôn dùng URL instance của catalog (lỗi C1 trong bản rà soát). Instance khác
thì chọn **Mastodon** (chung) rồi nhập URL. Token không hết hạn cho tới khi bạn xoá ứng dụng.
Nguồn: [Mastodon token](https://docs.joinmastodon.org/client/token/).

## 3. Discord — webhook (1 account)

Webhook gắn với **một kênh trong một server**, không gắn với account cá nhân. Account cần quyền **Manage Webhooks**
trên server đó.

**Lấy webhook**
1. Mở server → chuột phải kênh cần đăng → **Edit Channel → Integrations → Webhooks → New Webhook**.
2. Đặt tên, avatar → **Copy Webhook URL**.

**Điền form** (chọn **Discord**)

| Ô | Giá trị |
|---|---|
| Webhook URL | URL dạng `https://discord.com/api/webhooks/<số>/<chuỗi>` |
| Tên webhook khi đăng | Tuỳ chọn, ≤ 80 ký tự |
| Avatar URL | Tuỳ chọn, phải HTTPS |
| Thread ID có sẵn | Chỉ khi muốn đăng vào một thread có sẵn (chỉ chữ số) |
| Tự tạo thread cho Forum/Media channel | Bật nếu kênh là Forum; không bật cùng Thread ID |

**Kiểm tra:** đọc thông tin webhook; báo lỗi nếu không phải Incoming Webhook.
**Lưu ý:** URL webhook là bí mật, ai có URL đều đăng được. Nghi lộ thì xoá webhook và tạo lại.
Nguồn: [Discord webhooks](https://docs.discord.com/developers/resources/webhook).

## 4. Discourse — admin API key (community VPSTTT)

Chỉ dùng được trên forum **mình quản trị**. Forum bên thứ ba (NGINX, Caddy, TrueNAS...) chỉ dùng được nếu admin
forum đó cấp key; tài khoản thành viên không tự tạo được key.

**Lấy key** (cần quyền admin forum)
1. Tạo user bot, ví dụ `publisher-bot`, cấp quyền tạo topic trong category đích.
2. **Admin → Advanced → API keys → New API key**. Description `Social Publisher`; **User Level: Single User** chọn
   `publisher-bot`; **Scope: Granular** tích `topics: write` và `global: read`. Lưu, copy key (chỉ hiện một lần).
3. Lấy **Category ID**: mở category, URL có dạng `/c/<slug>/<số>`, số cuối là ID.

**Điền form** (chọn forum hoặc **Discourse** chung)

| Ô | Giá trị |
|---|---|
| Forum URL | Ví dụ `https://vpsttt.discourse.diy` (giữ cả path nếu forum cài dưới thư mục con) |
| API Username | `publisher-bot`. **Ghi đè** giá trị điền sẵn nếu khác (lỗi C2). |
| API Key | Key vừa tạo |
| Category ID | Số ở bước 3. **Ghi đè** giá trị điền sẵn. |
| Tags mặc định | Tuỳ chọn, ví dụ `vps, huong-dan` |

**Kiểm tra:** user khớp `API Username`, có quyền tạo topic, category cho phép đăng; nếu forum bắt buộc tag sẽ có cảnh
báo. Chi tiết: [DISCOURSE_CONFIGURATION.md](DISCOURSE_CONFIGURATION.md).

## 5. Blogger — Google OAuth (4 account)

Phần A làm **một lần** trên Google Cloud. Phần B lặp cho từng Gmail.

**A. Tạo OAuth client** (dùng một Gmail quản trị)
1. <https://console.cloud.google.com> → tạo project `Social Publisher`.
2. **APIs & Services → Library** → tìm **Blogger API v3** → **Enable**.
3. **Google Auth Platform** (OAuth consent screen):
   - **Branding:** tên app, email hỗ trợ, homepage, privacy policy, authorized domain là tên miền của bạn.
   - **Audience:** loại **External**.
   - **Data Access:** thêm scope `https://www.googleapis.com/auth/blogger`.
4. **Clients → Create client → Web application**. **Authorized redirect URI**:
   `https://api.<tên-miền>/api/v1/oauth/google/callback` (khớp tuyệt đối). Copy **Client ID** và **Client secret**.
5. Đặt `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` vào Bí mật dự án → triển khai lại API và worker.
6. **Quan trọng:** ở **Audience**, bấm **Publish app** chuyển sang **In production**. Nếu để *Testing*, refresh token
   chỉ sống **7 ngày** và kết nối sẽ tự rớt. App chưa được Google xác minh vẫn dùng được cho các Gmail của mình (màn
   cảnh báo "Google hasn't verified this app" → **Advanced → Continue**).

**B. Kết nối từng account**
1. Mỗi Gmail phải đã có blog trên Blogger.
2. Mở một **cửa sổ ẩn danh**, đăng nhập app → **Tài khoản → OAuth chính thức → Google · Blogger → OAuth**.
3. Chọn đúng Gmail, đồng ý quyền. Hệ thống tự tạo **một account cho mỗi blog** của Gmail đó.

**Lưu ý:** mặc định Blogger tạo **bản nháp** (job `NEEDS_ACTION`), và giao diện hiện chưa có ô để đổi sang đăng ngay
(lỗi T7, nằm trong Giai đoạn 2). Token tự refresh; thu hồi quyền ở tài khoản Google thì phải kết nối lại.
Nguồn: [Blogger API](https://developers.google.com/blogger/docs/3.0/using),
[OAuth web server](https://developers.google.com/identity/protocols/oauth2/web-server).

## 6. LinkedIn — OAuth (1 account)

**A. Tạo app** (một lần)
1. Cần một **LinkedIn Company Page** để gắn app (app bắt buộc liên kết Page; admin Page phải xác nhận).
2. <https://www.linkedin.com/developers/apps> → **Create app** → chọn Page, upload logo.
3. Tab **Products:** thêm **Sign In with LinkedIn using OpenID Connect** và **Share on LinkedIn**.
4. Tab **Auth:** thêm **Authorized redirect URL** `https://api.<tên-miền>/api/v1/oauth/linkedin/callback`. Copy
   **Client ID** và **Primary Client Secret**.
5. Bí mật dự án: `LINKEDIN_CLIENT_ID`, `LINKEDIN_CLIENT_SECRET` và `LINKEDIN_API_VERSION` dạng `YYYYMM`. Version phải
   **đang được hỗ trợ**, xem trang
   [LinkedIn versioning](https://learn.microsoft.com/en-us/linkedin/marketing/versioning); không chép từ tutorial cũ.
   Triển khai lại.

**B. Kết nối:** **Tài khoản → OAuth chính thức → LinkedIn → OAuth** → đăng nhập account (account trong danh sách đăng
nhập LinkedIn bằng Google, vẫn dùng được) → đồng ý.

**Lưu ý:** chỉ đăng bài chữ lên **trang cá nhân** của account đó. Đăng lên Company Page cần quyền
`w_organization_social` và duyệt riêng, hệ thống chưa hỗ trợ. Token ~60 ngày, **không tự refresh**: tới hạn bấm
**Reconnect**.
Nguồn: [Share on LinkedIn](https://learn.microsoft.com/en-us/linkedin/consumer/integrations/self-serve/share-on-linkedin).

## 7. Threads — nút Kết nối (~15 account)

Mỗi account chỉ cần đăng nhập Threads **một lần** qua nút **Kết nối**. Backend đổi sang token 60 ngày, lưu mã hoá và
**tự gia hạn** mỗi giờ khi token còn dưới 15 ngày; không phải làm lại trừ khi Meta thu hồi quyền (đổi mật khẩu,
gỡ quyền app). Khi đó account chuyển **Cần kết nối lại**, hiện ở bảng **Cần xử lý** trên Dashboard và được báo qua
`ALERT_WEBHOOK_URL` nếu có.

**A. Tạo app Meta** (một lần)
1. <https://developers.facebook.com/apps> → **Create app** → use case **Access the Threads API**.
2. **Use cases → Threads → Customize → Permissions:** thêm `threads_basic`, `threads_content_publish`.
3. **Settings → Redirect callback URLs:** điền đúng `https://api.<tên-miền>/api/v1/oauth/threads/callback`
   (tức `<OAUTH_REDIRECT_BASE_URL>/threads/callback`). Điền Uninstall/Delete callback (có thể cùng URL).
4. Ghi **Threads App ID** và **Threads App Secret** (bộ của Threads, không phải App ID chung) → nhờ quản trị đặt
   `THREADS_APP_ID`, `THREADS_APP_SECRET` ở Bí mật của dự án; `THREADS_API_VERSION` mặc định `v1.0`.
5. Khi app **chưa qua App Review** quyền `threads_content_publish`: **App roles → Roles → Add People → Threads
   Tester** cho từng username; mỗi account mở Threads → **Settings → Account → Website permissions → Invites** →
   **Accept**. Sau App Review thì không cần bước này.

**B. Kết nối từng account**
1. Trên trình duyệt đang đăng nhập Threads bằng account cần nối: **Tài khoản → Kết nối / cấu hình → Threads →
   Kết nối** → đồng ý quyền.
2. Trình duyệt quay về trang **Tài khoản** với thông báo thành công; account hiện tên `@username`, cột kiểu kết nối
   ghi **Token tự gia hạn**. Nối account tiếp theo: đăng xuất Threads (hoặc dùng cửa sổ ẩn danh) rồi lặp lại.
3. Lỗi thường gặp (thông báo hiện ngay trên trang): *Phiên kết nối đã hết hạn* → bấm lại (mỗi lần bấm có hiệu lực
   10 phút); *Nền tảng từ chối đổi mã* → sai App Secret hoặc Redirect URL chưa khớp tuyệt đối.

**Kiểm tra:** nút **Test** gọi `GET /me`; đăng một bài `[TEST]` rồi xoá tay.
**Lưu ý:** nội dung ≤ 500 ký tự, tối đa 1 ảnh (JPEG/PNG ≤ 8 MB) ở `S3_PUBLIC_URL` HTTPS công khai; hệ thống chờ
Meta xử lý ảnh xong mới đăng. Mỗi profile tối đa 250 bài / 24 giờ.
Form **Credential** (dán token tay) vẫn còn để dự phòng nhưng token đó không tự gia hạn.
Nguồn: [Threads API – access tokens](https://developers.facebook.com/docs/threads/get-started/get-access-tokens-and-permissions),
[long-lived tokens](https://developers.facebook.com/docs/threads/get-started/long-lived-tokens).

## 8. Instagram — nút Kết nối (~17 account)

Cách hoạt động giống Threads (mục 7): đăng nhập một lần, token tự gia hạn. Instagram **bắt buộc có ảnh**; bài chỉ có
chữ bị từ chối.

**A. Chuẩn bị từng account Instagram:** app Instagram → **Settings → Account type and tools → Switch to professional
account** → chọn **Creator** hoặc **Business**. Tài khoản cá nhân không đăng qua API được.

**B. Tạo app Meta** (một lần, có thể dùng chung app với Threads)
1. Thêm use case **Manage messaging & content on Instagram**, chọn **API setup with Instagram login**.
2. Permissions: `instagram_business_basic`, `instagram_business_content_publish`.
3. Ở **Set up Instagram business login**, đặt **OAuth redirect URI** là
   `https://api.<tên-miền>/api/v1/oauth/instagram/callback`; ghi **Instagram App ID** và **Instagram App Secret**
   → quản trị đặt `INSTAGRAM_APP_ID`, `INSTAGRAM_APP_SECRET` (`INSTAGRAM_API_VERSION` mặc định `v24.0`).
4. App chỉ cần **Standard Access** cho account do chính bạn sở hữu/quản lý và đã thêm vào app
   (**App roles → Roles → Instagram Tester**; account chấp nhận tại
   <https://www.instagram.com/accounts/manage_access/> → tab **Tester invites**). Account của khách hàng/bên khác cần
   **Advanced Access** qua App Review.

**C. Kết nối từng account:** **Tài khoản → Kết nối / cấu hình → Instagram → Kết nối** → đăng nhập Instagram → đồng ý.
Hệ thống tự lấy đúng Instagram professional account ID (`user_id`), không cần nhập tay.

**Kiểm tra:** đăng một bài `[TEST]` có ảnh rồi xoá tay.
**Lưu ý:** dùng ảnh **JPEG**; mỗi bài đúng 1 ảnh ở URL HTTPS công khai; hệ thống chờ container `FINISHED` rồi mới
đăng. Giới hạn hiện hành ~50 bài / 24 giờ mỗi account.
Nguồn: [Business login](https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/business-login),
[Refresh access token](https://developers.facebook.com/docs/instagram-platform/reference/refresh_access_token/),
[Content publishing](https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/content-publishing).

## 9. Bluesky — chỉ để thử (1 account)

Connector hiện cần **Access JWT**, loại token này sống khoảng 2 giờ và hệ thống chưa tự gia hạn. Dùng để kiểm thử;
chạy thật đợi bản sửa dùng App Password (Giai đoạn 1).

1. bsky.app → **Settings → Privacy and security → App passwords → Add App Password** → tên `Social Publisher` → copy.
   App Password này dùng lâu dài; giữ lại cho bản sửa sau.
2. Đổi lấy JWT trên máy quản trị:
   ```bash
   curl -X POST https://bsky.social/xrpc/com.atproto.server.createSession \
     -H 'Content-Type: application/json' \
     -d '{"identifier":"<handle-hoặc-email>","password":"<APP_PASSWORD>"}'
   ```
3. Điền form **Bluesky**: **Access JWT** = `accessJwt`, **DID** = `did`, **PDS service URL** = `https://bsky.social`.

## 10. X (Twitter) — chưa nên cấu hình

- X API hiện **trả phí theo lượt** (mua credit trong Developer Console; gói Basic/Pro chỉ còn cho người đăng ký cũ).
  Theo nguồn bên thứ ba: bài thường ~$0.015, bài có link ~$0.20.
- Connector hiện cần **OAuth 2.0 user access token**, loại này hết hạn sau ~2 giờ và hệ thống chưa refresh.
- Việc làm trước được: tạo app trong X Developer Console, nạp credit, **User authentication settings** → quyền
  **Read and write**, loại **Web App, Automated App or Bot**, điền Callback URI/Website. Khi connector hỗ trợ OAuth 1.0a
  (đề xuất ở Giai đoạn 2), lấy **API Key/Secret** và **Access Token/Secret** ở tab **Keys and tokens**. Phải tạo lại
  Access Token sau khi đổi quyền sang Read and write.

Nguồn: [X API](https://docs.x.com/x-api/posts/manage-tweets/introduction),
[tin pay-per-use](https://gigazine.net/gsc_news/en/20260209-x-api-pay-per-use),
[bảng giá tổng hợp](https://postproxy.dev/blog/x-api-pricing-2026).

## 11. WordPress

**WordPress tự host (self-hosted):** **Users → Profile → Application Passwords** → tên `Social Publisher` → **Add** →
copy. Điền form **WordPress**:

| Ô | Giá trị |
|---|---|
| Site URL | `https://blog.example.com` (không thêm `/wp-json`) |
| Username | User có quyền đăng bài |
| Application Password | Mật khẩu vừa tạo |
| Trạng thái bài mặc định | Lần đầu `Draft`, chạy thật `Publish` |

**4 blog `*.wordpress.com` trong danh sách:** Application Password **theo site** chỉ có ở gói WordPress.com bật plugin
(Personal/Premium/Business/Commerce theo trang hỗ trợ). Gói miễn phí không có. Hai hướng:
(a) chờ connector WordPress.com OAuth (Giai đoạn 5); khi đó cần tạo app tại
<https://developer.wordpress.com/apps/> để lấy Client ID/Secret; hoặc
(b) nâng gói và thử connector hiện tại với Site URL là tên miền blog *(cần kiểm chứng trước khi dùng thật)*.
Nguồn: [WordPress.com application passwords](https://wordpress.com/support/security/two-step-authentication/application-specific-passwords/).

## 12. Voz — trình duyệt (1 account)

Không có API. Cấu hình theo [BROWSER_AUTOMATION.md](BROWSER_AUTOMATION.md): bật `BROWSER_AUTOMATION_ENABLED`, tạo
account **Voz Forums**, chọn box (`forumPath`), chụp session bằng `pnpm browser:login <id>`, chủ account xác nhận
`automationPermissionAttested` rồi mới bật `browserAutoSubmit`.

---

## Phụ lục A — Có API nhưng hệ thống chưa có connector

Chuẩn bị trước được, nhưng **chưa nhập vào hệ thống** cho tới khi connector được viết (Giai đoạn 5):

| Nền tảng | Account | Cần chuẩn bị |
|---|---|---|
| Tumblr | 5 | Đăng ký app tại <https://www.tumblr.com/oauth/apps> → OAuth consumer key/secret; xác thực OAuth 2 |
| WordPress.com | 4 | App tại <https://developer.wordpress.com/apps/> (Client ID/Secret, redirect URL) |
| Pixelfed.social | 1 | Settings → Applications → personal access token (nền tảng ảnh, bài cần có ảnh) |
| Lemmy.world | 1 | Tài khoản + chọn community; Lemmy dùng đăng nhập lấy JWT |
| Reddit | 1 | Nộp đơn xin Data API, chờ duyệt trước |
| TikTok | — | App + audit Content Posting API trước |
| Disqus, Scoop.it, Dailymotion, Eventbrite | 1 mỗi loại | Đăng ký app tương ứng; mỗi loại là kiểu nội dung riêng (bình luận, curation, video, sự kiện) |

## Phụ lục B — Không có API phù hợp

Medium, Substack, Quora, MeWe, Minds, DZone, daily.dev, Differ, Product Hunt, Gumroad, SlideShare, Flipboard, AWS
Community, Stack Exchange, Hugging Face, In Plain English, Tinhte và các forum không phải Discourse: tạo account loại
**Kênh bàn giao thủ công**. AI soạn sẵn bài, người vận hành bấm **Copy & mở** rồi đăng, sau đó bấm **Đã đăng** kèm URL.
Forum dùng XenForo có thể làm recipe trình duyệt như Voz khi điều khoản của forum cho phép.

## Phụ lục C — Checklist trước khi bật một account

- [ ] **Lưu & kiểm tra** thành công, account `CONNECTED`, đúng username mong muốn.
- [ ] Đăng 1 bài `[TEST]` (nháp/không công khai nếu có), xác minh URL, rồi xoá.
- [ ] LinkedIn không tự gia hạn: hệ thống nhắc 7 ngày trước hạn (Dashboard → Cần xử lý, và `ALERT_WEBHOOK_URL`).
- [ ] Đặt `rateLimit`/khoảng cách hợp lý; không cho nhiều account cùng nền tảng đăng cùng văn bản cùng lúc.
- [ ] Chỉ sau đó mới bật **Enabled** và đưa vào chiến dịch.
- [ ] Sau khi đã nhập hết, **xoá `auth_v2.csv`** và đổi các mật khẩu/app password từng nằm trong file.
