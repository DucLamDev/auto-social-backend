# Danh mục API, token và mức hỗ trợ của các nền tảng mở rộng

> Đối chiếu nguồn chính thức: **2026-10-08**. API, scope, entitlement và chính sách có thể thay đổi. Kiểm tra lại link chính thức trước mỗi lần go-live hoặc app review.

Tài liệu này trả lời hai câu hỏi khác nhau:

1. Nền tảng có API chính thức để tạo nội dung hay không?
2. Release hiện tại của Social Publisher đã có connector cho API đó hay chưa?

Có token **không đồng nghĩa** dán token vào `.env` là hệ thống sẽ đăng được. Một nền tảng mới còn cần connector backend, capability/seed, form credential hoặc OAuth, validation, rate limit, error mapping, idempotency và integration test bằng account thật.

## 1. Quy ước

| Nhãn | Ý nghĩa |
|---|---|
| `CURRENT` | Source hiện tại có connector và đường cấu hình phù hợp. Vẫn phải smoke test bằng account thật. |
| `BUILD` | Có API chính thức phù hợp nhưng source hiện chưa có connector. |
| `CONDITIONAL` | Có API nhưng cần review/entitlement, phụ thuộc instance hoặc chỉ phù hợp với một loại nội dung/tài khoản. |
| `MANUAL` | Không có publish API chính thức phù hợp cho integration mới; dùng workflow copy/open/mark-published. |
| `UNKNOWN` | Không đủ contract chính thức để khẳng định; không tự động hóa bằng cookie, endpoint web nội bộ hay browser bot. |

Không lấy session cookie, password chính, CAPTCHA token hoặc endpoint reverse-engineered để thay thế API. Với forum do bên thứ ba quản trị, việc phần mềm forum *có* REST API không có nghĩa tài khoản thành viên được cấp API key.

## 2. Những nền tảng trong danh sách đã dùng được với source hiện tại

| Nền tảng | Mức trong release | Cách cấu hình trong Social Publisher | Giới hạn hiện tại |
|---|---|---|---|
| LinkedIn | `CURRENT`, có điều kiện | OAuth từ trang **Tài khoản**; app credential nằm ở backend env | Chỉ member text post; chưa có Organization/media flow |
| WordPress | `CURRENT` | Form credential: site URL, username, Application Password | Chỉ WordPress self-hosted REST API; article text/HTML, chưa upload media |
| Blogger | `CURRENT`, có điều kiện | Google OAuth từ trang **Tài khoản** | Article; Google consent/verification tùy app |
| dev.to | `CURRENT` | Form API key; có lựa chọn draft/publish | Article Markdown, chưa có binary upload/delete |
| Discourse-compatible forums | `CURRENT`, có điều kiện | Form `baseUrl`, `apiUsername`, `categoryId`, optional `defaultTags`, `apiKey`; một account cho mỗi forum/category | Chỉ topic mới text/Markdown + destination tags; bỏ qua hashtag AI, có external-ID reconciliation; admin forum phải cấp key, chưa có User API Key flow/media/reply/delete |
| Discord | `CURRENT` | Form incoming webhook URL | Text tối đa theo Discord; chưa upload attachment |
| Bluesky | `CURRENT` dạng pilot | Form `accessJwt`, DID, PDS URL | Text; chưa OAuth/refresh/media, không phù hợp production dài hạn |
| Mastodon.social | `CURRENT` | Chọn connector Mastodon, nhập `https://mastodon.social` và access token | Text; chưa media/native schedule |
| social.vivaldi.net | `CURRENT` có kiểm tra instance | Chọn connector Mastodon, nhập `https://social.vivaldi.net` và token của Vivaldi Social | Cần test compatibility/rate limit trên instance |
| Reddit | `MANUAL` trong release | Hệ thống tạo payload, mở Reddit, người dùng đăng và mark-published | Điền `REDDIT_*` chưa bật API/OAuth |

Ngoài các instance Discourse dùng chung connector ở trên, các tên khác trong danh sách chưa xuất hiện như connector có thể cấu hình trong UI. Phần dưới mô tả đường API để quyết định phát triển tiếp, không phải lời khẳng định chúng đã chạy trong source.

## 3. Lấy token và cấu hình các connector hiện có

### 3.1 LinkedIn — OAuth member text post

1. Tạo app ở [LinkedIn Developer Portal](https://www.linkedin.com/developers/apps) và liên kết Company Page sở hữu app.
2. Bật **Sign In with LinkedIn using OpenID Connect** và **Share on LinkedIn**. Release cần `openid profile w_member_social`.
3. Đăng ký đúng callback:

   ```text
   https://api.example.com/api/v1/oauth/linkedin/callback
   ```

4. Chọn một phiên bản Posts API dạng `YYYYMM` còn được LinkedIn hỗ trợ; không copy một version cũ cố định từ tutorial.
5. Điền backend `.env`, rồi recreate API/worker:

   ```dotenv
   LINKEDIN_CLIENT_ID=...
   LINKEDIN_CLIENT_SECRET=...
   LINKEDIN_API_VERSION=YYYYMM
   OAUTH_REDIRECT_BASE_URL=https://api.example.com/api/v1/oauth
   ```

6. Trong UI mở **Tài khoản -> Kết nối / cấu hình -> LinkedIn -> OAuth**. Không copy access token thủ công vào frontend.
7. Test một bài member text. Organization post cần `w_organization_social`, Page role phù hợp, Community Management access/review và connector mới; release hiện chưa hỗ trợ.

Nguồn: [Posts API](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/posts-api), [OAuth authorization code](https://learn.microsoft.com/en-us/linkedin/shared/authentication/authorization-code-flow), [Share on LinkedIn](https://learn.microsoft.com/en-us/linkedin/consumer/integrations/self-serve/share-on-linkedin), [Community Management review](https://learn.microsoft.com/en-us/linkedin/marketing/community-management-app-review).

### 3.2 WordPress self-hosted — Application Password

1. Site phải dùng HTTPS và `https://site.example/wp-json/` phải trả REST index.
2. Tạo user automation riêng với quyền tối thiểu đủ tạo/publish bài.
3. Vào **Users -> Profile -> Application Passwords**, đặt tên `Social Publisher staging`, tạo và copy password một lần.
4. Trong UI chọn **WordPress**, nhập:

   - `Site URL`: origin HTTPS của site, không thêm `/wp-json`;
   - `Username`: user automation;
   - `Application Password`: password vừa tạo;
   - `Trạng thái bài mặc định`: chọn `draft` cho lần thử đầu.

5. **Lưu & kiểm tra**, tạo campaign test, xác nhận draft ở WordPress rồi mới chuyển sang `publish`.

Connector hiện tại **không phải** WordPress.com OAuth connector. Nếu site nằm trên WordPress.com/Jetpack và không dùng được core Application Password như trên, phải xây adapter OAuth riêng cho WordPress.com.

Nguồn: [REST Posts](https://developer.wordpress.org/rest-api/reference/posts/), [REST authentication](https://developer.wordpress.org/rest-api/using-the-rest-api/authentication/), [Application Passwords](https://developer.wordpress.org/advanced-administration/security/application-passwords/).

### 3.3 Blogger — Google OAuth

1. Tạo Google Cloud project và bật **Blogger API v3**.
2. Cấu hình OAuth consent screen, authorized domain, homepage, Privacy Policy và test users nếu app còn ở Testing.
3. Tạo OAuth Client ID loại **Web application**.
4. Đăng ký callback chính xác:

   ```text
   https://api.example.com/api/v1/oauth/google/callback
   ```

5. Điền backend:

   ```dotenv
   GOOGLE_CLIENT_ID=...
   GOOGLE_CLIENT_SECRET=...
   OAUTH_REDIRECT_BASE_URL=https://api.example.com/api/v1/oauth
   ```

6. Recreate API/worker, vào **Tài khoản -> Google · Blogger -> OAuth**. Backend xin scope `https://www.googleapis.com/auth/blogger`, offline access và tự discovery các blog của user.
7. Test draft trước. Google có thể yêu cầu verification khi app External đưa ra production; làm theo trạng thái hiện tại trong Cloud Console.

Nguồn: [Blogger authorization](https://developers.google.com/blogger/docs/3.0/using), [`posts.insert`](https://developers.google.com/blogger/docs/3.0/reference/posts/insert), [OAuth web-server flow](https://developers.google.com/identity/protocols/oauth2/web-server), [scope verification](https://developers.google.com/identity/protocols/oauth2/production-readiness/sensitive-scope-verification).

### 3.4 dev.to / Forem — API key

1. Đăng nhập DEV, mở [Settings -> Extensions](https://dev.to/settings/extensions).
2. Tạo API key riêng tên `Social Publisher staging`.
3. Trong UI chọn **dev.to**, nhập API key, giữ `https://dev.to/api` làm Forem API URL.
4. Tắt **Publish ngay** cho lần thử đầu; draft thành công sẽ tạo job `NEEDS_ACTION`.
5. Khi phân phối lại bài từ website gốc, đặt canonical URL về bài gốc.

Nguồn: [Forem API authentication/versioning](https://developers.forem.com/api), [API v1](https://developers.forem.com/api/v1).

### 3.5 Discord — incoming webhook

1. Tạo channel test riêng.
2. Mở **Edit Channel -> Integrations -> Webhooks -> New Webhook**, chọn channel và copy URL.
3. Trong UI chọn **Discord**, dán URL vào `Webhook URL`, **Lưu & kiểm tra**.
4. URL chứa secret; không gửi qua chat, log, ảnh chụp hoặc frontend env. Xóa/rotate webhook khi nghi ngờ lộ.

Connector này không cần bot cho use case hiện tại.

Nguồn: [Discord webhooks](https://docs.discord.com/developers/resources/webhook), [Execute Webhook](https://docs.discord.com/developers/resources/webhook#execute-webhook).

### 3.6 Bluesky — pilot token hiện tại

Production multi-user nên dùng [AT Protocol OAuth](https://atproto.com/specs/oauth) với PKCE, PAR, DPoP, PDS discovery và refresh/session management. Source hiện chưa có luồng đó; form đang nhận một `accessJwt` ngắn hạn để thử text post.

Để smoke test một account do chính bạn kiểm soát:

1. Tạo **App Password** trong Bluesky settings; không dùng password đăng nhập chính.
2. Exchange App Password ở server/trên máy quản trị bằng `com.atproto.server.createSession` của PDS; response trả `accessJwt`, `refreshJwt`, `did` và handle.
3. Trong UI nhập `accessJwt`, `did`, và PDS service URL (Bluesky-hosted thường là `https://bsky.social`).
4. Test và đăng một text post ngắn. Token hết hạn sẽ buộc cập nhật credential vì release chưa dùng `refreshJwt`.

Không coi cách này là cấu hình “chạy mượt” dài hạn. DoD production là thêm OAuth/refresh an toàn, PDS discovery và không yêu cầu người dùng xử lý JWT thủ công.

Nguồn: [Creating a post](https://docs.bsky.app/docs/tutorials/creating-a-post), [AT Protocol OAuth](https://atproto.com/specs/oauth), [scope builder](https://atproto.com/guides/scope-builder).

### 3.7 Mastodon.social và social.vivaldi.net

1. Đăng nhập đúng instance, mở **Preferences -> Development -> New application** (tên menu có thể được instance dịch/điều chỉnh).
2. Tạo application/token cho account của bạn với quyền tối thiểu đủ cho connection test và đăng status: profile/read-account tương ứng phiên bản instance và `write:statuses`. Chỉ thêm `write:media` khi connector media được triển khai.
3. Trong UI chọn **Mastodon**:

   - `Instance URL`: `https://mastodon.social` hoặc `https://social.vivaldi.net`;
   - `Access token`: token vừa tạo;
   - `Visibility`: bắt đầu bằng `unlisted` nếu muốn hạn chế ảnh hưởng của bài test.

4. **Lưu & kiểm tra** gọi `verify_credentials`; sau đó test một status text và xóa bài test nếu cần.

Mỗi instance có policy, giới hạn ký tự và rate limit riêng. Vivaldi xác nhận tương thích với Mastodon apps, nhưng vẫn nên capability-probe trước khi bật production.

Nguồn: [Mastodon user token](https://docs.joinmastodon.org/client/token/), [create status](https://docs.joinmastodon.org/methods/statuses/#create), [Vivaldi Social from Mastodon apps](https://help.vivaldi.com/services/social/access-vivaldi-social-from-mastodon-apps/).

### 3.8 Reddit — chưa tự động trong release

Reddit có `POST /api/submit`, OAuth scope `submit` và yêu cầu User-Agent mô tả rõ ứng dụng. Tuy nhiên quyền Data API hiện cần đăng ký/chấp thuận; commercial use có thể cần thỏa thuận riêng. Source hiện cố ý để Reddit ở `MANUAL`.

Quy trình đúng:

1. Đăng ký use case với Reddit và chỉ tiếp tục sau khi được chấp thuận.
2. Tạo app/OAuth flow, xin tối thiểu `identity submit`, xử lý refresh và subreddit restrictions.
3. Viết/test connector mới; lúc đó mới dùng `REDDIT_CLIENT_ID/SECRET`.
4. Trước khi hoàn tất, dùng payload manual và mark-published; không dùng password grant, cookie hoặc browser bot để lách phê duyệt.

Nguồn: [submit endpoint](https://www.reddit.com/dev/api/#POST_api_submit), [Reddit Data API Wiki](https://support.reddithelp.com/hc/en-us/articles/16160319875092-Reddit-Data-API-Wiki), [Developer Platform access](https://support.reddithelp.com/hc/en-us/articles/14945211791892-Developer-Platform-Accessing-Reddit-Data).

### 3.9 Discourse — generic connector cho forum được cấp quyền

Release hiện có một connector `discourse` dùng lại cho nhiều instance. Trong UI, tạo một account riêng cho mỗi forum/category với:

- settings: `baseUrl`, `apiUsername`, `categoryId`, tùy chọn `defaultTags` dạng CSV/string array;
- credential write-only: `apiKey`.

Key phải do admin của chính forum tạo và gắn với user có quyền tạo topic trong category. Public forum không tự cấp key chỉ vì bạn có account thành viên. Connector hiện dùng header `Api-Key` + `Api-Username`; Discourse core hiện hành cần granular `global:read` + `topics:write`, current user phải có quyền tạo topic toàn cục và category có full permission. Optional `defaultTags` được normalize/dedupe toàn bộ và gửi dạng `{name}`; AI hashtag không được dùng, còn giới hạn/tag policy do forum kiểm tra. Connection test báo tag requirements để chẩn đoán nhưng không từ chối chỉ dựa trên tổng số tag vì không thể xác minh group membership hoặc admin exemption; topic staging vẫn bắt buộc. External ID ổn định + topic lookup đối soát create bị lỗi/không rõ kết quả; timeout/5xx chưa đối soát được chuyển sang human reconciliation thay vì auto-retry. Connector chưa triển khai Discourse User API Key RSA/callback flow hoặc manual fallback.

`baseUrl` phải giữ path cài đặt nếu có. Ví dụ MongoDB dùng `https://www.mongodb.com/community/forums`, không phải chỉ `https://www.mongodb.com`. Danh sách instance và quy trình smoke test nằm trong [DISCOURSE_CONFIGURATION.md](DISCOURSE_CONFIGURATION.md).

Nguồn: [Discourse API](https://docs.discourse.org/), [API key configuration](https://meta.discourse.org/t/create-and-configure-an-api-key/230124), [User API Key specification — chưa implement](https://meta.discourse.org/t/user-api-keys-specification/48536).

## 4. Có API chính thức nhưng phải viết connector mới

| Nền tảng | Token/quyền chính thức | Việc cần làm trước khi bật | Trạng thái |
|---|---|---|---|
| Tumblr | Đăng ký app; OAuth2 `basic write`, thêm `offline_access` nếu cần refresh | NPF create-post adapter, OAuth, media, rate/error mapping | `BUILD` — [API](https://github.com/tumblr/docs/blob/master/api.md) |
| WordPress.com / Jetpack | WordPress.com OAuth2; scope `posts`, thêm `media` nếu upload | Adapter khác connector self-hosted hiện tại | `BUILD` — [OAuth](https://developer.wordpress.com/docs/api/oauth2/), [create post](https://developer.wordpress.com/docs/api/1.1/post/sites/%24site/posts/new/) |
| pixelfed.social | OAuth/app registration và Mastodon-style media/status API nếu operator bật | Probe instance, ưu tiên image/media flow; không gắn nhãn đã hỗ trợ chỉ vì dùng ActivityPub | `CONDITIONAL` — [upstream routes](https://github.com/pixelfed/pixelfed/blob/dev/routes/api.php) |
| lemmy.world | Bearer/session của account trên instance; Lemmy API v4 | Per-instance auth, community selection, moderation/rate limits; tránh lưu password nếu có lựa chọn token/session an toàn | `BUILD/CONDITIONAL` — [OpenAPI](https://join-lemmy.org/api/main), [v4 guide](https://join-lemmy.org/docs/contributors/09-api-v4.html) |
| discuit.org | Official API dùng session cookie + CSRF sau login; không thấy delegated OAuth | Không phù hợp SaaS multi-user hiện tại; chỉ cân nhắc trusted single-owner integration | `CONDITIONAL/MANUAL` — [auth](https://docs.discuit.org/api/authentication), [posts](https://docs.discuit.org/api/endpoints/posts/posts) |
| mewe.com / MeWe | Developer Program preview, app approval; `apiToken`, `X-App-Id`; quyền `user_profile post_content` hoặc group equivalents | Được MeWe duyệt trước, rồi OAuth/auth adapter và capability test | `CONDITIONAL` — [quickstart](https://developer.mewe.com/quickstart), [auth](https://developer.mewe.com/authentication) |
| Dailymotion | Private API key trong Studio; OAuth2 client credentials; `video.manage` | Connector video/upload session; public delegated OAuth vẫn chưa phải luồng sẵn sàng chung | `CONDITIONAL` — [upload](https://developers.dailymotion.com/docs/upload-videos), [auth](https://developers.dailymotion.com/me/docs/authenticate) |
| Eventbrite | Private token cho own account; OAuth2/App Partner cho third party | Đây là event adapter, không phải social text post; create rồi publish event | `BUILD/CONDITIONAL` — [API](https://www.eventbrite.com/platform/new/api), [API key](https://www.eventbrite.com/help/en-us/articles/849962/generate-an-api-key/) |
| Hugging Face Discussions | Fine-grained/write user access token | Chỉ tạo repo Discussion hoặc push repo content; không phải Hub Blog Article | `BUILD` nếu đúng use case — [tokens](https://huggingface.co/docs/hub/security-tokens), [`create_discussion`](https://huggingface.co/docs/huggingface_hub/en/package_reference/hf_api#create_discussion) |

## 5. Không lấy được publish token phù hợp cho integration mới

| Nền tảng | Kết luận vận hành | Nguồn chính thức |
|---|---|---|
| Medium | Không cấp integration token mới; token cũ chỉ tiếp tục cho integration grandfathered. API terms cũng giới hạn auto-post không do user khởi tạo. Dùng manual/import UI cho deployment mới. | [API/Importing notice](https://help.medium.com/hc/en-us/articles/213480228-API-Importing), [API terms](https://help.medium.com/hc/en-us/articles/214151487-Medium-API-Terms-of-Use) |
| Substack | Không có contract publish API/token chính thức được xác minh. Developer API Terms nói về dữ liệu public, không chứng minh create-post. Dùng editor chính thức. | [API Terms](https://substack.com/api-tos), [publish a post](https://support.substack.com/hc/en-us/articles/360037831771-How-do-I-publish-a-new-post-on-Substack) |
| Quora | Official developer material tìm được thuộc Ads/Conversion API, không phải organic question/answer/post. | [Conversion API](https://quoraadsupport.zendesk.com/hc/en-us/articles/23065751885069-Conversion-API-Overview) |
| SlideShare | Không có current official upload/publish API contract được xác minh; dùng upload UI. | [official upload](https://www.slideshare.net/upload) |
| minds.com | Official Share to Minds chỉ mở composer; không có delegated create-post contract phù hợp được xác minh. | [Share to Minds](https://developers.minds.com/docs/plugins/share-to-minds/) |
| Product Hunt launch | Public GraphQL schema không có mutation tạo launch/post; app mặc định read-only và partial write không tạo ra operation bị thiếu. | [API docs](https://api.producthunt.com/v2/docs), [schema](https://api-v2-docs.producthunt.com/) |
| Gumroad profile/community post | API có product/email operations nhưng không có official generic profile-post endpoint được xác minh. Chỉ xây adapter nếu use case thực tế là product/email. | [Gumroad API](https://gumroad.com/api) |
| Hugging Face Blog | Blog Article được tạo qua UI và yêu cầu plan/role phù hợp; Discussion API là loại nội dung khác. | [Blog Articles](https://huggingface.co/docs/hub/blog-articles) |
| In Plain English | Đây là publication trên Medium; quy tắc Medium ở trên áp dụng, và publication còn có editorial approval riêng. | [Medium API/Importing](https://help.medium.com/hc/en-us/articles/213480228-API-Importing) |

## 6. Community, forum và cổng biên tập

### 6.1 API hoặc feed chính thức có thể tích hợp

| Nền tảng | Cách lấy quyền/token | Phạm vi thật sự | Kết luận |
|---|---|---|---|
| Stack Overflow | Đăng ký app trên Stack Apps, chạy Stack Exchange OAuth, xin `write_access`; gọi write endpoint với `site=stackoverflow` | Tạo question/answer đúng quy định cộng đồng; CAPTCHA/quality filter có thể từ chối và không được bypass | `BUILD/CONDITIONAL` — [write access](https://api.stackexchange.com/docs/write), [create question](https://api.stackexchange.com/docs/create-question), [OAuth](https://api.stackexchange.com/docs/authentication) |
| Server Fault | Cùng Stack Exchange OAuth/app, dùng `site=serverfault` | Nội dung phải là câu hỏi quản trị hệ thống on-topic, không phải bài marketing/syndication | `BUILD/CONDITIONAL` — [Stack Exchange API](https://api.stackexchange.com/docs) |
| Unix & Linux Stack Exchange | Cùng Stack Exchange OAuth/app, chọn site Unix & Linux | Cùng quota, `backoff`, quality và moderation rules | `BUILD/CONDITIONAL` — [Stack Exchange API](https://api.stackexchange.com/docs) |
| Scoop.it | Tạo app/OAuth theo API v1, lấy Bearer token; plan phải có API integration | `POST /api/1/post` với `action=create`; cần topic/destination và tuân quota/plan | `BUILD` — [auth/intro](https://www.scoop.it/dev/api/1/intro), [endpoint reference](https://www.scoop.it/dev/api/1/urls), [pricing](https://www.scoop.it/pricing) |
| Disqus | Đăng ký Disqus API application; OAuth2 `read,write`, public/secret key và user access token | `posts/create` tạo **comment trong thread**, không tạo bài viết độc lập | `BUILD` nếu đúng use case comment — [create comment](https://disqus.com/api/docs/posts/create/), [auth](https://disqus.com/api/docs/auth/), [permissions](https://disqus.com/api/docs/permissions/) |
| Flipboard | Không lấy publish token. Cung cấp RSS hợp lệ của domain sở hữu, đăng ký Publisher Program và chờ review/index | Bài mới đi qua RSS sau khi publisher được chấp thuận; không phải arbitrary REST post | `RSS_AFTER_REVIEW` — [RSS guidelines](https://about.flipboard.com/rss-guidelines/), [Publisher Program](https://about.flipboard.com/press/flipboard-launches-self-service-publisher-program-embracing-mobile-standards-and-promoting-the-best-of-the-mobile-web/) |

Stack Exchange là Q&A, Disqus là comment và Flipboard là feed distribution. Không map ba loại này vào một generic “social post” payload; mỗi loại cần domain model và moderation UX riêng.

### 6.2 Forum có engine API nhưng token do chủ site quyết định

| Nền tảng | Engine đã xác minh | Cách có token hợp lệ | Trạng thái khuyến nghị |
|---|---|---|---|
| Level1Techs Forum | Discourse | Admin cấp Single User API key + API username | `CURRENT/CONDITIONAL` — [site info](https://forum.level1techs.com/about.json) |
| TrueNAS Community | Discourse | Xin authorization và API key của TrueNAS/site admin | `CURRENT/CONDITIONAL` — [site info](https://forums.truenas.com/about.json) |
| AlmaLinux Forum | Discourse | Xin authorization và API key của site admin | `CURRENT/CONDITIONAL` — [site info](https://forums.almalinux.org/about.json) |
| Linux Containers Forum | Discourse | Như trên | `CURRENT/CONDITIONAL` — [site info](https://discuss.linuxcontainers.org/about.json) |
| NGINX Community | Discourse | Như trên | `CURRENT/CONDITIONAL` — [site info](https://community.nginx.org/about.json) |
| Caddy Community | Discourse | Như trên | `CURRENT/CONDITIONAL` — [site info](https://caddy.community/about.json) |
| HestiaCP Forum | Discourse | Như trên | `CURRENT/CONDITIONAL` — [site info](https://forum.hestiacp.com/about.json) |
| MikroTik Community | Discourse | Như trên; không dùng hướng dẫn phpBB cũ | `CURRENT/CONDITIONAL` — [site info](https://forum.mikrotik.com/about.json) |
| OpenNebula Community | Discourse | Xin site authorization và API key | `CURRENT/CONDITIONAL` — [site info](https://forum.opennebula.io/about.json) |
| MongoDB Community | Discourse dưới path `/community/forums` | Xin MongoDB/site authorization; giữ path prefix trong `baseUrl` | `CURRENT/CONDITIONAL` — [site info](https://www.mongodb.com/community/forums/about.json) |
| Replit Community Forum | Discourse tại `replit.discourse.group` | Xin forum admin authorization và API key | `CURRENT/CONDITIONAL` — [forum](https://replit.discourse.group/) |
| DirectAdmin Forums | XenForo | API key chỉ do admin control panel cấp; OAuth chỉ khi version/site đã cấu hình | `NEEDS_ACTION` — [forum](https://forum.directadmin.com/) |
| Voz Forums | XenForo | Điều khoản có nhắc “VOZ API” nhưng không có public onboarding/token flow; liên hệ VOZ, đồng thời lưu ý SMS OTP khi đăng bài | `NEEDS_ACTION/MANUAL` — [terms](https://voz.vn/help/terms/) |
| Unraid Forums | Invision Community | REST API key hoặc OAuth client phải do community admin cấu hình/cấp scope | `NEEDS_ACTION` — [forum](https://forums.unraid.net/) |
| Linux Foundation Forum | Higher Logic Vanilla | PAT chỉ tạo được khi role có `Garden > Tokens > Add`; cần LF admin cấp quyền | `NEEDS_ACTION` — [forum](https://forum.linuxfoundation.org/) |
| aaPanel Forum | Flarum | Không dùng username/password để lấy token; yêu cầu aaPanel cấp sanctioned integration credential | `NEEDS_ACTION` — [forum](https://www.aapanel.com/forum/) |
| cPanel Community | Zendesk Guide Community | OAuth/client/token thuộc Zendesk tenant và phải do cPanel/admin cấp | `NEEDS_ACTION` — [create community post](https://developer.zendesk.com/api-reference/help_center/help-center-api/posts/) |

Các engine dùng chung:

- Discourse có `POST /posts.json`; connector hiện tại chỉ auth bằng admin-created `Api-Key` + `Api-Username`. Discourse có [User API Key flow](https://meta.discourse.org/t/user-api-keys-specification/48536), nhưng release này chưa implement RSA/encrypted callback flow đó. Xem [official API docs](https://docs.discourse.org/).
- XenForo hỗ trợ thread/post qua REST, nhưng user thường không tự mint API key. Xem [REST API](https://docs.xenforo.com/api) và [API key manual](https://docs.xenforo.com/manual/configuration/api-keys).
- Invision Community có topic/post REST nhưng API key/OAuth client do admin community tạo. Xem [API reference](https://invisioncommunity.com/developers/api-reference/).
- Higher Logic Vanilla dùng Bearer PAT và API v2; quyền tạo PAT do site role quyết định. Xem [API v2 cookbook](https://success.vanillaforums.com/kb/articles/1966-api-v2-integration-cookbook).
- Flarum có `POST /api/discussions`, nhưng operator token cần admin provisioning. Không dùng password-token flow cho website bên thứ ba nếu họ không chính thức cho phép. Xem [Flarum REST API](https://docs.flarum.org/de/rest-api/).
- Zendesk Guide có create-community-post API nhưng cần credential/OAuth của đúng tenant. Xem [authentication](https://developer.zendesk.com/documentation/authentication/).

Ngay cả khi lấy được key, connector forum nên mặc định yêu cầu human approval trước mỗi bài, allowlist hostname cố định và tôn trọng category/tag/on-topic rules. Không dùng các forum này làm mạng syndication hàng loạt.

Connector `discourse` **không** áp dụng cho Disqus (comment), Eventbrite (event), Gumroad (commerce/email), aaPanel (Flarum), cPanel (Zendesk Guide Community), Ubiquiti (platform riêng), CloudPanel (community support qua Discord), Unix & Linux (Stack Exchange) hoặc Redis Community hiện hành. Các đích này cần adapter/domain model riêng hoặc manual flow.

### 6.3 Chỉ có UI/editor, chưa có public create API phù hợp hoặc tên chưa rõ

| Nền tảng | Cách vận hành đúng | Kết luận/nguồn |
|---|---|---|
| AWS Community | Hiện tương ứng AWS Builder Center: đăng nhập Builder ID, soạn và gửi moderation qua UI | `MANUAL_EDITORIAL` — [Builder Center](https://builder.aws.com/start), [FAQ](https://builder.aws.com/faq) |
| Tinhte.vn | Đăng bài bằng UI chính thức; không suy diễn API từ dấu hiệu XenForo | `MANUAL` — [hướng dẫn viết bài](https://tinhte.vn/thread/huong-dan-viet-bai-tren-tinhte-vn.3702060/), [điều khoản](https://tinhte.vn/thread/thoa-thuan-cung-cap-su-dung-dich-vu.2864413/) |
| KubeBy | Không nhận diện chắc chắn dịch vụ/pháp nhân từ tên này | `UNKNOWN`; cần canonical URL trước khi thiết kế |
| DZone | Gửi qua editor rồi moderation | `MANUAL_EDITORIAL` — [Contribute](https://dzone.com/pages/contribute), [guidelines](https://dzone.com/articles/dzones-article-submission-guidelines) |
| daily.dev | Có PAT/OAuth API nhưng OpenAPI public hiện không có operation tạo post; Direct Posting là luồng UI | `MANUAL` — [API](https://docs.daily.dev/welcome-to-the-daily-dev-api/), [Direct Posting](https://docs.daily.dev/how-to-get-featured/) |
| Differ | Dùng editor/self-publish hoặc gửi publication | `MANUAL` — [FAQ](https://differ.blog/faq), [Getting Started](https://differ.blog/getting-started) |
| In Plain English | Xin publishing account rồi submit qua dashboard/editorial flow | `MANUAL_EDITORIAL` — [Write for Us](https://plainenglish.io/write-for-us) |
| `hub` | Không đủ định danh; có thể là HubPages hoặc một Community Hub khác | `UNKNOWN`; cần URL chính xác |
| Warrior Forum | Không có official create API được xác minh; terms cấm automated use/bots/data-mining/bypass | `MANUAL_ONLY` — [terms](https://www.warriorforum.com/tos.html) |
| Ubiquiti Community | Không có public create-post API/client onboarding được xác minh | `MANUAL_ONLY` — [community](https://community.ui.com/), [legal](https://www.ui.com/legal/) |
| CloudPanel Forum | CloudPanel official support hiện trỏ community sang Discord; chưa xác minh một forum domain chính thức | `UNKNOWN/MANUAL` — [Support](https://www.cloudpanel.io/docs/v2/support/) |
| Redis Community Forum | Không còn coi là destination Discourse có write contract hiện hành; Redis hiện hướng người dùng tới Discord/community channels | `MANUAL` cho đến khi Redis xác nhận endpoint và quyền write — [Redis community](https://redis.io/community/), [Discord](https://redis.io/tutorials/community/discord/) |

“Không tìm thấy public API” không khẳng định hệ thống nội bộ không tồn tại; nó có nghĩa hiện không có contract/onboarding chính chủ đủ an toàn để xây connector production.

## 7. Thứ tự phát triển hợp lý

Ưu tiên theo giá trị và độ rõ của contract, không theo độ dài danh sách:

1. Hoàn tất integration test production cho connector đang có: Discord -> WordPress draft -> dev.to draft -> Discourse staging do bạn quản trị -> Mastodon -> LinkedIn/Blogger OAuth.
2. Nâng Bluesky từ JWT pilot lên OAuth/refresh.
3. Thêm Tumblr và Scoop.it vì có create API rõ ràng.
4. Thêm adapter chuyên biệt nếu có nhu cầu thật: Pixelfed media, Lemmy community post, Stack Exchange Q&A, Disqus comment, Eventbrite event, Dailymotion video, Hugging Face Discussion.
5. Chỉ làm MeWe/Reddit/provider review-required sau khi đã nhận phê duyệt bằng văn bản và có account sandbox.
6. Giữ Medium, Substack, Quora, SlideShare, editorial publications và forum bên thứ ba ở manual/approval flow.

Mỗi connector mới chỉ được chuyển sang `CURRENT` khi có đủ: official auth, least-privilege scope, revoke/refresh flow, test connection, dry-run hoặc destination test, create result ID/URL, 401/403/429 handling, idempotency/duplicate test và policy approval.


