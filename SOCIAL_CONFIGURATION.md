# Cấu hình connector mạng xã hội Phase 1

> Cập nhật và đối chiếu tài liệu chính thức: **2026-10-08**. Chính sách, phiên bản API, quota và giá có thể thay đổi mà không cần thay đổi source của dự án; luôn kiểm tra lại liên kết chính thức trước khi đưa một connector mới vào production.

Danh sách mở rộng gồm Medium, Substack, Tumblr, Fediverse, community/forum, Stack Exchange, Eventbrite, Dailymotion và các nền tảng khác nằm trong [EXTENDED_PLATFORM_CATALOG.md](EXTENDED_PLATFORM_CATALOG.md). Tài liệu này tập trung vào các connector Phase 1 đã được seed trong release.

Tài liệu này mô tả khả năng mà API chính thức cho phép và cách chuẩn bị tài khoản/app. Nó **không khẳng định connector trong source đã được kiểm thử với tài khoản thật**. Trạng thái thực tế phải lấy từ backend (`connector status`, `capabilities`, `test connection`) và chỉ chuyển sang production sau smoke test bằng credential thật.

## 1. Cách đọc trạng thái

| Nhãn | Ý nghĩa vận hành |
|---|---|
| `OFFICIAL_API_VERIFIED` | Có API chính thức và đã đối chiếu endpoint/auth với tài liệu nhà cung cấp. |
| `API_REVIEW_REQUIRED` | API có thật nhưng app/quyền/use case phải được nền tảng duyệt trước khi dùng rộng rãi. |
| `CREDENTIAL_REQUIRED` | Cần credential hoặc tài khoản test thật để hoàn thành integration test. |
| `NEEDS_ACTION` | Người dùng phải thực hiện một bước trong UI nền tảng/app, ví dụ cấp quyền hoặc xác nhận publish. |
| `MANUAL` | Không được tự động hóa bằng cách lách CAPTCHA, 2FA, anti-bot hoặc hạn chế nền tảng. Tạo nội dung rồi cho người dùng copy/open/mark published. |
| `API_RESEARCH_REQUIRED` | Chưa có đủ bằng chứng chính thức cho capability cụ thể; không bật capability đó. |

Một nền tảng có thể đồng thời mang nhiều nhãn. Ví dụ TikTok có API chính thức nhưng vẫn là `API_REVIEW_REQUIRED`, `CREDENTIAL_REQUIRED` và, với use case chưa được audit, `NEEDS_ACTION`.

## 2. Ma trận quyết định nhanh

| Nền tảng | Auth production | Quyền tối thiểu để đăng | Luồng publish đã xác minh | Review/hạn chế quan trọng | Khuyến nghị khi chưa có credential |
|---|---|---|---|---|---|
| Instagram | OAuth qua Instagram Login | `instagram_business_basic`, `instagram_business_content_publish` | Tạo media container, chờ xử lý, gọi `media_publish` | Chỉ Professional account (Business/Creator); app live/review để phục vụ tài khoản ngoài app roles | `API_REVIEW_REQUIRED`, `CREDENTIAL_REQUIRED` |
| Threads | OAuth 2.0 Threads | `threads_basic`, `threads_content_publish` | `POST /me/threads`, rồi `POST /me/threads_publish` | App review/live cho người dùng ngoài role; media phải có public URL | `API_REVIEW_REQUIRED`, `CREDENTIAL_REQUIRED` |
| X | OAuth 2.0 Authorization Code + PKCE hoặc OAuth 1.0a user context | `tweet.read`, `tweet.write`, `users.read`; thêm `media.write`, `offline.access` khi cần | `POST /2/tweets`; upload media trước | Cần developer project/app và gói truy cập/billing phù hợp | `CREDENTIAL_REQUIRED` |
| LinkedIn | OAuth 2.0 3-legged | Cá nhân: `w_member_social`; tổ chức: `w_organization_social` | `POST /rest/posts`, upload asset trước nếu có media | Đăng Page thường cần Community Management access và role Page phù hợp | Cá nhân: `CREDENTIAL_REQUIRED`; tổ chức: `API_REVIEW_REQUIRED` |
| WordPress self-hosted | Application Password qua HTTPS | Quyền WordPress của user để upload/publish | `POST /wp-json/wp/v2/posts`; media qua `/wp/v2/media` | Không có review trung tâm; WAF/plugin/role của từng site có thể chặn | `CREDENTIAL_REQUIRED` |
| Blogger | Google OAuth 2.0 web-server | `https://www.googleapis.com/auth/blogger` | `posts.insert`; có thể tạo draft rồi `posts.publish` | OAuth consent/verification tùy trạng thái app và phân loại scope trong Cloud Console | `CREDENTIAL_REQUIRED`, có thể `API_REVIEW_REQUIRED` |
| dev.to | API key của DEV/Forem | `api-key` và Accept header API v1 | `POST https://dev.to/api/articles` | Không OAuth/review; tuân thủ anti-spam và rate limit | `CREDENTIAL_REQUIRED` |
| Discord | Incoming webhook URL/token; hoặc OAuth `webhook.incoming` | Token webhook | Execute Webhook | URL webhook là secret; không cần bot cho use case này | `CREDENTIAL_REQUIRED` |
| Reddit | OAuth của Data API đã được Reddit phê duyệt | Tối thiểu `submit`; thêm `identity` để xác minh account | `POST /api/submit` sau khi được cấp quyền | Quy trình access hiện yêu cầu approved developer; commercial use cần permission/contract | `API_REVIEW_REQUIRED`, mặc định `NEEDS_ACTION` |
| Bluesky | AT Protocol OAuth cho ứng dụng nhiều người dùng | Permission set hiện hành cho repo write/blob upload; dùng SDK chính thức | `com.atproto.repo.createRecord`; media qua `uploadBlob` | Không review trung tâm; phải discovery PDS, PKCE/PAR/DPoP | `CREDENTIAL_REQUIRED` |
| Mastodon | OAuth 2.0 trên từng instance | `profile`, `write:statuses`; thêm `write:media` | `POST /api/v1/statuses`, media qua `/api/v2/media` | Không review trung tâm; giới hạn/chính sách khác nhau theo instance | `CREDENTIAL_REQUIRED` |
| TikTok | Login Kit/OAuth user token | `video.publish` cho Direct Post; các flow upload dùng quyền theo docs hiện hành | query creator info, init post, chuyển media, poll status | Audit bắt buộc để public; UX bắt buộc phải cho creator xem/chọn/xác nhận; use case internal cross-posting có thể không được chấp nhận | `API_REVIEW_REQUIRED`, mặc định `NEEDS_ACTION` |

### Capability an toàn để seed

Bảng sau là **trần khả năng của API**, không phải cam kết connector đã implement. Backend chỉ nên trả `true` khi code, test và quyền thực tế đều sẵn sàng.

| Nền tảng | Text | Image | Video | Article/long-form | Delete | Native schedule |
|---|---:|---:|---:|---:|---:|---:|
| Instagram | Chỉ caption kèm media | Có | Có | Không | Chưa bật nếu chưa kiểm chứng flow hiện hành | Không; scheduler backend |
| Threads | Có | Có | Có | Không | Có điều kiện theo scope/API hiện hành | Không; scheduler backend |
| X | Có | Có | Có | Article là sản phẩm/quyền riêng; không seed mặc định | Có | Không; scheduler backend |
| LinkedIn | Có | Có | Có | Có | Có | Không; scheduler backend |
| WordPress | Có | Có | Có qua media library | Có | Có | Có (`future`) |
| Blogger | Có | HTML/image reference | Không coi là upload video trực tiếp | Có | Có | Có qua draft/publish date; vẫn quản lý bằng scheduler backend |
| dev.to | Có | Ảnh bằng URL trong Markdown/`main_image` | Không có upload video được xác minh | Có | Không có delete article được xác minh; có update/unpublish | Không; scheduler backend |
| Discord | Có | Có | Có như attachment trong giới hạn webhook | Không | Có với message do webhook tạo | Không; scheduler backend |
| Reddit | Text/link đã xác minh | Không seed khi chưa test flow media được duyệt | Không seed | Bài self/text | Có điều kiện token/scope | Không; scheduler backend |
| Bluesky | Có | Có | Có | Không | Có qua record delete | Không; scheduler backend |
| Mastodon | Có | Có | Có | Không | Có | API hỗ trợ `scheduled_at`, nhưng phải kiểm tra version/instance |
| TikTok | Caption đi cùng photo/video | Có | Có | Không | Không seed nếu chưa xác minh quyền/endpoint | Không dùng unattended scheduling; cần consent UI |

## 3. Quy tắc chung trước khi kết nối

1. Chuẩn bị ba hostname HTTPS ổn định, ví dụ `app.example.com`, `api.example.com`, `media.example.com`. OAuth callback phải trỏ về API, không trỏ về trình duyệt frontend.
2. Mỗi provider có một app-level credential ở secret manager/environment của backend. Token theo từng tài khoản nằm trong `PlatformCredential`/`OAuthToken`, được mã hóa AES-256-GCM. Không đưa client secret, access token, refresh token hoặc webhook URL vào `NEXT_PUBLIC_*`, log hay response frontend.
3. Đăng ký chính xác callback do backend công bố. Không tự suy đoán route: lấy route từ Swagger/OpenAPI của bản deploy và copy nguyên chuỗi, gồm scheme/host/path/trailing slash.
4. OAuth start phải sinh `state` một lần, có TTL, gắn user/provider và tiêu thụ đúng một lần. Dùng PKCE ở provider yêu cầu/hỗ trợ. Callback kiểm tra `state`, provider, redirect URI và account identity trước khi lưu token.
5. Chỉ xin scope tối thiểu. Thêm scope mới là một migration vận hành: cập nhật consent/review, buộc reconnect những account cần quyền mới và cập nhật capability sau test.
6. Media URL mà Meta/TikTok pull phải là HTTPS công khai, không redirect, đúng MIME/size và còn sống đủ lâu. Dùng URL ký có TTL rộng hơn toàn bộ thời gian queue + retry + xử lý; không để URL trỏ vào MinIO private nội bộ.
7. Scheduler chỉ enqueue job. Worker kiểm tra capability, token expiry, per-account limiter và idempotency trước khi gọi provider. Không blind-retry `401`, `403`, invalid media hay content rejected.
8. Với `429`, ưu tiên `Retry-After` hoặc rate-limit headers của chính response. Không hard-code một quota toàn hệ thống; khóa Redis phải tách theo `platform + account` và, nếu provider quy định, theo app/endpoint.
9. Lưu `externalPostId`, response đã redaction, URL công khai và timestamp. Sau timeout không rõ kết quả, gọi status/read endpoint nếu có; nếu không thể kết luận thì dùng `POSSIBLE_DUPLICATE`, không publish lại mù quáng.
10. Mỗi app review cần URL Privacy Policy, Terms, data deletion/revocation flow, screencast từ connect đến publish, mô tả vì sao cần từng scope và tài khoản reviewer. Nội dung khai báo phải đúng với hành vi production.

Hardening hiện tại: các base URL do account cấu hình (`siteUrl`, `baseUrl`, `serviceUrl`, `instanceUrl`) luôn phải là HTTPS công khai. Shared outbound guard resolve toàn bộ DNS record, chặn private/reserved/metadata ranges, pin connection vào IP đã kiểm tra, kiểm tra lại từng redirect và không cho redirect đổi origin để tránh rò credential. Chỉ ADMIN tin cậy được tạo/sửa account; firewall/egress proxy chặn loopback, metadata endpoint và mạng quản trị vẫn là lớp defense-in-depth bắt buộc.

## 4. Cấu hình đúng với release MVP trong source

Phần ma trận phía trên mô tả **trần khả năng của API chính thức**. Release hiện tại cố ý hẹp hơn. Nguồn sự thật khi vận hành là `GET /api/v1/connectors`, `GET /api/v1/platforms`, capability do seed tạo và kết quả `POST /api/v1/platform-accounts/{id}/test`.

### Những connector đã được code thực sự hỗ trợ

| Slug | MVP hiện publish được | Credential write-only | `externalId`/`username` | `settings` hữu hiệu | Hạn chế cần biết |
|---|---|---|---|---|---|
| `instagram` | Một ảnh + caption | `accessToken`; thêm `userId` nếu không dùng `externalId` | `externalId` = Instagram user ID | `apiVersion` dạng `vN.N`; `rateLimit`, `rateWindowSeconds` | Chưa có OAuth/refresh, video/carousel/delete; URL ảnh phải public. Connector chưa poll container status trước `media_publish`. |
| `threads` | Text hoặc một ảnh | `accessToken`; thêm `userId` nếu thiếu `externalId` | `externalId` = Threads user ID | `apiVersion` dạng `vN.N`; local rate settings | Chưa có OAuth/refresh, video/carousel/delete; tối đa 500 ký tự theo validator MVP. |
| `x` | Text, tối đa 280 ký tự | `accessToken` | `username` chỉ để tạo URL kết quả | local rate settings | Chưa có OAuth/refresh/media; có delete. Access token phải là user-context token có quyền write. |
| `linkedin` | Text cho member | OAuth tự lưu token; nếu cấu hình thủ công: `accessToken`, và `authorUrn` khi thiếu `externalId` | `externalId` = `urn:li:person:...` | OAuth copy `LINKEDIN_API_VERSION`; manual cần `apiVersion` dạng `YYYYMM`; local rate settings | OAuth LinkedIn đã bật; chưa hỗ trợ organization/media/delete; token hết hạn phải reconnect. |
| `wordpress` | Bài text/HTML có title | `siteUrl`, `username`, `applicationPassword` | Không bắt buộc | `publishStatus` (`publish`, `draft`, `pending`, `private`); local rate settings | Trạng thái khác `publish` trả `NEEDS_ACTION`; chưa upload/gắn media hoặc native schedule; có delete. |
| `blogger` | Bài có title/body | OAuth tự lưu token; thủ công: `accessToken`, thêm `blogId` nếu thiếu `externalId` | `externalId` = Blogger blog ID | `publishImmediately` boolean; local rate settings | Google OAuth đã bật và có refresh; draft trả `NEEDS_ACTION`; token dán thủ công không tự refresh; có delete, chưa media. |
| `devto` | Article Markdown có title/body, tags và canonical URL | `apiKey` | Không bắt buộc | `baseUrl` mặc định `https://dev.to/api`; `publishImmediately`; local rate settings | Không delete/media; `publishImmediately=false` tạo draft và trả `NEEDS_ACTION`. |
| `discord` | Text tối đa 2.000 ký tự | `webhookUrl` | Không bắt buộc | local rate settings | Chưa attachment/media/edit; có delete; chặn hostname webhook không phải Discord chính thức. |
| `bluesky` | Text tối đa 300 ký tự | `accessJwt`; `did` nếu thiếu `externalId`; tùy chọn `serviceUrl` | `externalId` = DID | local rate settings | Chưa ATProto OAuth/session refresh/PDS discovery/media/delete. `accessJwt` ngắn hạn khiến cấu hình này chỉ phù hợp pilot, không phải tích hợp production bền vững. |
| `mastodon` | Text | `instanceUrl`, `accessToken` | Không bắt buộc | `visibility`; local rate settings | Chưa dynamic OAuth/media/native schedule; có delete. Giới hạn ký tự vẫn do instance quyết định. |
| `reddit` | Luồng copy/open/confirm thủ công | Không cần | Tùy chọn | `manualUrl` tùy chọn | `ManualConnector`; job chuyển `NEEDS_ACTION`, không gọi Reddit API. |
| `tiktok` | Luồng copy/open/confirm thủ công | Không cần | Tùy chọn | `manualUrl` tùy chọn | `ManualConnector`; không upload/publish tự động khi app chưa qua audit/use-case approval. |

`rateLimit` mặc định là 10 request trong `rateWindowSeconds` mặc định 60 giây, áp dụng cục bộ theo `platform + account` qua Redis. Đây là lớp bảo vệ nội bộ, **không thay thế** quota/header của provider.

### Hai OAuth flow đã bật

Sau khi đăng nhập bằng role `ADMIN`, gọi `GET /api/v1/oauth/providers` để đọc trạng thái runtime. Release chỉ implement hai provider dưới đây; chúng trả `READY` khi đủ env bắt buộc, nếu thiếu sẽ trả `CREDENTIAL_REQUIRED`. Endpoint `/:provider/start` cũng chỉ cho `ADMIN`:

- LinkedIn: bắt đầu tại `GET /api/v1/oauth/linkedin/start`; callback production chính xác là `https://api.example.com/api/v1/oauth/linkedin/callback`. Backend yêu cầu env `LINKEDIN_API_VERSION`, xin `openid profile w_member_social`, đọc `userinfo`, tạo member account, lưu version vào settings và mã hóa token. Luồng này chưa kết nối LinkedIn organization/Page.
- Blogger qua Google: bắt đầu tại `GET /api/v1/oauth/google/start`; callback là `https://api.example.com/api/v1/oauth/google/callback`. Backend xin Blogger scope + offline access, liệt kê mọi blog của user, tạo một destination cho mỗi blog và tự refresh Google token khi có refresh token.

Frontend lấy `authorizationUrl` từ start endpoint rồi chuyển trình duyệt tới provider; callback backend xác minh state một lần và redirect về `FRONTEND_URL/accounts?oauth=success&provider=...`. Instagram, Threads, X, Reddit và TikTok được API providers trả đúng trạng thái review/research/manual, không có nút OAuth giả.

### Tạo account dùng credential thủ công

Ở frontend, đăng nhập role `ADMIN`, vào **Tài khoản → Kết nối / cấu hình**, chọn connector credential, nhập secret một lần rồi dùng **Lưu & kiểm tra**. Form không tải secret cũ về trình duyệt. API dưới đây là contract tương đương để tích hợp nội bộ hoặc xử lý sự cố; Swagger production có thể và nên bị khóa sau VPN/IP allowlist:

```http
POST /api/v1/platform-accounts
Authorization: Bearer <ADMIN_ACCESS_TOKEN>
Content-Type: application/json
```

Ví dụ WordPress an toàn để tạo ở trạng thái chưa bật:

```json
{
  "platformSlug": "wordpress",
  "name": "Blog công ty",
  "settings": {
    "publishStatus": "draft",
    "rateLimit": 5,
    "rateWindowSeconds": 60
  },
  "enabled": false,
  "credential": {
    "siteUrl": "https://blog.example.com",
    "username": "publisher-api",
    "applicationPassword": "<WORDPRESS_APPLICATION_PASSWORD>"
  }
}
```

Quy trình cho mọi credential thủ công:

1. Đặt secret **chỉ** trong object `credential`; API mã hóa AES-256-GCM và response không trả plaintext.
2. Dùng `externalId` cho ID destination ổn định nếu bảng trên yêu cầu; `username` không thay thế ID trừ khi connector nói rõ.
3. Account API connector mới tạo hoặc vừa rotate credential giữ trạng thái `RECONNECT_REQUIRED`. Gọi `POST /api/v1/platform-accounts/{id}/test`; chỉ test thành công mới chuyển account sang `CONNECTED` và ghi `lastTestedAt`.
4. Khi test pass, gọi `PATCH /api/v1/platform-accounts/{id}` với `{ "enabled": true }`.
5. Khi rotate secret, gọi `PUT /api/v1/platform-accounts/{id}/credential` với `{ "credential": { ... } }`, test lại rồi mới tiếp tục campaign.

Không nhập placeholder `<...>` thật vào API. Không chụp màn hình Swagger có token/webhook/API key và không lưu JSON credential trong shell history hoặc ticket.

### Luồng `NEEDS_ACTION`

Với Reddit/TikTok, tạo platform account không có `credential`, có thể đặt `settings.manualUrl`. Worker không gọi API bên ngoài và job trở thành `NEEDS_ACTION`. WordPress/Blogger cũng dùng trạng thái này khi connector đã tạo draft/pending/private thay vì bài public; manual payload khi đó gợi ý ID/URL vừa tạo.

Người vận hành mở `GET /api/v1/publish-jobs/{id}/manual-payload`, hoàn thành bước đăng/duyệt trên nền tảng, sau đó gọi `POST /api/v1/publish-jobs/{id}/mark-published` với `externalPostId` và URL nếu có. Luồng này cũng áp dụng cho dev.to draft (`publishImmediately=false`). Không đánh dấu thành công trước khi bài thực sự public/tồn tại đúng trạng thái mong muốn.

## 5. Instagram

**Trạng thái:** `OFFICIAL_API_VERIFIED` + `API_REVIEW_REQUIRED` + `CREDENTIAL_REQUIRED`.

### Chuẩn bị

1. Chuyển account đích sang Instagram Professional: Business hoặc Creator. Consumer/personal account không publish qua API này.
2. Tạo Meta app và thêm sản phẩm Instagram. Với tích hợp mới, ưu tiên **Instagram API with Instagram Login**; flow này không bắt buộc liên kết Facebook Page.
3. Khai báo OAuth redirect URI production chính xác, domain ứng dụng, Privacy Policy và data deletion instructions.
4. Xin đúng hai permission tối thiểu: `instagram_business_basic` và `instagram_business_content_publish`.
5. Thêm test account/app role để thử ở development. Trước khi phục vụ tài khoản không thuộc app roles, hoàn tất App Review/Advanced Access phù hợp và chuyển app Live.
6. Lưu app ID/app secret ở backend; token và Instagram-scoped user/account ID được lưu theo `PlatformAccount` và mã hóa.

Không trộn scope của hai flow. Nếu dự án chủ động dùng **Instagram API with Facebook Login**, account Professional phải liên kết Facebook Page và bộ quyền thường gồm `pages_show_list`, `instagram_basic`, `instagram_content_publish`, `pages_read_engagement`. Hai flow có host, object và token model khác nhau.

### Publish và vận hành

- Ảnh/Reel/carousel: tạo container bằng edge `/media`, poll trạng thái với ID container khi media cần xử lý, sau đó gọi `/media_publish` với `creation_id`.
- Media để Meta tải phải nằm trên public HTTPS URL. Validate format/aspect ratio/size theo tài liệu của loại media tại thời điểm publish.
- Không coi caption-only là post Instagram hợp lệ; cần media.
- Query endpoint publishing-limit/usage của flow đang dùng nếu được cung cấp và đọc Graph usage headers. Quota thay đổi theo version/account, vì vậy không ghi một con số cố định vào code.
- Container hoặc upload hết hạn thì tạo lại container; không reuse ID cũ. `media_publish` timeout phải được đối soát trước khi retry.

**Smoke test release MVP:** nhập token/user ID của account test → `POST .../{id}/test` đọc profile → gắn đúng một ảnh public vào variant → publish → lưu media ID/permalink → revoke token → test/publish lại và xác nhận account cần reconnect. Dọn bài test thủ công vì connector chưa có delete.

Nguồn chính thức: [Instagram API with Instagram Login](https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/), [Content Publishing](https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/content-publishing/), [Meta-maintained Instagram Postman collection](https://www.postman.com/meta/instagram/documentation/6yqw8pt/instagram-api), [Meta App Review](https://developers.facebook.com/docs/app-review/).

## 6. Threads

**Trạng thái:** `OFFICIAL_API_VERIFIED` + `API_REVIEW_REQUIRED` + `CREDENTIAL_REQUIRED`.

### Chuẩn bị

1. Tạo/cấu hình Threads app trong Meta App Dashboard và nhập redirect URI backend.
2. Xin `threads_basic` và `threads_content_publish`. Chỉ xin `threads_delete`, reply/insights/search permissions nếu tính năng tương ứng thực sự có trong UI và connector.
3. Kết nối test user/app role; đổi short-lived token sang long-lived token theo flow chính thức và refresh token còn hiệu lực trước khi hết hạn.
4. Hoàn thành App Review và đưa app Live trước khi người dùng ngoài app roles kết nối.

### Publish và vận hành

- API host là `https://graph.threads.net`.
- Tạo text/image/video/carousel container bằng `POST /me/threads`. Ảnh/video dùng public URL để Threads pull.
- Khi container sẵn sàng, gọi `POST /me/threads_publish?creation_id=...`. Text có tùy chọn auto-publish, nhưng dùng cùng state machine hai bước giúp log/idempotency nhất quán.
- Poll `id,status,error_message` cho container. Container chưa publish trong 24 giờ có thể thành `EXPIRED`; tạo mới thay vì retry ID đã hết hạn.
- Trước khi enqueue số lượng lớn, gọi `GET /me/threads_publishing_limit?fields=quota_usage,config,...`. Dùng `config` trả về thay vì hard-code quota.

**Smoke test release MVP:** nhập token/user ID → test connection → publish text → publish một ảnh public → lưu Threads post ID/permalink → thử token hết hạn và xác nhận reconnect. Quota endpoint, video/carousel/delete là DoD cho lần mở rộng sau, không phải smoke test hiện tại.

Nguồn chính thức: [Threads API docs](https://developers.facebook.com/docs/threads/), [Meta-maintained Threads Postman collection](https://www.postman.com/meta/threads/documentation/dht3nzz/threads-api), [publishing quota request](https://www.postman.com/meta/threads/request/w3x0n4g/retrieve-publishing-quota-limit), [container status](https://www.postman.com/meta/threads/request/m47wqlq/check-container-s-publishing-status).

## 7. X

**Trạng thái:** `OFFICIAL_API_VERIFIED` + `CREDENTIAL_REQUIRED`; quyền truy cập và billing phụ thuộc Developer Console.

### Chuẩn bị

1. Tạo developer account, Project và App trong X Developer Console; bật user authentication.
2. Chọn OAuth 2.0 Authorization Code + PKCE cho web app. Callback phải khớp tuyệt đối.
3. Scope text tối thiểu: `tweet.read tweet.write users.read`. Thêm `media.write` khi upload media và `offline.access` nếu worker cần refresh token chạy nền.
4. Lưu client ID; client secret chỉ áp dụng theo loại client và luôn ở backend. Không dùng app-only bearer token để đăng thay người dùng.
5. Kiểm tra product access, credit/billing và giới hạn ngay trong console trước khi bật connector. Giá và access tier thay đổi, không cố định số tiền trong tài liệu nội bộ.

### Publish và vận hành

- Tạo post bằng `POST https://api.x.com/2/tweets`; xóa bằng `DELETE /2/tweets/:id`.
- Với ảnh/GIF/video, hoàn tất media upload trước rồi truyền media ID vào create post. Dùng flow initialize/append/finalize và poll processing cho video khi API yêu cầu.
- Token OAuth 2 không có `offline.access` thường ngắn hạn; có scope này thì lưu và xoay refresh token atomically.
- Đọc `x-rate-limit-limit`, `x-rate-limit-remaining`, `x-rate-limit-reset`. Tại thời điểm đối chiếu, tài liệu X liệt kê limit riêng theo user/app/endpoint; con số có thể đổi theo access tier nên response/console mới là nguồn chạy thật.
- Self-serve API có thêm hạn chế nội dung/reply. Connector phải trả lỗi chính sách rõ ràng, không cố lách bằng browser automation.

**Smoke test release MVP:** nhập user-context access token → test `/2/users/me` → post text ≤ 280 ký tự → xác minh ID/URL → delete bài test → token sai/hết hạn phải báo reconnect. Media upload, OAuth PKCE/refresh và quota integration là DoD tương lai.

Nguồn chính thức: [Manage Posts](https://docs.x.com/x-api/posts/manage-tweets/introduction), [OAuth 2.0 Authorization Code with PKCE](https://docs.x.com/fundamentals/authentication/oauth-2-0/authorization-code), [Media upload](https://docs.x.com/x-api/media/introduction), [X API rate limits](https://docs.x.com/x-api/fundamentals/rate-limits).

## 8. LinkedIn

**Trạng thái:** đăng cá nhân `OFFICIAL_API_VERIFIED` + `CREDENTIAL_REQUIRED`; đăng Organization thường thêm `API_REVIEW_REQUIRED`.

### Chuẩn bị

1. Tạo app tại LinkedIn Developer Portal, liên kết company page sở hữu app, khai báo redirect URL backend.
2. Đăng cá nhân: thêm product **Share on LinkedIn** để có `w_member_social`. OAuth code của release còn gọi `/v2/userinfo` với `openid profile`, vì vậy app cũng phải bật **Sign In with LinkedIn using OpenID Connect**; thiếu một trong hai product thì connect sẽ lỗi scope/product.
3. Đăng Organization: xin `w_organization_social`, đăng ký Community Management access theo tier/quy trình hiện hành và dùng member có role `ADMINISTRATOR`, `DIRECT_SPONSORED_CONTENT_POSTER` hoặc `CONTENT_ADMIN` trên Page.
4. Không xin `r_member_social` chỉ để publish; đây là quyền restricted đọc feed và không cần cho create cơ bản.
5. OAuth 2.0 3-legged cấp access token. Tài liệu LinkedIn nêu access token thông thường có thời hạn; programmatic refresh token chỉ dành cho partner được chấp thuận. Nếu app không được cấp refresh, hiển thị reconnect trước/đúng khi token hết hạn.

### Publish và vận hành

- Dùng Posts API mới: `POST https://api.linkedin.com/rest/posts`; không xây connector mới trên UGC Posts cũ.
- Mọi request versioned cần `Linkedin-Version: YYYYMM` là một phiên bản còn được hỗ trợ và `X-Restli-Protocol-Version: 2.0.0`. Theo dõi migration/sunset; không hard-code một version đã hết hạn vô thời hạn.
- Text, image, video, document, article và multi-image có flow riêng. Upload/initialize media bằng API tương ứng, chờ asset sẵn sàng rồi tham chiếu trong Posts API.
- LinkedIn áp limit theo application và member, reset theo chu kỳ công bố. Giá trị chuẩn không public; xem Developer Portal > Analytics. `429` phải được hoãn theo limiter, không retry dồn.

**Smoke test release MVP:** OAuth member → xác minh person URN → đặt `apiVersion` còn hỗ trợ → text post → lưu post URN → token hết hạn hoặc version invalid phải báo reconnect/lỗi rõ ràng. Organization, image và delete chỉ test sau khi capability tương ứng được implement.

Nguồn chính thức: [Posts API](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/posts-api), [Share on LinkedIn và `w_member_social`](https://learn.microsoft.com/en-us/linkedin/consumer/integrations/self-serve/share-on-linkedin), [Sign In with LinkedIn using OpenID Connect](https://learn.microsoft.com/linkedin/consumer/integrations/self-serve/sign-in-with-linkedin-v2), [3-legged OAuth](https://learn.microsoft.com/en-us/linkedin/shared/authentication/authorization-code-flow), [Community Management access](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/community-management-overview), [rate limits](https://learn.microsoft.com/en-us/linkedin/shared/api-guide/concepts/rate-limits).

## 9. WordPress self-hosted

**Trạng thái:** `OFFICIAL_API_VERIFIED` + `CREDENTIAL_REQUIRED`; không cần app review trung tâm.

Phạm vi connector này là website chạy WordPress core có REST API. WordPress.com có hạ tầng/auth API riêng; không tự coi credential WordPress.com tương đương Application Password của site self-hosted.

### Chuẩn bị trên từng site

1. Bắt buộc bật HTTPS hợp lệ và xác nhận `GET https://site.example/wp-json/` trả REST index.
2. Tạo một WordPress user riêng cho automation với role tối thiểu đủ tạo/publish bài và upload media. Không dùng tài khoản owner chung nếu không cần.
3. Vào `Users > Profile` (hoặc Edit User), tạo **Application Password** tên `Social Publisher production`. Mật khẩu chỉ hiện một lần.
4. Nhập vào backend: base URL canonical của site, username và Application Password. Backend mã hóa password; không lưu password đăng nhập WordPress chính.
5. Kiểm tra plugin security, reverse proxy/WAF và host không chặn `/wp-json/wp/v2/*` hoặc header `Authorization`.

### Publish và vận hành

- Auth từ server bằng HTTPS Basic Auth: `username:application-password`.
- Upload file vào `POST /wp-json/wp/v2/media`, lấy media ID; tạo bài tại `POST /wp-json/wp/v2/posts` với `title`, `content`, `status`, `categories`, `tags`, `featured_media`.
- Dùng `status=draft` cho review; `publish` cho ngay; `future` cùng `date`/`date_gmt` nếu muốn native scheduling. Trong dự án này vẫn nên để scheduler backend chịu trách nhiệm và dùng idempotency key nội bộ.
- Response có `id` và `link`; lưu cả hai. Xóa Application Password trên site phải làm account chuyển `Reconnect Required`.
- WordPress core không công bố một rate limit chung. Limit nằm ở hosting, CDN, WAF hoặc plugin; đọc `429`/`Retry-After`, phân tách limiter theo site và giảm concurrency media upload.

**Smoke test release MVP:** REST discovery → test current user bằng Application Password → tạo một article text/HTML. Với `publishStatus=publish`, xác minh job `PUBLISHED` và `id`/`link`; với draft/pending/private, xác minh job `NEEDS_ACTION`, publish/review trên WordPress rồi `mark-published` → trash/delete bài test → revoke Application Password và kiểm tra lỗi 401. Upload media/update/native schedule là DoD tương lai.

Nguồn chính thức: [REST Posts](https://developer.wordpress.org/rest-api/reference/posts/), [REST Media](https://developer.wordpress.org/rest-api/reference/media/), [REST authentication](https://developer.wordpress.org/rest-api/using-the-rest-api/authentication/), [Application Passwords](https://developer.wordpress.org/advanced-administration/security/application-passwords/).

## 10. Blogger

**Trạng thái:** `OFFICIAL_API_VERIFIED` + `CREDENTIAL_REQUIRED`; có thể thêm `API_REVIEW_REQUIRED` theo trạng thái consent screen/scopes của Google Cloud project.

### Chuẩn bị

1. Tạo Google Cloud project, bật **Blogger API v3**.
2. Cấu hình OAuth consent screen, homepage, Privacy Policy và Authorized domains. Chọn Internal chỉ khi toàn bộ user thuộc cùng Google Workspace và chính sách tổ chức cho phép; nếu không chọn External.
3. Tạo OAuth Client ID loại Web application, thêm chính xác callback HTTPS của backend.
4. Xin scope `https://www.googleapis.com/auth/blogger`. Với worker chạy nền, authorization request cần offline access và consent đúng cách để nhận refresh token; không giả định Google luôn trả refresh token ở mỗi lần reconnect.
5. Nếu app External đi production, xem trang Data Access/Verification trong console. Phân loại scope và yêu cầu verification có thể thay đổi; làm theo trạng thái console hiện tại, không dựa vào một nhãn cũ trong tài liệu dự án.

### Publish và vận hành

- Sau OAuth, gọi `GET /blogger/v3/users/self/blogs` để người dùng chọn blog và lưu `blogId`; không bắt người dùng tự chép ID nếu có thể discovery.
- Tạo bài bằng `POST https://www.googleapis.com/blogger/v3/blogs/{blogId}/posts`. Tham số `isDraft=true` tạo draft.
- Publish draft bằng `POST /blogger/v3/blogs/{blogId}/posts/{postId}/publish`; API có tùy chọn `publishDate` theo tài liệu hiện hành.
- Lưu `postId` và URL trả về. Nội dung là HTML; sanitize đầu vào và không coi Blogger là kho upload video.
- Quota xem trong Google Cloud Console > APIs & Services > Quotas. Xử lý cả lỗi quota 403 và 429 theo reason/header, dùng exponential backoff có jitter; không ghi một con số quota cố định.

**Smoke test release MVP:** OAuth offline → backend tự list/tạo destination cho blog → test connection → tạo một bài có title/body → xác minh URL → delete → buộc access token hết hạn để kiểm tra refresh → revoke Google grant và xác nhận reconnect. Update bài hiện có/media là DoD tương lai.

Nguồn chính thức: [Using Blogger API](https://developers.google.com/blogger/docs/3.0/using), [`posts.insert`](https://developers.google.com/blogger/docs/3.0/reference/posts/insert), [`posts.publish`](https://developers.google.com/blogger/docs/3.0/reference/posts/publish), [OAuth web-server flow](https://developers.google.com/identity/protocols/oauth2/web-server), [Google scope verification](https://developers.google.com/identity/protocols/oauth2/production-readiness/sensitive-scope-verification).

## 11. dev.to / Forem

**Trạng thái:** `OFFICIAL_API_VERIFIED` + `CREDENTIAL_REQUIRED`; không có OAuth/app review cho flow API key này.

### Chuẩn bị

1. Đăng nhập DEV, mở user settings/extensions và tạo API key riêng tên `Social Publisher production`.
2. Lưu key như credential theo account, không đặt làm global env nếu hệ thống có nhiều tài khoản DEV.
3. Connector gửi `api-key: ...`, `Accept: application/vnd.forem.api-v1+json` và một `User-Agent` nhận diện ứng dụng.

### Publish và vận hành

- Tạo article tại `POST https://dev.to/api/articles` với object `article`: `title`, `body_markdown`, `published`, `tags`, và tùy chọn `canonical_url`, `main_image`, `description`, `organization_id`.
- Khuyến nghị tạo draft (`published=false`), review rồi update/publish. Nếu đây là bản phân phối từ website gốc, đặt `canonical_url` về bài gốc để tránh cạnh tranh SEO.
- `main_image` là URL; tài liệu create article không chứng minh một flow upload binary riêng, nên không invent endpoint upload.
- API v1 là phiên bản hiện hành và yêu cầu Accept header nói trên; API v0 là legacy/deprecated. Tài liệu v0 cũ từng nêu 10 create request/30 giây, nhưng contract v1 hiện không công bố con số cố định đó. Không mang quota v0 sang v1: quan sát 429/header thực tế, giới hạn bảo thủ và backoff.
- Không dùng API để spam hàng loạt. Tags/nội dung phải theo DEV Terms/Community Code; lỗi moderation/content là non-retryable.

API hiện có update và unpublish article; không có delete article thông thường được xác minh trong contract public, vì vậy không khai báo capability delete.

**Smoke test release MVP:** auth bằng API key → đọc current user → tạo article title/Markdown có tags/canonical URL. Với draft (`publishImmediately=false`), xác minh job `NEEDS_ACTION`, publish trên DEV rồi `mark-published`; với publish ngay, xác minh job/URL → key invalid trả 401 và account báo lỗi. Update và unpublish là DoD tương lai của connector dù API chính thức có hỗ trợ.

Nguồn chính thức: [Forem API versioning/auth](https://developers.forem.com/api), [Forem API v1](https://developers.forem.com/api/v1), [legacy article docs có rate-limit create](https://developers.forem.com/api/v0), [DEV Terms](https://dev.to/terms).

## 12. Discord

**Trạng thái:** `OFFICIAL_API_VERIFIED` + `CREDENTIAL_REQUIRED`; không cần bot hoặc app review cho incoming webhook thủ công.

### Cách đơn giản: webhook theo destination

1. Trên Discord server, người có quyền vào `Server Settings > Integrations > Webhooks`.
2. Tạo webhook, đặt tên/avatar, chọn đúng channel và copy URL.
3. Dán URL vào form credential của backend. URL chứa `webhook_id` và `webhook_token`, phải được bảo vệ như password.
4. Tạo một webhook cho mỗi destination/channel cần tách quyền. Khi nghi lộ, rotate/delete webhook trong Discord rồi cập nhật credential.

Nếu muốn người dùng chọn server/channel qua OAuth, dùng scope `webhook.incoming`; token response sẽ chứa webhook object. Đây là flow khác với bot token và chỉ nên thêm khi UI đã hỗ trợ đầy đủ.

### Publish và vận hành

- Execute webhook với `wait=true` để nhận message object/ID thay vì chỉ 204; ID cần cho audit, edit/delete và URL.
- Nội dung text có giới hạn schema hiện hành (Discord docs hiện nêu `content` tối đa 2.000 ký tự); nội dung dài phải split có chủ đích hoặc đính kèm file, không cắt âm thầm.
- Upload attachment bằng multipart theo schema webhook. Dùng `allowed_mentions` hạn chế `parse` để nội dung nhập/AI không ping `@everyone`, role hoặc user ngoài ý muốn.
- Rate limit là theo route/bucket và có cả global limit. Đọc `X-RateLimit-Bucket`, `Remaining`, `Reset-After` và body `retry_after` khi 429; không hard-code “N requests/second”.
- Không log nguyên webhook URL. Khi hiển thị, chỉ hiện server/channel label và bốn ký tự cuối của webhook ID nếu cần đối soát.

**Smoke test release MVP:** test webhook → gửi text với `wait=true` → lưu message ID/URL → delete message → rotate webhook và xác nhận credential cũ thất bại. Attachment và edit chỉ test sau khi capability được implement.

Nguồn chính thức: [Webhook Resource/Execute Webhook](https://docs.discord.com/developers/resources/webhook), [OAuth2 và `webhook.incoming`](https://docs.discord.com/developers/topics/oauth2), [Discord rate limits](https://docs.discord.com/developers/topics/rate-limits).

## 13. Reddit

**Trạng thái:** API endpoint được xác minh, nhưng connector production là `API_REVIEW_REQUIRED` + `CREDENTIAL_REQUIRED`; mặc định `NEEDS_ACTION` cho đến khi Reddit phê duyệt đúng use case.

Đây là điểm dễ sai nhất nếu dùng hướng dẫn Reddit cũ. Theo Help Center cập nhật 2026, Data API dành cho **approved developers**; commercial use cần permission và có thể cần contract. Không được giả định trang tạo “script/web app” kiểu cũ tự động cấp quyền production.

### Quy trình hợp lệ

1. Xác định rõ use case là non-commercial hay commercial. Social Publisher phục vụ doanh nghiệp/khách hàng hoặc là sản phẩm monetized phải khai báo commercial trung thực.
2. Nộp form truy cập Data API/Developer Platform theo Help Center. Chờ Reddit xác nhận access, điều khoản và quota.
3. Chỉ sau khi được duyệt mới cấu hình OAuth redirect/client theo hướng dẫn Reddit cấp cho app. Với external Data API publish, scope tối thiểu là `submit`; có thể thêm `identity` để test account.
4. Gửi User-Agent mô tả rõ app/version/contact và gọi API qua OAuth host theo tài liệu được cấp.
5. Trước khi submit, đọc subreddit rules và `POST requirements` endpoint nếu access cho phép. Người vận hành phải chọn subreddit và xác nhận nội dung không spam/self-promotion trái rule.

### Publish và vận hành

- Endpoint Data API được liệt kê là `POST /api/submit`. Capability an toàn ban đầu chỉ là self/text và link post; không bật image/video nếu flow tương ứng chưa được duyệt và integration-tested.
- Parse `X-Ratelimit-Used`, `X-Ratelimit-Remaining`, `X-Ratelimit-Reset`/429 nếu Reddit trả về. Không dựa vào các con số trong tài liệu OAuth archive cũ.
- Lỗi moderator removal, subreddit restriction, spam/content policy là non-retryable hoặc `NEEDS_ACTION`.
- Devvit là nền tảng chạy app bên trong Reddit, có Reddit API được quản lý auth. Nó không phải drop-in credential cho worker ngoài VPS; external endpoint/hosting bị hạn chế theo capability Devvit. Chỉ đổi kiến trúc sang Devvit khi Reddit xác nhận phù hợp.

Nếu chưa được phê duyệt: AI vẫn tạo bản Reddit, UI cho **Copy Content**, **Open Subreddit** và **Mark as Published**. Không thay bằng Playwright/browser/cookie automation.

**Smoke test release MVP:** tạo manual destination → chạy campaign → lấy manual payload → mở trang submit chính thức → người dùng tự đăng → nhập external ID/URL và mark published. **DoD chỉ sau khi Reddit phê duyệt connector API:** OAuth → identity/requirements → submit vào subreddit test được phép → đối soát/delete/revoke/429.

Nguồn chính thức: [Developer Platform & Accessing Reddit Data](https://support.reddithelp.com/hc/en-us/articles/14945211791892-Developer-Platform-Accessing-Reddit-Data), [Data API Terms](https://redditinc.com/policies/data-api-terms), [Reddit Data API endpoint reference](https://www.reddit.com/dev/api/), [Devvit Reddit API overview](https://developers.reddit.com/docs/capabilities/server/reddit-api), [Devvit FAQ](https://developers.reddit.com/docs/guides/faq).

## 14. Bluesky / AT Protocol

**Trạng thái:** `OFFICIAL_API_VERIFIED` + `CREDENTIAL_REQUIRED`; không có app review trung tâm.

### Chuẩn bị đúng cho ứng dụng nhiều người dùng

1. Dùng AT Protocol OAuth, không yêu cầu người dùng nhập password Bluesky. App password chỉ phù hợp bot/CLI/single-purpose account theo hướng dẫn Bluesky.
2. Dùng SDK OAuth chính thức/được Bluesky liệt kê. Profile này bắt buộc Authorization Code, PKCE, PAR và DPoP; tự viết toàn bộ flow rất dễ sai nonce/key rotation/session refresh.
3. Publish public client metadata JSON qua HTTPS, status 200 trực tiếp, `Content-Type: application/json`, không redirect. `client_id` chính là URL metadata.
4. Metadata khai báo exact redirect URI, `authorization_code`, `refresh_token` nếu cần, DPoP và permission/scope hiện hành. Hệ permission đang tiến hóa; dùng permission set chính thức mới nhất. `transition:generic` chỉ là scope chuyển tiếp, không nên đóng đinh lâu dài.
5. Khi user nhập handle, resolve/verify DID và discovery PDS/authorization server. Lưu DID làm external account ID; handle có thể đổi.

### Publish và vận hành

- Authenticated write phải gửi đến PDS đã discovery của account, không hard-code `bsky.social` cho mọi người dùng.
- Tạo record collection `app.bsky.feed.post` bằng `com.atproto.repo.createRecord`; lưu AT URI và CID.
- Ảnh: upload blob trước, rồi embed blob reference và alt text; tài liệu Bluesky hiện hỗ trợ tối đa 4 ảnh, mỗi ảnh tối đa 2 MB. Luôn kiểm tra docs/server vì PDS có thể khác.
- Video dùng service upload/job chính thức và chờ blob/job sẵn sàng trước khi tạo record; account cần email verified và chịu quota video riêng.
- Bluesky công bố write points và request limits theo account/IP trên PDS của họ (tại thời điểm đối chiếu: create/update/delete có trọng số riêng). Đừng coi các số đó là universal cho PDS khác; đọc 429/headers và cấu hình per-PDS limiter.

**Smoke test release MVP:** lấy `accessJwt` hợp lệ của account test theo cách an toàn ngoài ứng dụng → cấu hình DID/service URL → test profile → publish text ≤ 300 ký tự → lưu URI/CID → token hết hạn phải thất bại rõ ràng. **DoD production tương lai:** ATProto OAuth SDK + PDS discovery + refresh, rồi mới test image/alt text, video và delete.

Nguồn chính thức: [Bluesky OAuth guidance](https://bsky.network/docs/oauth-client/), [AT Protocol OAuth specification](https://atproto.com/specs/oauth), [Bluesky API/posting](https://bsky.network/docs/bluesky-api/), [rate limits](https://bsky.network/docs/rate-limits/), [video upload](https://bsky.network/docs/about-bluesky-content/video/).

## 15. Mastodon

**Trạng thái:** `OFFICIAL_API_VERIFIED` + `CREDENTIAL_REQUIRED`; không có review trung tâm, nhưng từng instance có policy riêng.

### Chuẩn bị cho federation

1. Form connect phải hỏi domain instance, ví dụ `mastodon.social`, và chuẩn hóa về HTTPS origin canonical. Backend chặn userinfo, hostname/IP private-reserved, DNS rebinding và redirect đổi origin; vẫn nên nhập origin không có path để endpoint Mastodon được ghép chính xác.
2. Discovery/call `POST /api/v1/apps` trên chính instance để đăng ký OAuth app động. Lưu client credential theo instance, mã hóa như secret.
3. Dùng OAuth Authorization Code trên instance đó. Scope tối thiểu: `profile` (nhận diện account), `write:statuses`; thêm `write:media` khi upload. Có thể discovery authorization-server metadata/scopes khi instance hỗ trợ.
4. Sau callback, verify account bằng token, lưu đầy đủ `acct` và instance domain. Không coi username đơn lẻ là unique toàn federation.

### Publish và vận hành

- Đọc `GET /api/v2/instance` để lấy cấu hình động: max characters, media count/size/MIME và feature support. Không hard-code giới hạn của mastodon.social.
- Upload bằng `POST /api/v2/media`; API có thể xử lý async, vì vậy poll attachment cho đến khi URL sẵn sàng. Tạo status bằng `POST /api/v1/statuses`.
- Gửi `Idempotency-Key` ổn định cho create status. Tài liệu Mastodon nêu server lưu key trong một khoảng hữu hạn; idempotency database của dự án vẫn là lớp bảo vệ chính.
- `scheduled_at` được endpoint status hỗ trợ ở phiên bản phù hợp; kiểm tra instance version/capability. Nếu không hỗ trợ, scheduler backend enqueue đúng giờ.
- Default của Mastodon core hiện được tài liệu nêu theo cửa sổ account/IP và media riêng, nhưng admin instance có thể thay đổi. Đọc `X-RateLimit-Limit`, `Remaining`, `Reset` và 429 của từng instance.

**Smoke test release MVP:** nhập instance URL/access token có `write:statuses` → verify credentials → publish text → xác minh URL → delete → revoke token và kiểm tra lỗi auth. Dynamic app registration/OAuth, instance-config validation, media/alt text và native schedule là DoD tương lai.

Nguồn chính thức: [Mastodon app guidelines](https://docs.joinmastodon.org/api/guidelines/), [app registration](https://docs.joinmastodon.org/methods/apps/), [OAuth scopes](https://docs.joinmastodon.org/api/oauth-scopes/), [status API](https://docs.joinmastodon.org/methods/statuses/), [media API](https://docs.joinmastodon.org/methods/media/), [rate limits](https://docs.joinmastodon.org/api/rate-limits/).

## 16. TikTok

**Trạng thái:** `OFFICIAL_API_VERIFIED` + `API_REVIEW_REQUIRED` + `CREDENTIAL_REQUIRED`; với mục tiêu “internal tool tự động cross-post cho các account đội ngũ quản lý”, mặc định `NEEDS_ACTION/MANUAL` cho đến khi TikTok chấp thuận bằng văn bản/audit.

### Vì sao không được coi là scheduler hoàn toàn tự động

Content Posting API có Direct Post, nhưng Content Sharing Guidelines cập nhật 2026 yêu cầu creator có nhận biết và kiểm soát đầy đủ. TikTok nêu rõ các ví dụ không được chấp nhận gồm app sao chép nội dung tùy ý từ nền tảng khác và utility chỉ dùng để upload vào account của chính đội ngũ. Vì vậy kiến trúc Social Publisher chỉ nên bật Direct Post sau khi TikTok audit **đúng use case này**, không suy ra từ việc endpoint trả 200 ở sandbox.

Client chưa audit chỉ được tối đa phạm vi test mà TikTok quy định: tài liệu hiện nêu tối đa 5 user hoạt động/24 giờ và post ở `SELF_ONLY`; public visibility cần audit. Cả client đã audit vẫn chịu creator cap và posting cap động.

### Chuẩn bị/audit

1. Tạo TikTok for Developers app, thêm Content Posting API/Direct Post, cấu hình Login Kit redirect URI.
2. Xin và được duyệt `video.publish`; target user cũng phải authorize scope này. Chỉ thêm `video.upload` cho flow Upload phù hợp, không xin dư.
3. Xác minh ownership domain/URL prefix dùng cho `PULL_FROM_URL`; media phải HTTPS, không redirect và còn truy cập được cho đến khi TikTok pull xong.
4. Xây trang Publish to TikTok đúng UX trước khi nộp audit: hiển thị nickname, preview, title/caption editable, privacy options từ creator info và không chọn mặc định, comment/duet/stitch theo capability và người dùng tự bật, commercial-content disclosure, consent theo policy.
5. Chuẩn bị screencast, test credentials, Privacy Policy/Terms và giải thích đối tượng người dùng rộng rãi/use case original content. Nếu audit từ chối use case, giữ connector ở manual.

### Publish và vận hành

- Mỗi lần publish phải gọi `POST /v2/post/publish/creator_info/query/` và kiểm tra `privacy_level_options`, interaction flags, `max_video_post_duration_sec`, creator/posting eligibility.
- Sau khi user chọn metadata và xác nhận, video Direct Post init bằng `POST /v2/post/publish/video/init/`; photo dùng `POST /v2/post/publish/content/init/` với `post_mode=DIRECT_POST` và `media_type=PHOTO`.
- Dùng `PULL_FROM_URL` cho file đã nằm trên object storage của server; `FILE_UPLOAD` cho file local/user device theo guideline. Với upload chunk, tuân thủ `Content-Range`/chunk constraints chính thức.
- Poll `/v2/post/publish/status/fetch/` hoặc xử lý webhook để chuyển `PROCESSING` thành kết quả cuối. Moderation có thể mất thời gian; không đánh dấu `PUBLISHED` ngay khi nhận `publish_id`.
- Tài liệu endpoint hiện nêu 6 init request/phút trên mỗi user token và status fetch có limit riêng. Dùng header/error thực tế; creator daily cap động thường được TikTok mô tả “around” một giá trị, không biến nó thành quota cố định.
- Không thêm logo, watermark, link hoặc promotional text ngoài ý muốn vào media. Content policy/consent failure là non-retryable.

**Fallback hợp lệ:** tạo caption/media package, cho user xem preview → **Open TikTok**/**Download Media**/**Copy Caption** → user đăng thủ công → **Mark as Published**. Không tự động hóa login/2FA/upload bằng browser.

**Smoke test release MVP:** tạo manual destination → campaign sinh `NEEDS_ACTION` → người dùng xem/copy caption, mở TikTok Upload, tự chọn media/privacy rồi xác nhận → chỉ mark published sau khi có bài/ID thật. **DoD sau audit và sau khi code Direct Post:** OAuth → creator info → consent UI đầy đủ → init/transfer/poll → token refresh/revoke → kiểm tra hạn chế `SELF_ONLY` của app chưa audit.

Nguồn chính thức: [Content Posting API - Get Started](https://developers.tiktok.com/docs/en/content-posting-api-get-started), [Content Sharing Guidelines](https://developers.tiktok.com/docs/en/content-sharing-guidelines), [Direct Post reference](https://developers.tiktok.com/docs/en/content-posting-api-reference-direct-post), [Media Transfer Guide](https://developers.tiktok.com/docs/en/content-posting-api-media-transfer-guide), [TikTok API scopes](https://developers.tiktok.com/docs/en/tiktok-api-scopes).

## 17. Checklist đưa từng account vào production

Không bật `enabled=true` chỉ vì đã lưu credential. Với từng account/destination:

- [ ] Provider app ở đúng mode/tier và review/audit đã approved nếu cần.
- [ ] Callback production khớp tuyệt đối; frontend origin/API origin không bị nhầm.
- [ ] Scope thực cấp được đọc từ token/debug endpoint và đủ cho capability bật.
- [ ] `testConnection()` trả external ID/username đúng account người vận hành mong đợi.
- [ ] Credential được mã hóa, redacted trong log/API, có `expiresAt`/refresh metadata.
- [ ] Text validation, media validation và public media fetch đã pass.
- [ ] Publish smoke test thật thành công; `externalPostId` và published URL được lưu.
- [ ] Retry 429/5xx/timeout được test; 401/403/content reject không blind-retry.
- [ ] Idempotency test chứng minh hai worker không tạo hai bài.
- [ ] Revoke/expire test đưa account về `EXPIRED` hoặc `RECONNECT_REQUIRED`.
- [ ] Policy owner, subreddit/channel/blog/site/instance và timezone đã cấu hình.
- [ ] Có runbook rotate/revoke credential và người chịu trách nhiệm.

## 18. Theo dõi thay đổi API

Hàng tháng và trước mỗi release connector:

1. Kiểm tra changelog/version sunset của Meta, X, LinkedIn, Google, TikTok.
2. So sánh scope đã grant với scope connector khai báo; không tự tăng permission.
3. Chạy contract/mock test, sau đó smoke test trên account sandbox/test thật.
4. Đọc quota/rate limit trong provider console và response headers; cập nhật limiter config mà không sửa business core.
5. Nếu tài liệu chính thức mâu thuẫn hoặc capability không còn chắc chắn, tắt capability và đặt `API_RESEARCH_REQUIRED`/`NEEDS_ACTION` trước khi deploy.



