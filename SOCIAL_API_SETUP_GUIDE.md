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
| 7 | Threads | ~15 | Token Meta nhập tay | ⚠️ Chạy 60 ngày rồi chết | Lấy lại token mỗi 60 ngày |
| 8 | Instagram | ~17 | Token Meta nhập tay | ⚠️ Như Threads, chỉ đăng ảnh | Lấy lại token mỗi 60 ngày |
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

## 7. Threads — token Meta (~15 account)

> Hiện hệ thống nhận token **nhập tay**, sống 60 ngày và chưa tự refresh. Làm theo mục này để chạy ngay. Với ~15
> account, nên đợi bản OAuth + tự refresh (Giai đoạn 2) trước khi đưa toàn bộ vào chạy thật.

**A. Tạo app Meta** (một lần)
1. <https://developers.facebook.com/apps> → **Create app** → use case **Access the Threads API**.
2. **Use cases → Threads → Customize → Permissions:** thêm `threads_basic`, `threads_content_publish`.
3. **Settings:** điền **Redirect callback URL** là một URL HTTPS của bạn, ví dụ
   `https://app.<tên-miền>/oauth/threads` (trang không cần tồn tại, chỉ để đọc mã trên thanh địa chỉ). Điền thêm
   Uninstall/Delete callback (có thể cùng URL).
4. Ghi lại **Threads App ID** và **Threads App Secret** (dùng bộ của Threads, không phải App ID chung).
5. **App roles → Roles → Add People → Threads Tester** → nhập từng username Threads. Mỗi account mở Threads →
   **Settings → Account → Website permissions → Invites** → **Accept**. Account chưa chấp nhận sẽ không lấy được
   token khi app chưa qua App Review.

**B. Lấy token cho từng account** (đăng nhập Threads bằng account đó trong trình duyệt)
1. Mở trình duyệt:
   ```text
   https://threads.net/oauth/authorize?client_id=<THREADS_APP_ID>&redirect_uri=<REDIRECT_URL>&scope=threads_basic,threads_content_publish&response_type=code
   ```
   Đồng ý quyền. Trình duyệt chuyển về `<REDIRECT_URL>?code=...`. Copy giá trị `code` (bỏ đuôi `#_` nếu có). Mã sống
   1 giờ, dùng được 1 lần.
2. Đổi mã lấy token ngắn hạn (chạy trên máy quản trị):
   ```bash
   curl -X POST https://graph.threads.net/oauth/access_token \
     -F client_id=<THREADS_APP_ID> -F client_secret=<THREADS_APP_SECRET> \
     -F grant_type=authorization_code -F redirect_uri=<REDIRECT_URL> -F code=<CODE>
   ```
3. Đổi sang token dài hạn (60 ngày):
   ```bash
   curl "https://graph.threads.net/access_token?grant_type=th_exchange_token&client_secret=<THREADS_APP_SECRET>&access_token=<SHORT_TOKEN>"
   ```
4. Lấy **Threads User ID**:
   ```bash
   curl "https://graph.threads.net/v1.0/me?fields=id,username&access_token=<LONG_TOKEN>"
   ```

**Điền form** (chọn **Threads**)

| Ô | Giá trị |
|---|---|
| Access token | Token dài hạn ở bước 3 |
| Threads User ID | `id` ở bước 4 |
| Threads API version | `v1.0` |

**Kiểm tra:** `GET /me` phải trả đúng username.
**Phải làm lại:** trước ngày thứ 60 gia hạn bằng
`GET https://graph.threads.net/refresh_access_token?grant_type=th_refresh_token&access_token=<LONG_TOKEN>` (token phải
còn hạn và ≥ 24 giờ tuổi) rồi cập nhật credential; quá hạn thì làm lại bước B.
**Lưu ý:** nội dung ≤ 500 ký tự, tối đa 1 ảnh; ảnh phải nằm ở `S3_PUBLIC_URL` HTTPS công khai.
Nguồn: [Threads API – Get started](https://developers.facebook.com/docs/threads/get-started).

## 8. Instagram — token Meta (~17 account)

> Cùng tình trạng với Threads: token tay 60 ngày, chưa tự refresh. Instagram **bắt buộc có ảnh**; bài chỉ có chữ bị
> từ chối.

**A. Chuẩn bị từng account Instagram:** app Instagram → **Settings → Account type and tools → Switch to professional
account** → chọn **Creator** hoặc **Business**. Tài khoản cá nhân không đăng qua API được.

**B. Tạo app Meta** (một lần, có thể dùng chung app với Threads)
1. Thêm use case **Manage messaging & content on Instagram**, chọn **API setup with Instagram login**.
2. Permissions: `instagram_business_basic`, `instagram_business_content_publish`.
3. Ở mục **Set up Instagram business login**, đặt **OAuth redirect URI** là URL HTTPS của bạn (như mục 7), ghi lại
   **Instagram App ID** và **Instagram App Secret**.
4. **App roles → Roles → Add People → Instagram Tester** cho từng account. Account chấp nhận tại
   <https://www.instagram.com/accounts/manage_access/> → tab **Tester invites**.

**C. Lấy token cho từng account.** App Dashboard có nút **Generate access tokens** (thêm account → đăng nhập → copy
token dài hạn). Nếu giao diện khác, dùng luồng thủ công:
1. ```text
   https://www.instagram.com/oauth/authorize?client_id=<IG_APP_ID>&redirect_uri=<REDIRECT_URL>&response_type=code&scope=instagram_business_basic,instagram_business_content_publish
   ```
   Copy `code` (bỏ `#_`).
2. ```bash
   curl -X POST https://api.instagram.com/oauth/access_token \
     -F client_id=<IG_APP_ID> -F client_secret=<IG_APP_SECRET> \
     -F grant_type=authorization_code -F redirect_uri=<REDIRECT_URL> -F code=<CODE>
   ```
   Response có `access_token` ngắn hạn và `user_id`.
3. ```bash
   curl "https://graph.instagram.com/access_token?grant_type=ig_exchange_token&client_secret=<IG_APP_SECRET>&access_token=<SHORT_TOKEN>"
   ```
4. Xác nhận ID: `curl "https://graph.instagram.com/v24.0/me?fields=user_id,username&access_token=<LONG_TOKEN>"`.

**Điền form** (chọn **Instagram**)

| Ô | Giá trị |
|---|---|
| Access token | Token dài hạn |
| Instagram User ID | `user_id` (bước 2 hoặc 4) |
| Graph API version | `v24.0` hoặc version hiện hành |

**Kiểm tra:** bước test chỉ xác minh token, **không** xác minh User ID. Hãy đăng một bài `[TEST]` có ảnh rồi xoá tay.
Nếu báo lỗi kiểu "object does not exist", kiểm tra lại User ID.
**Phải làm lại:** trước ngày thứ 60:
`GET https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=<LONG_TOKEN>`.
**Lưu ý:** dùng ảnh JPEG cho chắc; mỗi bài đúng 1 ảnh; ảnh phải ở URL HTTPS công khai.
Nguồn: [Refresh access token](https://developers.facebook.com/docs/instagram-platform/reference/refresh_access_token/),
[Instagram API with Instagram Login](https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/).

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
- [ ] Ghi ngày hết hạn token (Threads/Instagram/LinkedIn: +60 ngày) vào lịch nhắc cho tới khi có tự refresh.
- [ ] Đặt `rateLimit`/khoảng cách hợp lý; không cho nhiều account cùng nền tảng đăng cùng văn bản cùng lúc.
- [ ] Chỉ sau đó mới bật **Enabled** và đưa vào chiến dịch.
- [ ] Sau khi đã nhập hết, **xoá `auth_v2.csv`** và đổi các mật khẩu/app password từng nằm trong file.
