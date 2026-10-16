# Phục hồi xác thực trình duyệt

`BrowserAutomationService` là browser publisher hiện có của backend. Nó gọi `AuthManager` → `AuthDetector` →
`PlatformAuthAdapter` trước khi soạn bài, kiểm tra lại trước submit và giữ khóa Redis của account trong suốt thời
gian chờ người dùng. Sau khi bắt đầu submit, kết quả chưa rõ vẫn là `SUBMISSION_UNCERTAIN`, cần đối soát;
không tự xác thực rồi gửi lại một bài có thể đã được đăng.

## Phạm vi hoạt động

CLI dùng account đã có trong backend, tìm theo platform slug và tên/username/UUID. Hiện chỉ account
`BROWSER_ASSISTED` với recipe đã duyệt **Voz/XenForo** được chạy. Không đổi Instagram/LinkedIn/Threads đang dùng
API chính thức thành browser publisher. Medium vẫn bị chặn bởi registry hiện có. Các file
`src/platforms/{instagram,threads,linkedin,reddit,medium}/auth.selectors.ts` là cấu hình tham khảo để adapter
được duyệt sau này sử dụng, chưa phải cam kết selector chạy trên tài khoản thật. Recipe có thể cung cấp
`authSelectors` riêng; account JSON không thể inject selector hoặc JavaScript.

## Chuẩn bị và lệnh

Dùng Node/pnpm và các dịch vụ backend theo README. Chromium phải có sẵn; cấu hình
`PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` nếu dùng browser do admin cung cấp. CLI không tải browser hoặc cài extension.
Máy chạy cần desktop hoặc phiên desktop từ xa với `DISPLAY` hợp lệ để người dùng nhìn và thao tác cửa sổ Chromium.
SSH terminal đơn thuần không hiển thị được trình duyệt; `headless: false` không tự tạo desktop từ xa.

```dotenv
BROWSER_AUTOMATION_ENABLED=true
# CLI bot tự bật; worker cần opt in nếu muốn dùng profile persistent/recovery.
BROWSER_AUTH_RECOVERY_ENABLED=false
BROWSER_PROFILES_DIR=profiles
CAPTCHA_WAIT_TIMEOUT=300000
AUTH_WAIT_TIMEOUT=300000
MAX_AUTH_ATTEMPTS=3
AUTH_SCREENSHOTS_DIR=logs/screenshots
```

Hai timeout phải là số nguyên dương, tối đa 900000ms. `MAX_AUTH_ATTEMPTS` từ 1 đến 3.
Tổng một phiên recovery bị giới hạn bởi giá trị lớn hơn của hai timeout; mỗi bước chờ dùng timeout tương ứng.

```bash
pnpm bot accounts
pnpm bot login voz-forums account01
pnpm bot auth-check voz-forums account01
pnpm bot post voz-forums account01 ./post.json
pnpm bot publish-all ./post.json
pnpm bot publish-all ./post.json --skip-auth-blocked
```

Nếu tên trùng, dùng UUID từ `accounts`. `accounts` liệt kê trạng thái lưu trong backend; nó không mở trình duyệt
để khẳng định session còn hiệu lực. `auth-check` kiểm tra thật nhưng không chờ người dùng. `login` chỉ xác thực và
lưu session mã hóa, không đăng bài. `post`/`publish-all` vẫn yêu cầu `automationPermissionAttested=true`,
`browserAutoSubmit=true`, account và credential được backend cho phép ở thời điểm submit. Credential bị thu hồi
hoặc hết hạn trong database cần lệnh `login` rõ ràng; recovery không bỏ qua bước kiểm tra quyền này.

`post.json` theo `PostPayload`, ví dụ:

```json
{
  "title": "Tiêu đề bài viết",
  "body": "Nội dung đã được duyệt",
  "idempotencyKey": "campaign-demo-post-001"
}
```

CLI đăng trực tiếp qua browser publisher, không tạo campaign/job trong database. Không chạy CLI song song với
campaign đăng cùng nội dung. Nó lưu journal riêng, không chứa nội dung hay secret, ở `logs/bot-publish/`, đặt claim
trước khi publish để chặn chạy lại cùng `account + idempotencyKey`. Preflight chưa xác thực không tạo claim, nên
có thể login rồi dùng lại key đó. Claim đã được tạo sẽ chặn chạy lại kể cả khi script bị ngắt; kiểm tra platform
và journal trước khi dùng key mới. Với quy trình vận hành campaign, tiếp tục dùng API/queue đã có của backend.

## Khi gặp challenge

- CAPTCHA/Cloudflare: ngừng thao tác đăng bài, giữ browser mở, thông báo platform/account/challenge/timeout.
  Người dùng hoàn thành trong browser; polling mỗi 1500ms (giới hạn 1000–2000ms), không busy-loop.
- OTP/2FA: nếu adapter có đúng một OTP input và một submit được khai báo, dùng terminal TTY nhập ẩn OTP do
  người dùng tự lấy từ app/extension. Code không hiện trên stdout, không có trong structured log/file/DB.
  Nếu chưa có submit selector được duyệt, hoàn thành 2FA trực tiếp trong browser. Terminal không phải TTY không
  nhận OTP qua pipe hay đối số lệnh.
  Khi chủ account bật `browserAutoTotp=true` và cấu hình secret riêng theo hướng dẫn bên dưới, bot có thể sinh
  và nhập TOTP tự động, kể cả headless. OTP email, xác nhận device và CAPTCHA vẫn theo luồng thủ công.
- Email/device/session hết hạn/login required: người dùng thực hiện trên browser; configured login callback
  trong adapter, nếu có, chỉ được gọi một lần và phải tôn trọng `AbortSignal`.
- Challenge đổi thành loại khác: chuyển sang bước chờ tương ứng. Chỉ tiếp tục khi selector đã đăng nhập hoặc
  callback `isAuthenticated` xác nhận; URL đổi hoặc CAPTCHA biến mất không đủ chứng minh đã đăng nhập.
- Unknown: screenshot đã che dữ liệu nhập và dừng an toàn. Mật khẩu/OTP sai, CAPTCHA thất bại hoặc account bị
  khóa: dừng account, không lặp đăng nhập. `MAX_AUTH_ATTEMPTS` là trần cho submit OTP, không phải số lần tự thử code.
- `--skip-auth-blocked`: đánh dấu runtime `AUTH_REQUIRED`, đóng browser của account đó và tiếp tục account sau.
  Không có TTY thì worker không chờ người dùng và trả `NEEDS_ACTION` như trước. Nhấn Ctrl+C/Esc/Ctrl+D trong lúc
  nhập OTP để hủy; Ctrl+C/SIGTERM ở CLI hủy phiên đang chờ và đóng tài nguyên.

Runtime state trong `AuthManager.accounts`: `READY`, `AUTH_REQUIRED`, `WAITING_CAPTCHA`, `WAITING_2FA`,
`SESSION_EXPIRED`, `LOCKED`, `FAILED`. Runtime độc lập với enum trạng thái account lưu trong PostgreSQL.
Structured event chỉ có `timestamp`, `platform`, `account`, `authState`, `action`, `result`.

## Session, proxy và extension

`SessionManager` dùng `chromium.launchPersistentContext()`. Profile có quyền thư mục `0700`, tên là SHA-256 của
`recipe + account UUID` để tránh trùng account/path traversal. Đổi tên hiển thị account không đổi profile.
Chromium giữ cookie có expiry, localStorage và extension đã được user cài; cookie chỉ sống trong session được
khôi phục từ snapshot mã hóa AES-256-GCM của backend vì Chromium có thể bỏ chúng khi đóng. Profile mới cần
đăng nhập thủ công một lần; localStorage từ capture cũ không được chép vào profile mới.

Profile là dữ liệu nhạy cảm trên đĩa, không phải encrypted store; giới hạn truy cập cho người vận hành và dùng
mã hóa ổ đĩa khi cần. Đã thêm profiles, screenshots và journal vào `.gitignore`.

Interactive CLI mở browser visible ngay từ đầu. Khi cần chuyển từ headless, `makeVisible()` đóng context cũ và
mở lại cùng profile/proxy, cài lại network guard rồi điều hướng tới URL đã duyệt. Chromium không hỗ trợ đổi
headless trên context đang chạy; trạng thái challenge chỉ nằm trong RAM có thể phải hiển thị lại sau relaunch.
Không đổi proxy hoặc profile để tránh challenge. Vẫn dùng proxy routing và SSRF guard của backend.

Authenticator extension chỉ để người dùng xem code thủ công. Code không đọc extension storage/service worker, không lấy
TOTP seed/QR/secret, không export secret và không có CAPTCHA solving service hay thay đổi fingerprint.

### TOTP tự động do chủ account cấu hình

Luồng này chỉ dùng cho account mà bạn có quyền đăng nhập và đã có TOTP secret của account đó. Bật account setting
`browserAutoTotp=true` qua settings API đã có; setting này chỉ là boolean, không chứa seed. Admin đặt secret ở
Bí mật của dự án/environment với tên `BROWSER_TOTP_SECRET_<UUID_ACCOUNT>`, trong đó UUID viết hoa và thay dấu
`-` bằng `_`. Tên biến được suy ra từ đúng account ID, account JSON không được chọn biến của account khác.
Không gửi seed hoặc OTP vào chat, không nhập seed vào website bên thứ ba.

Provider xử lý cục bộ theo [RFC 6238](https://www.rfc-editor.org/rfc/rfc6238). Chấp nhận Base32 hoặc URI
`otpauth://totp/...`; mặc định SHA1, 6 chữ số và 30 giây. URI có thể chỉ định SHA256/SHA512, 8 chữ số và period
15–120 giây. Đồng hồ máy chạy bot phải đúng; code không thử lệch time-window. Nếu còn dưới 5 giây thì đợi
window kế tiếp trước khi sinh mã. Chỉ submit một lần trong một phiên recovery; sai mã hoặc account bị khóa thì dừng.

Chỉ tạo mã khi detector nhận `TWO_FACTOR_REQUIRED` và adapter có OTP input/submit duy nhất, visible.
`--skip-auth-blocked` vẫn bỏ qua challenge. Secret thiếu/sai định dạng thì dừng an toàn; không tự lấy từ extension,
QR hay storage, và không đoán mã. Provider không dùng cho email/device/CAPTCHA. Trace/HAR/HTML vẫn tắt trong phiên
recovery; ô OTP được xóa sau submit, tham chiếu mã được bỏ và buffer HMAC được xóa. JavaScript không đảm bảo xóa
vật lý string khỏi heap; environment/config vẫn giữ seed để dùng lần sau. Seed chỉ nên có trong secret store của runtime.

Công cụ [VPSTTT 2FA](https://vpsttt.com/cong-cu/) yêu cầu nhập secret để sinh mã; nó không tự truy xuất được
mã của tài khoản. Bot không gửi seed tới trang này và không dùng trang này để vượt bước xác thực.

Phiên recovery không bật trace/HAR/video và không lưu HTML. Khi lỗi, chỉ chụp PNG trong
`logs/screenshots/YYYY-MM-DD/`, che input, textarea, contenteditable, iframe, alert, pre/code và selector nhạy cảm
của adapter. File có quyền `0600`, tên gồm platform/account/state và UUID. Che selector là best effort; không công
khai screenshot/profile. Các diagnostic cũ của chế độ không bật recovery được mô tả riêng trong
[BROWSER_AUTOMATION.md](BROWSER_AUTOMATION.md).

## Kiểm tra

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
# Dùng đường dẫn Chromium đã có trên máy; không tải browser.
AUTH_TEST_CHROMIUM_EXECUTABLE_PATH=/path/to/chrome pnpm test:auth:browser
```

Unit/mock tests kiểm tra detector, các bước recovery, lỗi OTP, khóa, timeout, terminal cleanup, lease, không log
secret, runner tuần tự/skip và không retry submit chưa rõ. Integration Chromium dùng HTTPS fixture intercept
cục bộ để kiểm tra persistent profile/cookie, DOM challenge, auto resume, OTP và screenshot đã che dữ liệu.
Test Chromium mặc định skip nếu chưa chỉ định executable;
không gọi dịch vụ social, database hoặc Authenticator trong các test recovery.

### Smoke test trên website thật

```bash
PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/path/to/chrome pnpm social:auth-live-smoke
```

Lệnh này truy cập trang login Voz thật với profile anonymous cố định, dùng network guard của backend.
Chỉ cho GET/HEAD, không nạp account/credential, không import cấu hình `.env`, không submit login/publish hoặc
ghi DB. Kết quả và screenshot đã che dữ liệu nhập ở `tmp/auth-live-smoke/` (đã được ignore trong Git).
PASS chứng minh nhận diện được login/challenge và dừng an toàn ở `AUTH_REQUIRED`; không chứng minh hoàn thành
CAPTCHA/2FA, đăng nhập thành công, lease Redis hay đăng bài. Muốn kiểm thử trọn luồng cần account đã cấu hình,
PostgreSQL/Redis truy cập được và browser visible để người vận hành hoàn thành xác thực.

### Đăng nhập từ danh sách CSV và giữ phiên cục bộ

`social:auth-smoke` là công cụ kiểm tra đăng nhập, **không phải publisher**. Hiện có flow đăng nhập
Instagram, Threads, X/Twitter và dev.to qua Google; không thể dùng mật khẩu CSV thay API token của các connector khác.
File đầu vào dùng tab delimiter dù mang đuôi `.csv`. Không in nội dung file, mật khẩu hoặc seed vào terminal.

```bash
# Dry-run: chỉ trả accountRef, phương thức login và có/không có 2FA.
pnpm social:auth-smoke --auth-file ../auth_v2.csv --platform dev.to
# Dùng accountRef từ dry-run; thử đăng nhập một lần, dừng khi bị từ chối hoặc cần người dùng.
PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/path/to/chrome pnpm social:auth-smoke \
  --auth-file ../auth_v2.csv --platform dev.to --account-ref <accountRef> \
  --execute-live-login --headless
# Có desktop/DISPLAY: người dùng đăng nhập trong Chromium do bot mở.
PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/path/to/chrome pnpm social:auth-smoke \
  --auth-file ../auth_v2.csv --platform dev.to --account-ref <accountRef> \
  --execute-live-login --manual-login --timeout-ms 300000
# Kiểm tra phiên đã có; không điền mật khẩu, không submit login, không sinh OTP.
PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/path/to/chrome pnpm social:auth-smoke \
  --auth-file ../auth_v2.csv --platform dev.to --account-ref <accountRef> \
  --inspect-session --headless
```

Profile mặc định ở `profiles/social-login/`; dùng `--profiles-dir` để chọn vị trí cố định khác.
AccountRef dựa trên platform, phương thức login và user; đổi thứ tự CSV hoặc URL profile không đổi phiên.
Bot kiểm tra bằng chứng đã đăng nhập trước khi nhập mật khẩu. Chỉ khi xác nhận được session, kết quả mới có
`sessionSaved:true`; lần chạy sau kiểm tra lại và trả `reusedSession:true` khi phiên còn hợp lệ.
Google login chỉ tự điền tài khoản và TOTP do chủ account cung cấp; CAPTCHA, device, email hoặc consent mới
cần người dùng. Không tự vượt các bước này, không lặp mật khẩu hay đoán OTP.

Chromium tự giữ cookie dài hạn/localStorage trong đúng profile. Cookie chỉ sống trong session được backup
AES-256-GCM vào `session.enc` (quyền `0600`) và phục hồi khi mở lại. Snapshot ràng buộc với account, chỉ lấy
storage của origin HTTPS đã duyệt; không đọc storage của extension. Tool dùng key riêng, không đổi key credential
của backend: có thể cấp `BROWSER_SESSION_ENCRYPTION_KEY` dạng Base64 32 byte qua môi trường; nếu chưa cấp,
nó tạo `.session-key` ngẫu nhiên trong thư mục profile gốc, quyền `0600`, dùng lại qua các lần chạy.
Giữ nguyên key và profile, giới hạn quyền truy cập; key cùng ổ đĩa không bảo vệ khi cả thư mục bị đánh cắp.
Profile Chromium chứa dữ liệu nhạy cảm ngoài snapshot và vẫn cần bảo vệ ở mức hệ điều hành.

Đăng nhập thủ công chỉ được thu nhận khi thực hiện trong Chromium/profile do lệnh này mở. Chrome cá nhân,
profile khác hoặc máy khác không tự chia sẻ session. Một profile không được mở đồng thời bằng hai tiến trình.
Session có thể bị nền tảng thu hồi hoặc hết hạn; lưu profile không đảm bảo sẽ không bao giờ cần login lại.

Đợt kiểm tra thực tế ngày 13/10/2026 đã tới Google từ dev.to nhưng trả `LOGIN_REJECTED`; Threads cũng trả
`LOGIN_REJECTED`; Instagram gặp lỗi runtime trình duyệt. Chưa có session đăng nhập được xác nhận hoặc bài đăng
thật thành công trong đợt này. Unit/integration fixture đã kiểm tra lưu key riêng, mã hóa snapshot, khôi phục
cookie session-only và localStorage sau khi đóng/mở Chromium; fixture không chứng minh tài khoản thật login được.

Rà soát sau đợt thử phát hiện smoke cũ gộp thiếu ô password/cookie vào `LOGIN_REJECTED`. Đây không phải bằng chứng
mật khẩu sai hoặc platform đã từ chối credential. Đã sửa để chỉ báo rejected khi detector thấy dấu hiệu từ chối;
trạng thái thiếu bằng chứng là `SESSION_NOT_VERIFIED`, kèm enum `authState`. Lỗi runtime có stage và mã cố định,
không có raw error chứa credential/URL query. Kiểm tra lại profile bằng `--inspect-session` cho kết quả:
dev.to và Instagram `LOGIN_REQUIRED`, Threads `UNKNOWN_AUTH_CHALLENGE`; không xác nhận được session nào.
Chế độ này mở profile và truy cập website nhưng không chạy nhánh điền/submission login hoặc lưu snapshot mới.

### Tiêu chí nghiệm thu trên account thật

Không nghiệm thu toàn luồng bằng số lượng unit tests. Mỗi platform cần bằng chứng riêng, gồm:

1. Login thật được xác nhận bằng account UI/trang chỉ dành cho người đã đăng nhập; không lấy URL đổi hoặc
   CAPTCHA biến mất làm bằng chứng. Ghi rõ login tự động hay do người dùng thao tác.
2. Lưu phiên, đóng hoàn toàn Chromium, mở lại đúng profile rồi xác nhận vẫn truy cập được mà không submit login.
3. Với challenge có thật, người dùng xử lý trong browser visible; bot tự xác nhận và tiếp tục, không restart script.
4. Publisher thực sự tạo bài được duyệt; lưu external ID/URL và kiểm tra bài xuất hiện trên platform, không chỉ mở editor.

Smoke login CSV không nối thành browser publisher cho dev.to/Instagram/Threads; các connector đó đang dùng API.
Muốn nghiệm thu publish phải dùng connector/token phù hợp hoặc triển khai browser recipe được hỗ trợ cho platform
đã chọn. PostgreSQL/Redis chưa sẵn sàng chặn luồng backend, nhưng không chứng minh nguyên nhân lỗi login website.
Tại thời điểm này chưa có account thật đạt trọn các bước trên; chức năng chưa được xác nhận sẵn sàng sử dụng thực tế.

### Kiểm tra X/Twitter

```bash
pnpm social:auth-smoke --auth-file ../auth_v2.csv --platform x
PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/path/to/chrome pnpm social:auth-smoke \
  --auth-file ../auth_v2.csv --platform x --account-ref <accountRef> \
  --execute-live-login --headless
# Sau khi login thành công: đóng browser rồi kiểm tra cùng profile mà không submit login.
PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/path/to/chrome pnpm social:auth-smoke \
  --auth-file ../auth_v2.csv --platform x --account-ref <accountRef> --inspect-session --headless
```

Flow X dùng URL chuẩn `https://x.com/i/flow/login`, nhập identifier/password tối đa một lần.
Yêu cầu xác minh thêm username/phone, device, email/SMS hoặc CAPTCHA dừng để chủ account thao tác; không đoán.
TOTP chỉ dùng khi trang chỉ rõ code từ authenticator app và CSV có seed do chủ account cung cấp.
Chỉ xác nhận `READY` khi trang `/home` có cookie `auth_token`, account switcher, home navigation và không có ô
password/CAPTCHA. Kiểm tra phiên không dùng lại mật khẩu. Login smoke không tạo tweet hoặc cấp API token.

Kiểm thử thực tế X tại VPS ngày 13/10/2026 dừng ngay `session-preflight` với
`BROWSER_ERR_HTTP_RESPONSE_CODE_FAILURE`; cả hai lượt browser chưa nhập identifier/password. Chẩn đoán GET
trang login qua cùng proxy pinned cho thấy HTTP client nhận 200, Chromium nhận 403 từ host `x.com`.
Điều này xác nhận khác biệt phản hồi truy cập; không đủ để kết luận lý do X trả 403 hoặc chất lượng credential.
Không đổi fingerprint/User-Agent, không đổi proxy/profile để vượt phản hồi chặn. Chưa có session X được xác nhận
hoặc tweet thật được tạo. Chromium fixture kiểm tra các bước identifier/password và khôi phục phiên; fixture
không thay cho chứng cứ login thật.

### Bộ chạy trên máy Windows 10

Xem [WINDOWS_X_LOGIN.md](WINDOWS_X_LOGIN.md). Builder `node scripts/build-windows-auth-kit.cjs` tạo bundle
Node độc lập ở `tmp/x-login-windows`, chỉ cần các dependency runtime đã liệt kê trong package.json.
Dependency có version cụ thể; tạo package-lock.json trong thư mục bộ chạy trước khi đóng ZIP.
Builder không sao chép .env, CSV, credential hoặc profile. Không cần backend/database để kiểm tra login thủ công.

`2-LOGIN-X.cmd` mở Chrome đã cài trên Windows, profile riêng trong LocalAppData; `3-CHECK-SESSION.cmd` mở lại
cùng profile để xác nhận phiên mà không submit login. Mode manual/check của X có thể dùng `--account-label`
không cần --auth-file hoặc --account-ref; không dùng mode này để điền password tự động khi thiếu credential.
Trên Windows quyền riêng tư profile dùng ACL của user Windows, không dựa vào chmod POSIX.
Node/launcher và Chromium fixture được kiểm tra trên VPS Linux; chưa kiểm thử thực thi .cmd hoặc login thật
trên máy Windows của người dùng. Kết quả Windows phải được xác nhận bằng READY/sessionSaved và READY/reusedSession.
