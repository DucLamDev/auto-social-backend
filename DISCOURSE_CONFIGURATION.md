# Cấu hình connector Discourse

> Đối chiếu Discourse API chính thức: 2026-10-08. Connector này dùng API của **Discourse engine**, không dùng browser automation, cookie đăng nhập, CAPTCHA token hay password của thành viên.

## 0. Readiness gate cho `vpsttt.discourse.diy`

Forum đích của deployment này là `https://vpsttt.discourse.diy`. Probe công khai gần nhất ngày 2026-10-08 xác nhận:

- HTTP redirect sang HTTPS;
- HTTPS hoạt động với HSTS;
- `/about.json` trả JSON Discourse `200`;
- `/categories.json` trả JSON `200`.

Hai category public hiện thấy được là `Chung` (ID `4`) và `Phản hồi` (ID `2`). Đây chỉ là dữ liệu public để đối chiếu, không thay thế kiểm tra quyền bằng API key. Có thể dùng category `4` cho smoke test nếu bạn chấp nhận bài test xuất hiện công khai; an toàn hơn là tạo category staging/private riêng.

Có thể chạy lại readiness gate bất kỳ lúc nào:

```powershell
curl.exe -fsS -o NUL https://vpsttt.discourse.diy/
curl.exe -fsS https://vpsttt.discourse.diy/about.json
curl.exe -fsS https://vpsttt.discourse.diy/categories.json
```

`about.json` phải là JSON của Discourse, không phải HTML Nginx. Nếu TLS hoặc JSON check thất bại, không đổi connector sang HTTP để đi vòng lỗi: header `Api-Key` sẽ đi trên mạng ở dạng đọc được. Khi readiness gate đạt:

1. tạo category private/staging và ghi lại ID trên URL category;
2. tạo `publisher-bot`, cho phép user này tạo topic trong category đó;
3. tạo **Single User API key** gắn với `publisher-bot`, dùng granular scopes `global:read` + `topics:write` nếu UI phiên bản đang chạy cung cấp đúng các scope đó;
4. trong Social Publisher dùng Forum URL `https://vpsttt.discourse.diy`, đúng API Username, API Key và Category ID;
5. chạy **Lưu & kiểm tra**, rồi mới publish một topic `[TEST]`.

Frontend hỗ trợ các biến build-time sau để tự điền metadata public cho smoke test, nhưng không bao giờ nhận API key qua biến `NEXT_PUBLIC_*`:

```dotenv
NEXT_PUBLIC_DEFAULT_DISCOURSE_URL=https://vpsttt.discourse.diy
NEXT_PUBLIC_DEFAULT_DISCOURSE_USERNAME=Lam_Ho
NEXT_PUBLIC_DEFAULT_DISCOURSE_CATEGORY_ID=4
```

`Lam_Ho` và category `4` là các giá trị public hiện tại, giúp form test đầu tiên chỉ còn thiếu API key. Đây không phải cấu hình production được khuyến nghị: sau smoke test, revoke key thử nghiệm và thay bằng `publisher-bot` quyền tối thiểu cùng category staging/category đích đã duyệt. Sau khi thay các biến public phải build lại frontend; restart container cũ không thay đổi bundle đã build.

## 1. Phạm vi release

Một connector `discourse` dùng được cho nhiều instance. Mỗi `PlatformAccount` đại diện cho một destination cụ thể, thường là một forum + một category:

```text
Discourse Platform
  ├─ NGINX Community / category 12
  ├─ Caddy Community / category 7
  ├─ MongoDB Community (base URL có path `/community/forums`) / category 42
  └─ forum.example.com / category 5
```

Release hiện hỗ trợ:

- API auth bằng header `Api-Key` + `Api-Username`.
- Kiểm tra credential mà không tạo bài: username phải khớp, `current_user.can_create_topic=true` và category response phải có `permission=1` (full/create-topic). Nếu category công bố minimum/required tag groups, kết quả connection test chỉ trả chúng dưới dạng cảnh báo chẩn đoán; connector không đoán membership hoặc quyền miễn trừ của admin. Topic staging là bước xác minh tag policy bắt buộc.
- Tạo topic mới bằng `POST /posts.json` với `title`, Markdown `raw` và `category`.
- Đọc `defaultTags` tùy chọn từ **account settings** (CSV hoặc string array), trim/bỏ `#`/dedupe không phân biệt hoa thường và gửi toàn bộ theo API shape `{ "name": "tag" }` hiện hành. Connector không hard-code số tag tối đa: chính cấu hình `max_tags_per_topic` của forum sẽ kiểm tra payload. Connector cố ý bỏ qua hashtag do AI sinh; tag cấu hình phải tồn tại và được phép theo policy của forum/category.
- Gửi `external_id` ổn định từ idempotency key và đối soát bằng `GET /t/external_id/{external_id}.json` khi create trả lỗi/response không rõ, giảm nguy cơ tạo topic trùng.
- Lưu post ID, topic ID và URL trả về.
- Scheduler, khóa/idempotency nội bộ của Social Publisher và provider-side reconciliation theo `external_id`.

Release chưa hỗ trợ:

- Discourse User API Key authorization flow (`/user-api-key/new`).
- Reply vào topic có sẵn, private message, upload media, edit/delete topic và forum-native schedule.
- Tự động lấy API key bằng username/password.
- Tự vượt moderation, trust-level, slow mode, CAPTCHA hoặc giới hạn của từng community.

## 2. Forum nào trong danh sách dùng Discourse?

| Tên | Engine/kênh thật | Dùng connector này? |
|---|---|---|
| NGINX Community | Discourse | Có, **nếu NGINX cấp API authorization** |
| Caddy Community | Discourse | Có, nếu site cấp quyền |
| HestiaCP Forum | Discourse | Có, nếu site cấp quyền |
| MikroTik Community | Discourse | Có, nếu site cấp quyền |
| OpenNebula Community | Discourse | Có, nếu site cấp quyền |
| MongoDB Community | Discourse cài dưới path `/community/forums` | Có, dùng base URL `https://www.mongodb.com/community/forums` nếu site cấp quyền |
| Replit Community | Community hiện tại không còn được xác minh là destination Discourse có write contract | Không; giữ manual cho tới khi Replit công bố API/quyền automation phù hợp |
| Level1Techs Forum | Discourse | Có, nếu site cấp quyền |
| TrueNAS Community | Discourse | Có, nếu site cấp quyền |
| AlmaLinux Forum | Discourse | Có, nếu site cấp quyền |
| Linux Containers Forum | Discourse | Có, nếu site cấp quyền |
| Disqus | Comment service riêng | Không |
| Eventbrite | Event platform | Không |
| Gumroad | Commerce/email platform | Không |
| aaPanel Forum | Flarum | Không |
| cPanel Community | Zendesk Guide Community | Không |
| Ubiquiti Community | Community platform riêng; không có public create API đã xác minh | Không |
| CloudPanel Forum | Official support hiện trỏ về Discord; forum official chưa được xác minh | Không |
| Unix & Linux Stack Exchange | Stack Exchange | Không; cần Stack Exchange connector |
| Redis Community Forum | Destination Discourse hiện hành có quyền ghi không còn được xác minh; kênh community hiện tại ưu tiên Discord | Không cấu hình connector cho đến khi Redis xác nhận lại endpoint và quyền write |

Có thể kiểm tra một site nghi là Discourse bằng endpoint public `<baseUrl>/about.json`. Kết quả đó chỉ xác minh engine; nó **không cấp quyền write**. Danh sách này cũng có thể thay đổi khi nhà cung cấp di chuyển community, vì vậy phải probe lại đúng thời điểm onboarding.

## 3. Lấy API key đúng cách

### Forum do bạn quản trị

1. Tạo một Discourse user riêng, ví dụ `publisher-bot`. Chỉ cho user này vào đúng group/category cần đăng.
2. Trong Discourse Admin mở **Advanced / API Keys** và chọn **New API Key**.
3. Chọn **Single User** và gắn với `publisher-bot`. Không dùng key kiểu **All Users** nếu không thật sự cần impersonation.
4. Chọn granular scope tối thiểu của phiên bản Discourse đang chạy, đủ cho:

   - `GET /session/current.json` để test credential, đúng username và quyền tạo topic toàn cục;
   - `GET /c/{categoryId}/show.json` để xác minh category, `permission=1` và đọc tag policy để cảnh báo;
   - `GET /t/external_id/{external_id}.json` để đối soát topic sau create lỗi/không rõ kết quả;
   - `POST /posts.json` để tạo topic.

   Với Discourse core hiện hành, bộ tối thiểu cho đúng các endpoint trên là granular scope `global:read` + `topics:write`. `global:read` ở đây là **tên granular read scope** cần cho `/session/current.json` và đồng thời bao phủ các GET đối soát; nó không có nghĩa là tạo unrestricted/all-users key. Core chưa map current-session GET vào scope đọc hẹp hơn. Tên/mapping có thể thay đổi theo phiên bản hoặc plugin, nên đối chiếu scope UI trên chính instance khi cấp key.
5. Đặt mô tả rõ ràng, ví dụ `Social Publisher production - new topics only`.
6. Lưu và copy key ngay; Discourse chỉ hiển thị đầy đủ một lần.
7. Ghi lại username chính xác của user gắn với key.

API key chỉ giới hạn hành động trong quyền vốn có của user; nó không giúp user đăng vào category bị cấm. Discourse cũng có thể tự revoke key lâu không sử dụng theo site setting.

Nguồn chính thức: [Create and configure an API key](https://meta.discourse.org/t/create-and-configure-an-api-key/230124), [Discourse API](https://docs.discourse.org/).

### Forum công cộng do bên khác quản trị

Bạn không thể tự tạo admin API key. Cần liên hệ quản trị viên và cung cấp:

- mục đích tích hợp;
- domain/callback hoặc IP egress nếu họ yêu cầu;
- user đại diện;
- category cần đăng;
- tần suất tối đa;
- quy trình human approval và thu hồi key.

Nếu site không cấp key hoặc không chấp thuận automation, **không tạo/bật account Discourse connector** cho site đó. Release này chưa đăng ký `ManualConnector` cho Discourse; hãy xử lý ngoài hệ thống hoặc xây một manual destination riêng. Không lấy cookie trình duyệt hoặc password thành viên để gọi private endpoint.

Discourse có [User API Key flow](https://meta.discourse.org/t/user-api-keys-specification/48536) cho ứng dụng bên thứ ba, nhưng site phải cho phép `write`, group và redirect phù hợp. Source hiện chưa triển khai RSA/encrypted callback flow này, vì vậy không quảng bá nó như một đường kết nối đang hoạt động.

## 4. Xác định Category ID

Mở category đích trong forum. URL Discourse thường có dạng:

```text
https://community.example.com/c/tutorials/12
```

`12` là Category ID. Có thể đối chiếu thêm tại `/categories.json`. User gắn với API key phải nhìn thấy category và có quyền tạo topic ở đó.

`baseUrl` là URL gốc của **installation Discourse**, không nhất thiết chỉ là origin. Ví dụ:

- NGINX: `https://community.nginx.org`;
- MongoDB: `https://www.mongodb.com/community/forums` — phải giữ path prefix này;
- Replit: `https://replit.discourse.group`.

Không thêm `/posts.json`, `/categories.json` hoặc URL category vào `baseUrl`; connector tự ghép endpoint.

Nên tạo một category staging/private riêng trước. Không thử lần đầu trong category production đông người đọc.

## 5. Cấu hình trong Social Publisher

Sau khi deploy code mới, chạy seed lại để upsert platform Discourse:

```bash
docker compose exec api corepack pnpm prisma:seed
```

Trong giao diện:

1. Mở **Tài khoản -> Kết nối / cấu hình -> Discourse**.
2. Nhập:

   | Field | Ví dụ | Lưu trữ |
   |---|---|---|
   | Tên hiển thị | `NGINX · Tutorials` | Metadata |
   | Forum URL | `https://community.nginx.org` | Setting, HTTPS bắt buộc |
   | API Username | `publisher-bot` | Setting |
   | API Key | key được admin cấp | Credential AES-256-GCM |
   | Category ID | `12` | Setting |
   | Tags mặc định | `nodejs, tutorial` | Setting tùy chọn; chỉ dùng tag đã tồn tại/được phép |

3. Chọn **Lưu & kiểm tra**. Account chỉ chuyển thành `CONNECTED` khi username khớp, user có `can_create_topic=true`, category đúng và API trả `category.permission=1`. Trạng thái này chỉ xác minh auth/quyền cơ bản; nó không chứng minh tag tồn tại, đủ số lượng, thuộc đúng required tag group hoặc user có/không có miễn trừ. Phải hoàn tất topic staging ở mục 6 trước khi bật production.
4. Tạo một account riêng cho category khác, kể cả trên cùng forum. Cách này làm destination rõ ràng và tránh gửi nhầm category.

Khi đổi Forum URL, username, category hoặc tags, mở action cập nhật account và nhập lại **đầy đủ API Key**. Secret cũ là write-only nên frontend không tải lại; backend merge settings mới cùng lúc thay credential, sau đó phải chạy connection test lại.

Muốn bỏ toàn bộ tag mặc định, xóa trắng field **Tags mặc định** trong form cập nhật rồi lưu; UI gửi giá trị rỗng để ghi đè cấu hình cũ.

`Forum URL` chỉ nhận public HTTPS base URL, có thể chứa path cài đặt như MongoDB nhưng không chứa endpoint API, query, fragment, username/password hoặc IP private. Shared outbound guard của backend kiểm tra DNS, redirect và private/reserved range trước khi gửi key.

## 6. Smoke test an toàn

1. Tạo content thủ công với tiêu đề/nội dung không quảng cáo.
2. Tạo variant `discourse`, đọc lại và duyệt thủ công. Hashtag trong variant không được dùng làm forum tags; nếu cần tag, cấu hình `defaultTags` ở destination.
3. Chọn đúng destination/category trong campaign.
4. Publish một topic có tiền tố `[TEST]` vào category staging.
5. Xác minh:

   - job kết thúc `PUBLISHED`, hoặc `NEEDS_ACTION` nếu site đưa bài vào moderation;
   - external post ID và topic URL đúng;
   - topic do đúng user tạo và nằm đúng category;
   - Markdown hiển thị đúng;
   - toàn bộ `defaultTags` hợp lệ/được forum cho phép xuất hiện; số lượng không vượt cấu hình của chính forum; hashtag do AI sinh không bị gửi ngoài ý muốn;
   - timeout/5xx không làm worker tự gửi lại topic khi kết quả cũ chưa đối soát được; job phải chuyển sang `NEEDS_ACTION`.

6. Xóa topic test bằng UI Discourse nếu cần. Connector release này chưa quảng bá capability delete.
7. Thử key sai/revoked và category không có quyền; lỗi phải dừng, không retry mù.

## 7. Vận hành nhiều forum

- Mỗi forum dùng key riêng; không tái sử dụng một key giữa các site.
- Mỗi category là một account/destination riêng.
- Đặt rate limit bảo thủ theo `platform + account`; luôn tôn trọng `429` và `Retry-After`.
- Bật human approval cho nội dung forum. Prompt phải ưu tiên trả lời đúng ngữ cảnh, tránh cross-post cùng một bài hàng loạt.
- Lưu inventory gồm owner, forum, category, scope, ngày tạo/hết hạn và cách revoke.
- Connector dùng cùng một `external_id` ổn định cho lookup topic sau create lỗi/không rõ kết quả. Nếu timeout/5xx làm kết quả create không chắc chắn và lookup chưa thấy topic hoặc gặp bất kỳ lỗi nào, job chuyển sang `NEEDS_ACTION` với cờ reconciliation thay vì tự gửi lại. UI ẩn “Copy & mở”; người vận hành phải kiểm tra topic gần đây và moderation queue. Nếu tìm thấy bài, chọn **Đã tìm thấy bài** và nhập ID/URL. Chỉ khi đã xác minh chắc chắn không có topic lẫn bài chờ duyệt, chọn **Không tìm thấy** rồi xác nhận để xếp hàng lại **chính job cũ** với cùng idempotency key; không tạo campaign mới để né bước đối soát. Response 2xx sai schema cũng không bị auto-retry. Nếu provider đã trả thành công nhưng backend chỉ lỗi lưu kết quả, UI không cho gửi lại và chỉ cho xác nhận bài đã tồn tại.
- Tag không tồn tại, vượt giới hạn của site, không được category cho phép, không thuộc đúng required tag group hoặc không đủ minimum tags có thể làm create bị từ chối. Connection test chỉ báo lại tag policy mà category công bố, không dùng tổng số tag để kết luận policy hợp lệ; sửa `defaultTags`, nhập lại credential trong form cập nhật rồi test topic staging thay vì retry nguyên payload.
- Khi forum đổi domain, không chỉ sửa DNS rồi giữ key cũ. Xác minh site ownership, cấp key mới và test lại để tránh gửi secret nhầm origin.

## 8. Thêm một forum Discourse mới

Không cần thêm class connector hoặc biến môi trường mới. Chỉ cần:

1. xác minh `/about.json` và tài liệu/chấp thuận của site;
2. lấy API key hợp lệ;
3. lấy category ID;
4. tạo Discourse account mới trong UI;
5. test connection và smoke test topic staging.

Nếu forum không phải Discourse, không cố dùng connector này dù giao diện tương tự. Chọn đúng engine adapter hoặc manual flow.

