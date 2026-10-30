# Tự đăng bài từ web bằng tiện ích Chrome

## Bản 1.6.2: hiển thị kết quả gửi bài và quản lý chờ duyệt

- Tab diễn đàn hiện thông báo khi đã gửi và chờ duyệt, kể cả khi khung soạn thảo vẫn còn nội dung. Đây là kết quả gửi trực tiếp; không bấm nút Đăng lần thứ hai.
- Trên web, **Bài chờ duyệt** (`/pending-posts`) liệt kê riêng các bài nền tảng đã nhận, có tìm kiếm và phân trang. **Xem nội dung** mở trang riêng `/pending-posts/<jobId>` với tiêu đề, nội dung hiện lưu, hashtags, nguồn và tệp đính kèm. Nội dung này có thể khác bản đã gửi nếu variant được sửa sau đó.
- **Xem hàng đợi trên diễn đàn** mở `<forum-base>/my/activity/pending` trên Discourse để xem bản diễn đàn đã nhận. Cần mở trong đúng hồ sơ Chrome và đúng tài khoản đã gửi. Đây là hàng đợi của tài khoản, không phải permalink công khai của từng bài. Sau khi duyệt, dùng **Đã được duyệt** để cập nhật ID/link và chuyển sang **Bài đã đăng**. Xem trang nội dung hoặc hàng đợi không gửi lại bài.
- **Hướng dẫn API** (`/api-guide`) có các bước lấy credential/OAuth, trường cấu hình, callback và giới hạn connector hiện có cho 12 nhóm nền tảng.

## Bản 1.6.1: gửi Discourse trực tiếp trong phiên Chrome

- Khi bật tự đăng, extension dùng phiên hiện tại để gọi `/posts.json`, giữ nguyên Markdown; không cần chờ editor chọn từng nút. Cookie và CSRF chỉ nằm trong tab. Các kiểm tra quyền, CAPTCHA, tag, hạn mức và kiểm duyệt của diễn đàn vẫn áp dụng.
- Chuyên mục lấy từ cài đặt tài khoản hoặc URL; nếu chưa cấu hình, dùng lựa chọn hiện có hoặc chuyên mục chung được cấp quyền. Không tự tạo tag/chuyên mục. Với diễn đàn không có mục chung phù hợp, lưu chuyên mục mặc định trên web một lần.
- Sau khi đã gửi yêu cầu, không chuyển sang bấm nút hoặc tự gửi lại khi mất phản hồi. Chỉ ghi vào **Bài đã đăng** khi đã đọc lại đúng tác giả, nội dung và chủ đề; bài chờ duyệt được ghi riêng.
- Bổ sung composer Mastodon mới (`composer-text`), nhận diện phiên Pixelfed qua tài khoản hiện tại và báo rõ tài khoản DEV bị đình chỉ. Pixelfed vẫn cần ảnh đính kèm.
- Nếu Mastodon giữ nguyên trang soạn bài sau khi đăng, extension đối chiếu bài mới trên hồ sơ bằng tác giả, toàn bộ nội dung và thời điểm gửi. Khi backend tạm mất kết nối, giữ kết quả đã xác minh và thử báo lại, không đăng lại.
- Điều khiển Chrome từ terminal qua CDP là một lựa chọn cho hồ sơ tự động riêng; không cần cho luồng này vì extension đã thực thi lệnh trực tiếp trong Chrome được ghép nối. Không xuất cookie sang terminal.

## Bản 1.5.0: nhập file và đăng nhiều nền tảng trong một lần

- **Tài khoản → Nhập file tài khoản**: chọn XLSX/CSV/TSV (tối đa 2 MiB, 500 dòng), Chrome đã ghép nối và email Google dùng chung nếu có. Cột Social Network và User/Email bắt buộc; hỗ trợ cả file Excel cũ có Tên Social, Email / Account, Password / Auth, URL Social. Có mật khẩu thì dùng thông tin dòng đó; dòng chỉ có email dùng Google. Không thực thi công thức hoặc hướng dẫn trong file.
- Đích Space, publication hoặc chuyên mục có thể đưa vào cột **URL đăng bài**, cùng **Tags** và **Category**. Luồng có đích mặc định được cấu hình tự động. File mẫu ở frontend `/templates/social-accounts.csv`.
- Sau khi Chrome xác nhận phiên đúng tài khoản, kênh đã có luồng đăng được tự bật. Nếu người dùng tắt kênh, kiểm tra đăng nhập sau đó không tự bật lại.
- Bộ lọc **Đã kết nối · có thể đăng**, **Cần thao tác**, **Đã đăng nhập · chưa cấu hình đăng**, **Đang kết nối** phân biệt trạng thái đăng nhập và khả năng đưa bài vào luồng đăng.
- **Tạo bài & đăng tự động** mở mô tả và các tài khoản đủ điều kiện được chọn sẵn trong nhóm đang dùng. Nút **Tạo bằng AI & đăng ngay** tự tạo, duyệt và đưa bài vào hàng đợi; không cần duyệt từng biến thể. Tối đa 50 nền tảng/100 tài khoản; AI chạy tối đa 4 yêu cầu đồng thời. Không đăng khi chỉ mở hộp thoại.
- Thêm luồng Chrome cho Mastodon.social, Vivaldi Social, Bluesky, Tumblr Text và DEV. Kiểm thử selector bằng fixture không thay thế kiểm tra giao diện thật của từng tài khoản; không gắn nhãn thành công nếu chưa xác nhận được permalink của bài.
- Với tài khoản cho phép xác nhận bằng email, Discourse dùng email của chính phiên hiện tại hoặc Google đã xác nhận trong lượt OAuth. Tên hiển thị có thể khác tên thương hiệu; một email không khớp vẫn bị chặn.

Tiện ích **VPSTTT Social Publisher** (thư mục `browser-extension/`) nhận bài đã duyệt từ web và đăng bằng hồ sơ
Chrome đã ghép nối. Cookie/phiên đăng nhập nằm trong hồ sơ Chrome. Nếu bật tự đăng nhập, mật khẩu và khóa TOTP
do bạn cung cấp được lưu mã hóa ở backend; không lưu trong cấu hình thông thường hay storage của tiện ích.

## Bản 1.3.0: nhiều tài khoản cùng nền tảng, tự đăng nhập và TOTP

### Bản 1.4.2: nhập cấu hình và test đăng nhập hàng loạt

Trên **Tài khoản**, phần **Test đăng nhập social** hiển thị trạng thái riêng cho mỗi account.
**Test đăng nhập hàng loạt** xếp lượt kiểm tra vào hàng đợi của hồ sơ đã gán. Tiện ích chỉ đăng nhập,
nhận diện account và báo kết quả; không mở composer, không tạo PublishJob và không đăng bài.
Trạng thái **Đăng nhập thành công** chưa xác nhận quyền đăng hoặc credential API của nền tảng.
Tiện ích chạy tối đa 3 nền tảng độc lập cùng lúc trong một Chrome. Các lượt dùng cùng phạm vi cookie hoặc
Google chạy tuần tự. Mỗi lần đọc trang có giới hạn 8 giây, thao tác xác thực 10 giây; trang bị kẹt được báo
riêng để hàng đợi tiếp tục. Việc gửi mật khẩu/TOTP không tự lặp lại khi hết thời gian.

Đợt chọn **VPSTTT** dùng thông tin của từng dòng trong bảng dán mới, bao gồm danh tính Google của dòng đó.
Chỉ các username/URL hồ sơ chứa `vpsttt` (không phân biệt hoa thường, gồm các biến thể đã chọn) được nhập
vào đợt test. Cả nhóm được gán cho Chrome hiện tại; tiện ích xử lý lần lượt và kiểm tra đúng username
trước khi báo thành công. Tài khoản thiếu mật khẩu chỉ kiểm tra phiên sẵn có, không dùng mật khẩu của dòng khác.
Các cấu hình ngoài lựa chọn được giữ lại nhưng loại khỏi nút test hàng loạt và hàng đợi mới.

Khi Google đưa ra **Thử cách khác**, tiện ích chọn phương thức **Authenticator** nếu có, lấy mã TOTP
hiện tại và tiếp tục. CAPTCHA hoặc bước xác minh không có phương thức tự xử lý sẽ được ghi rõ trên web.
Một lần kiểm tra chỉ thử mật khẩu và TOTP một lần. Các lượt dùng cùng một danh tính Google trong cùng đợt sẽ dừng nếu
Google đang yêu cầu xác minh chưa hoàn tất; không áp dụng việc dừng này chỉ vì xuất hiện ô nhập TOTP.

Các công cụ local:

- `scripts/read-social-accounts.py`: đọc XLSX và bảng dán, mặc định chỉ xuất thống kê đã loại secret.
- `scripts/import-social-accounts.cjs`: nhập dữ liệu qua stdin vào backend để mã hóa; gộp dòng trùng,
  đánh dấu thiếu/mâu thuẫn dữ liệu; các account mới chưa bật đăng bài.
- `scripts/run-login-checks.cjs --watch`: khởi động hồ sơ Chromium riêng cho các account đăng nhập trực tiếp
  khi có lượt test từ web, tối đa hai hồ sơ cùng lúc. Không điều khiển hoặc đóng Chrome cá nhân.
- Cấu hình riêng của launcher nằm trong `%LOCALAPPDATA%\VPSTTT Social Publisher`; thông tin Google và
  mã ghép nối được bảo vệ bằng Windows DPAPI, không nằm trong repository hoặc báo cáo.

Hồ sơ Chrome cá nhân cần nạp extension **1.4.2** và cấp các tên miền mới một lần. Trang Cài đặt tải lại danh sách
quyền từ backend khi mở. Trong chế độ `--current-chrome`, không chạy launcher hồ sơ riêng. Launcher local
chỉ dùng bản sao extension cấp quyền cho đúng các tên miền của các account được gán cho hồ sơ test.
Launcher phải đang chạy để mở các hồ sơ test; chưa tự cài dịch vụ khởi động cùng Windows.

Mở `chrome://extensions` trong từng hồ sơ và Reload tiện ích lên **1.4.2**. Mỗi hồ sơ dùng một mã ghép nối riêng.
Tab hoặc cửa sổ mới trong cùng hồ sơ vẫn dùng chung phiên đăng nhập; chúng không thay thế hồ sơ riêng.
Bản này thêm quyền `webNavigation` để nhận đúng popup đăng nhập Google mở từ tab đang xử lý bài.

Ví dụ cấu hình nhiều tài khoản Google cho cùng các social:

| Hồ sơ Chrome | Google dùng để đăng nhập | Các tài khoản social trong hồ sơ |
|---|---|---|
| Chrome A | Google A | Medium A, Substack A, Quora A |
| Chrome B | Google B | Medium B, Substack B, Quora B |
| Chrome C | Google C | Medium C, Substack C, Quora C |

Tạo một account trên web cho mỗi đích/tài khoản social. Sau khi lưu luồng đăng, mở **Phiên Chrome / 2FA**:

1. Chọn hồ sơ Chrome sẽ nhận bài của account đó, username và URL hồ sơ trên nền tảng đích.
2. Bật **Tự đăng nhập khi hết phiên**, chọn đăng nhập trực tiếp hoặc **Đăng nhập bằng Google**.
3. Nhập trang đăng nhập của nền tảng. Với Google, đây là trang Medium/Substack… có nút Continue with Google;
   tiện ích theo luồng của nền tảng qua `accounts.google.com`, không điền mật khẩu Google vào form của social.
4. Nhập tên đăng nhập/mật khẩu. Bật **Tự điền mã TOTP** và nhập khóa thiết lập Base32 hoặc `otpauth://totp/…`.
   Với Google SSO, dùng mật khẩu và khóa TOTP của tài khoản Google. Mã 6 số đang hiện trên Authenticator không phải
   khóa thiết lập. Để trống mật khẩu/khóa khi sửa để giữ giá trị đã mã hóa của cùng danh tính đăng nhập.
5. Trong Cài đặt tiện ích, cấp quyền các tên miền mới; Google SSO cần thêm `https://accounts.google.com/*`.
   Giữ các hồ sơ Chrome đang chạy. Extension không tự khởi động Chrome khi ứng dụng đã đóng.

Sau thiết lập, chọn nhiều account cùng nền tảng trong chiến dịch. Backend chuyển từng bài tới đúng hồ sơ;
tiện ích kiểm tra danh tính → dùng lại phiên hoặc tự đăng nhập → điền TOTP nếu cần → mở composer → đăng bài.
Hai hồ sơ riêng có thể đăng cùng một nền tảng đồng thời. Trong mỗi hồ sơ, các bài cùng đích vẫn tuần tự.
Một hồ sơ không được gán hai account dùng chung phạm vi cookie (kể cả các subdomain Quora/Substack).
Các account dùng Google trong cùng hồ sơ phải dùng cùng danh tính Google.

Các tài khoản chưa gán hồ sơ chỉ giữ tương thích cũ khi chủ sở hữu có đúng một Chrome đã ghép nối và đúng một
account trong phạm vi cookie đó. Khi thêm account hoặc Chrome khác, cần gán rõ **Phiên Chrome / 2FA**;
không chọn ngẫu nhiên một hồ sơ. Tiện ích cũ chưa hỗ trợ giao thức xác thực sẽ không nhận bài đã gán hồ sơ.

Mật khẩu và TOTP được cấp cho đúng thiết bị đang giữ claim của job, qua endpoint không cache. Khóa TOTP không
rời backend; mỗi job chỉ được thử mật khẩu/TOTP một lần. Tắt tự đăng nhập trong form sẽ xóa phần secret của
luồng extension, giữ các credential khác. Form web chỉ trả cờ đã cấu hình, không trả lại secret.

Nếu username không khớp, không xác định được tài khoản, mã bị từ chối, gặp CAPTCHA, SMS/email hoặc xác nhận
thiết bị, luồng dừng trước khi đăng và báo cần xử lý trên web. Sau khi xử lý, dùng **Giao lại cho tiện ích**.
Không tự thử liên tiếp mã khác. Một số giao diện cần CSS nhận diện tài khoản ở phần nâng cao; chỉ dùng phần tử
chứa tên/link hồ sơ của tài khoản đang đăng nhập, không dùng tên tác giả một bài bất kỳ.

Kiểm thử gồm hai hồ sơ Chromium + extension MV3 thật trên một website giả lập, mỗi hồ sơ tự đăng nhập bằng
mật khẩu hoặc qua popup Google giả lập, hoàn tất TOTP và đăng đúng account. Không dùng tài khoản Google thật
trong kiểm thử; các giao diện thật, yêu cầu xác minh và chính sách đăng nhập của nền tảng có thể làm luồng dừng.

```powershell
node --import tsx --test scripts/extension-e2e/account-sessions.test.cjs scripts/extension-e2e/auth-actions.test.cjs
```

Migration `20261030010000_extension_account_sessions` thêm thiết bị giữ claim và dấu thời gian thử xác thực.
Backend tự chạy migration khi khởi động bằng Docker Compose.

| Loại diễn đàn | Ví dụ | Trang cần dán |
|---|---|---|
| XenForo 2 | voz.vn, forum.directadmin.com, www.cloudpanelforum.org | Trang "Đăng chủ đề" của box, kết thúc `/post-thread` |
| Discourse | community.nginx.org, caddy.community, forums.truenas.com | Trang chủ diễn đàn, hoặc `/new-topic?category=<slug>` |
| phpBB 3 | forum.example.com | `posting.php?mode=post&f=<id box>` |

Mạng xã hội có API chính thức (Threads, Instagram, Tumblr, Bluesky…) vẫn đi đường API, không dùng tiện ích.

## Bản 1.2.0: các nền tảng mới

Các luồng sau có từ bản **1.2.0**, tiếp tục dùng trong bản **1.3.0** hiện tại.
Tiện ích cũ chưa hỗ trợ các engine mới sẽ không nhận nhầm những bài này. Tổng cộng có **22 cấu hình luồng**:
14 diễn đàn bên dưới và 8 nền tảng mới.

| Nền tảng | Đích cấu hình trên web | Luồng tự động |
|---|---|---|
| Medium | `https://medium.com/new-story` | Tiêu đề, nội dung, topics nếu cấu hình, Publish → Publish now; tắt gửi email |
| Substack | `https://TEN-PUBLICATION.substack.com/publish/post` | Bài viết publication; tắt **Send via email and Substack app inbox**, chỉ xuất bản web |
| Quora | `https://TEN-SPACE.quora.com/` | Tạo post trong Space có quyền đăng; ghép tiêu đề và nội dung vào bài |
| Reddit | `https://www.reddit.com/r/TEN-SUBREDDIT/submit` hoặc `/user/TEN-USER/submit` | Text post, tiêu đề, nội dung, flair cấu hình nếu cần, Post |
| SlideShare | `https://www.slideshare.net/upload` | Tải PDF, tiêu đề, mô tả, chuyên mục, tags, Publish khi nền tảng cho upload |
| AWS Community / AWS Builder Center | `https://builder.aws.com/create/content` | Tiêu đề, tóm tắt, nội dung trong Slate, tags nếu cấu hình, xác nhận Publish |
| Tinhte.vn | `https://tinhte.vn/editorv2/create/ID-CHUYEN-MUC/` | Tiêu đề, nội dung trong CKEditor, Đăng; chuyên mục lấy từ URL |
| pixelfed.social | `https://pixelfed.social/i/web` | Tải ảnh, qua bước chỉnh ảnh, điền caption, Post |

**Tumblr, Bluesky, Mastodon.social và social.vivaldi.net** đã có connector API tự động nên giữ luồng đó.
Chọn các tài khoản API và tiện ích trong cùng chiến dịch để đăng nhiều nền tảng từ web.

Thiết lập một lần:

1. **Tài khoản → Kết nối / cấu hình → Luồng đăng bằng tiện ích Chrome** → chọn nền tảng, tạo tài khoản.
2. Điền đích đăng riêng. Với Tinhte, vào chuyên mục cần đăng, bấm viết bài rồi sao chép URL
   `/editorv2/create/<số>/`; `/editorv2` đơn lẻ không phải trang tạo bài hợp lệ.
3. Cấu hình tags, flair hoặc chuyên mục nếu luồng có yêu cầu; giữ **Tự bấm Đăng** bật và lưu.
4. Đăng nhập sẵn trên Chrome đã ghép nối, vào Cài đặt tiện ích và **Cấp quyền nền tảng** cho tên miền mới.

Các lần đăng sau: chuẩn bị/duyệt nội dung và khởi chạy chiến dịch trên web; tiện ích nhận bài mỗi khoảng 30 giây,
chạy tối đa 3 đích khác tên miền cùng lúc. Không cần mở popup hay bấm **Kiểm tra ngay**.

SlideShare cần **đúng một PDF**, Pixelfed cần **đúng một ảnh JPEG/PNG/WebP**, tối đa **20 MiB**.
Trong **Studio**, chọn biến thể tương ứng → **Media đính kèm → Upload & gắn** trước khi tạo/chạy chiến dịch.
File riêng của biến thể được ưu tiên; nếu chưa có mới lấy file gắn với nội dung gốc. Không tự chọn một file bất kỳ
khi có nhiều file cùng loại. Thiếu file hoặc sai định dạng sẽ báo lỗi trên web.

Tình trạng kiểm chứng ngày 30/10/2026:

- Các bước đăng được kiểm thử bằng Chromium và trang giả lập, gồm extension MV3 thật, hàng đợi tự chạy,
  lấy file từ backend, Substack không gửi email và xác nhận đúng permalink/nội dung. Chưa đăng thử trên tài khoản
  thật của 8 nền tảng mới. Giao diện đăng nhập thực tế thay đổi có thể cần điều chỉnh selector.
- [SlideShare đang tạm ngừng upload](https://support.scribd.com/hc/en-us/articles/360055667671-Uploading-content-to-Slideshare).
  Luồng đã có nhưng chưa thể đăng khi chức năng của họ chưa hoạt động; tiện ích nhận diện thông báo này và báo lỗi.
- [Substack cho phép chỉ đăng web bằng cách tắt email/app inbox](https://support.substack.com/hc/en-us/articles/360037831771-How-do-I-publish-a-new-post-on-Substack).
  Tiện ích dừng nếu không xác nhận được tuỳ chọn đó.
- Hết phiên đăng nhập, CAPTCHA, thiếu quyền hoặc kiểm duyệt của nền tảng vẫn có thể cần người xử lý.
  Chỉ ghi **Đã đăng** khi xác nhận được bài và link; đã gửi nhưng chưa rõ kết quả thì không tự gửi lại.

## Bản 1.1.0: nhiều diễn đàn từ giao diện web

Các luồng diễn đàn của bản **1.1.0** tiếp tục được hỗ trợ trong **1.3.0**.
Sau khi ghép nối, đăng nhập diễn đàn và cấp quyền tên miền, giữ Chrome mở; tiện ích tự nhận bài từ web mỗi khoảng
30 giây. Không cần mở popup hoặc bấm **Kiểm tra ngay** cho mỗi bài.

Danh mục có 14 cấu hình riêng. Đây là các diễn đàn của nhà cung cấp/cộng đồng, không yêu cầu bạn tự dựng Discourse:

| Luồng | Diễn đàn | Bộ soạn thảo |
|---|---|---|
| NGINX Community | https://community.nginx.org | Discourse |
| Caddy Community | https://caddy.community | Discourse |
| AlmaLinux Forum | https://forums.almalinux.org | Discourse |
| TrueNAS Community | https://forums.truenas.com | Discourse |
| Level1Techs Forum | https://forum.level1techs.com | Discourse |
| Linux Containers Forum | https://discuss.linuxcontainers.org | Discourse |
| HestiaCP Forum | https://forum.hestiacp.com | Discourse |
| MikroTik Community | https://forum.mikrotik.com | Discourse |
| OpenNebula Community | https://forum.opennebula.io | Discourse |
| Replit Community | https://replit.discourse.group | Discourse |
| MongoDB Community | https://www.mongodb.com/community/forums | Discourse |
| Voz Forums | https://voz.vn | XenForo |
| DirectAdmin Forums | https://forum.directadmin.com | XenForo |
| CloudPanel Forum | https://www.cloudpanelforum.org | XenForo |

Mỗi tài khoản lưu riêng trang tạo bài, chuyên mục, tag và chế độ tự bấm Đăng. Backend kiểm tra đúng tên miền và
loại diễn đàn của luồng. Danh mục không xác nhận quyền đăng của tài khoản: tài khoản cần được diễn đàn cho phép
tạo chủ đề. MongoDB trước đó trả `can_create_topic: false`, nên tài khoản này vẫn tắt.

Một chiến dịch có thể chọn nhiều tài khoản diễn đàn. Tiện ích chạy tối đa **3 luồng đang đăng** cùng lúc; các bài
cùng tên miền chạy lần lượt để giữ riêng bản nháp, kể cả khi một bài đang chờ thao tác. Mỗi bài nhận tiêu đề,
nội dung và kết quả riêng. Bài gặp CAPTCHA chuyển sang chờ thao tác, các diễn đàn khác vẫn tiếp tục.
Phần còn lại nằm trong hàng đợi.

## Luồng hoạt động

```text
Chiến dịch → job → worker → ExtensionConnector: job "Chờ tiện ích Chrome"
Tiện ích (30 giây/lần) → POST /extension/agent/claim → nhận từng bài, tối đa 3 luồng đang đăng
  → mở tab trang tạo chủ đề → điền → bấm Đăng → xác nhận link, tiêu đề và nội dung đầu bài
  → POST /extension/agent/tasks/:id/result {PUBLISHED, url} → job "Đã đăng", lưu link
```

- Gặp **CAPTCHA**, hoặc tài khoản tắt **Tự bấm Đăng**: tiện ích điền sẵn, đưa tab lên trước, job hiện "Tiện ích cần
  bạn". Bạn giải CAPTCHA / kiểm tra rồi bấm Đăng; tiện ích tự nhận ra link bài và báo "Đã đăng". Tab đang chờ không
  làm tắc các bài khác (tối đa 5 tab chờ cùng lúc).
- **Chưa đăng nhập diễn đàn**, không thấy form, tab bị đóng trước khi điền, chưa cấp quyền: job "Thất bại" kèm lý
  do. Những lỗi này chắc chắn chưa gửi gì, nên bấm **Retry** trên trang Publishing là an toàn.
- **Đã bấm Đăng nhưng không thấy bài mới / diễn đàn báo lỗi / tiện ích im lặng quá 10 phút**: không bao giờ tự đăng
  lại. Kiểm tra diễn đàn rồi bấm **Đã đăng** (dán link) hoặc **Giao lại cho tiện ích**.
- **Post Needs Approval**: bài đã được diễn đàn nhận và đang chờ quản trị viên duyệt. Web hiển thị **Chờ diễn đàn
  duyệt**, không tự gửi lại và không cho giao lại bài này. Sau khi duyệt, dùng link bài thật để xác nhận **Đã đăng**.
  Hiện bộ nhận diện tự động hỗ trợ thông báo tiếng Anh đã quan sát trên NGINX.
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

1. **Tài khoản → Kết nối / cấu hình → Luồng đăng bằng tiện ích Chrome** → chọn diễn đàn → tạo tài khoản.
   Mặc định dùng tiện ích, không cần API key. Form cấu hình luồng mở ngay sau khi tạo.
2. Với Discourse: trang `/new-topic` và loại diễn đàn được điền sẵn. Nhập **Chuyên mục (slug hoặc ID)** và **Tags**
   có sẵn của chuyên mục. Ví dụ riêng NGINX: chuyên mục `projects/nginx`, tag `web-server`; không sao chép cấu hình
   này sang diễn đàn khác. Với XenForo: vào đúng box, bấm tạo chủ đề rồi sao chép URL `/post-thread`.
3. Bật **Tự bấm Đăng** nếu muốn tự gửi, rồi **Lưu**. Đăng nhập diễn đàn trong đúng Chrome đã ghép nối và cấp quyền
   cho tên miền mới trong Cài đặt tiện ích. Đăng nhập và cấp quyền là thao tác thiết lập ban đầu.
4. **Chiến dịch → Tạo tự động** → chọn nhiều tài khoản đã cấu hình → chuẩn bị/duyệt nội dung và chạy chiến dịch.
   Theo dõi từng bài trên trang **Publishing**. Các lần sau chỉ cần thao tác trên web, trừ khi diễn đàn yêu cầu
   đăng nhập lại, CAPTCHA hoặc thao tác bổ sung.

## Theo dõi

Từ bản 1.4.3, bảng Tài khoản ưu tiên nhóm đã chọn từ lần nhập VPSTTT. Có thể chuyển bộ lọc sang toàn bộ tài khoản
để xem các mục cũ. Tài khoản đã gán Chrome dùng nút **Test** để giao lượt kiểm tra đăng nhập cho extension;
không gọi nhầm bài kiểm tra API key. Kết quả tự cập nhật trên web. Bật tài khoản sẽ tự kiểm tra lại phiên Chrome.

**Đã gán Chrome** chưa đồng nghĩa với đăng nhập hoặc đăng được bài. **Đã đăng nhập** xác nhận đúng danh tính;
**Đã kết nối** cần thêm luồng đăng đã cấu hình và tài khoản được bật. Các mục thiếu nơi đăng hoặc chưa có luồng
đăng tự động hiển thị riêng. Thành công đăng nhập không xác nhận quyền đăng bài hoặc bỏ qua kiểm duyệt.

Nếu Google báo mã TOTP không đúng, extension không gửi lặp mã. Chỉ lỗi xác minh thật của Google mới dừng các
lượt dùng chung Google; lỗi nhận diện form của riêng một social không chặn cả nhóm. Google đã đăng nhập có thể
vẫn yêu cầu xác minh lại khi đăng nhập ứng dụng mới.

Bản 1.4.4 bổ sung nhận diện hồ sơ Stack Exchange bằng ID trong thanh điều hướng, tránh nhầm nhãn tag “login”
với nút đăng nhập, và nhận diện menu tài khoản Differ. Khi một lượt hoàn tất trong lúc đang polling, lượt tiếp theo
được kiểm tra ngay; không phải chờ chu kỳ 30 giây. Trang SSO chuyển sang origin chưa cấu hình được báo rõ tên miền
và trả hàng đợi ngay, không chờ hết thời gian rồi báo lỗi chung.

- Biểu tượng tiện ích: `…` đang đăng, số màu cam = số tab đang chờ bạn, `ERR` = không gọi được backend, `II` = tạm dừng.
  Popup hiện bài đang làm và 6 kết quả gần nhất.
- Web quản trị: trang **Publishing** ghi "Chờ tiện ích Chrome" / "Tiện ích cần bạn"; Dashboard → **Cần xử lý** báo
  "Chrome chưa chạy" khi có bài chờ mà không Chrome nào kết nối trong 3 phút.

## API (cho người phát triển)

| Endpoint | Ai gọi | Ghi chú |
|---|---|---|
| `GET/POST /api/v1/extension/devices`, `DELETE …/:id` | Web (JWT, tạo/thu hồi: ADMIN) | Mã chỉ trả một lần; DB lưu SHA-256 |
| `PUT /api/v1/extension/accounts/:id` | Web (ADMIN) | `{ enabled, engine, targetUrl, autoSubmit, tags?, category?, flair? }`; nền tảng API cần có luồng tiện ích tương ứng trong danh mục |
| `POST /api/v1/extension/accounts/import` | Web (ADMIN) | Multipart XLSX/CSV/TSV tối đa 2 MiB, `deviceId`, `googleEmail` tuỳ chọn; mã hoá credential và xếp lượt kiểm tra, không trả secret |
| `PUT /api/v1/extension/accounts/:id/session` | Web (ADMIN) | Gán hồ sơ, danh tính, phương thức login và secret mã hóa; không trả lại secret |
| `POST /api/v1/extension/jobs/:id/requeue` | Web (ADMIN/EDITOR) | Chỉ job tiện ích đang chờ người vận hành; không nhận bài đã chờ diễn đàn duyệt |
| `POST /api/v1/extension/agent/heartbeat` | Tiện ích (`Bearer spx_…`) | Số bài chờ, danh sách tên miền cần quyền |
| `POST /api/v1/extension/agent/claim` | Tiện ích | `{ excludeOrigins?: string[], supportedEngines?: string[] }` bỏ qua tên miền đang bận và engine chưa hỗ trợ; nhận 1 bài (khoá bằng `lockedAt`), quá 10 phút không báo → `EXTENSION_RESULT_UNKNOWN` |
| `GET /api/v1/extension/agent/tasks/:id/media/:assetId` | Tiện ích | File thuộc nội dung/biến thể và chủ sở hữu của job đã nhận; giới hạn 20 MiB, kiểm tra checksum. Token thiết bị chỉ ở service worker, không truyền vào trang đích |
| `POST /api/v1/extension/agent/tasks/:id/auth` | Đúng thiết bị giữ claim | Bước identifier/password/TOTP trên origin đã cấu hình; không cache, không trả khóa TOTP |
| `POST /api/v1/extension/agent/tasks/:id/result` | Tiện ích | `PUBLISHED` cần link đúng tên miền và đúng mẫu link chủ đề |

Bảng `extension_devices` thêm bởi migration `20261024090000_extension_devices` (tự chạy khi API khởi động bằng
`prisma migrate deploy`).

## Nhập tài khoản và đăng từ giao diện web

Trong **Tài khoản → Nhập file tài khoản**, chọn Chrome đã ghép nối và tải XLSX, CSV hoặc TSV.
Mẫu CSV nằm ở `/templates/social-accounts.csv` trên frontend. Các cột cơ bản: Social Network,
User, Pass, 2FA, Phương thức Login, URL Profile; có thể thêm URL đăng bài, Tags và Category.
Công thức trong Excel không được thực thi. Mật khẩu và khóa TOTP được mã hoá ở backend,
không trả về màn hình kết quả nhập file.

Dòng có mật khẩu dùng phương thức trong file; dòng chỉ có email chuyển sang Google.
Email Google chung trong hộp nhập chỉ áp dụng cho các dòng Google, không thay mật khẩu
của dòng đăng nhập trực tiếp. Chrome dùng phiên Google sẵn có. Trang chỉ hỗ trợ email/mật khẩu,
chưa có blog/Space, yêu cầu CAPTCHA hoặc xác minh khác sẽ hiện lý do ở **Cần thao tác**.

Sau khi xác nhận đúng tài khoản, các luồng đã đủ đích đăng tự bật và chuyển **Đã kết nối**.
Bộ lọc phân biệt kết nối có thể đăng, đã đăng nhập nhưng chưa đủ cấu hình, đang kiểm tra,
và cần thao tác. Có phiên đăng nhập không đồng nghĩa nền tảng đã cấp quyền đăng bài.
Nhiều danh tính khác nhau trên cùng website vẫn cần các hồ sơ Chrome riêng để giữ đúng phiên.

Chọn **Tạo bài & đăng tự động**, nhập mô tả chung rồi bấm **Tạo bằng AI & đăng ngay**.
Các tài khoản sẵn sàng trong nhóm nhập đã chọn được chọn sẵn. Hệ thống tạo một biến thể cho
mỗi nền tảng, tự duyệt, xếp việc đăng cho từng tài khoản và tiện ích nhận việc khi Chrome đang mở.
Không cần bấm popup tiện ích cho mỗi bài. Tối đa 50 nền tảng mỗi lần; AI chạy tối đa 4 yêu cầu
song song. Khóa chống trùng giữ cùng một lượt gửi khi web gửi lại yêu cầu.
Luồng yêu cầu ảnh/PDF vẫn cần tệp phù hợp, và bài chờ diễn đàn duyệt không được tự gửi lại.

## Kiểm tra tài khoản đã đăng nhập và kết nối thủ công

Quora hỗ trợ hai nơi đăng: `https://www.quora.com/` cho bài cá nhân công khai (**Add question → Create Post → Everyone → Post**),
hoặc `https://TEN-SPACE.quora.com/` cho Space của bạn. Bản 1.6.3 nhận diện editor mới của Quora; tự đặt tiêu đề ở đầu
nội dung và bấm Post khi bật **Tự bấm Đăng**. Nếu gặp một bản nháp khác hoặc đối tượng xem bài không phải Everyone,
luồng bài cá nhân báo rõ nguyên nhân và giữ bản nháp. Việc nhận diện tài khoản vẫn dựa trên phiên Chrome đã gán.

Trong **Tài khoản**, nút **Test**, **Kiểm tra tất cả** và **Hướng dẫn kết nối → Tôi đã đăng nhập · Kiểm tra**
chỉ xác nhận phiên sẵn có trên Chrome đã ghép nối. Các lượt này không lấy mật khẩu/TOTP từ backend và
không đăng bài. Hệ thống kiểm tra tối đa 3 nền tảng khác nhau đồng thời; các tài khoản dùng chung phiên
của một nền tảng vẫn được kiểm tra lần lượt. Tính năng đăng nhập tự động ở bảng kiểm tra hàng loạt được giữ riêng.

Nếu tài khoản hiện **Cần thao tác**, mở **Hướng dẫn kết nối** tại đúng dòng tài khoản:

1. Bấm **Mở nền tảng** trong đúng hồ sơ Chrome đã cài tiện ích; đăng nhập và hoàn tất xác minh tại nền tảng.
2. Kiểm tra username/link hồ sơ tại **Phiên Chrome / 2FA** rồi bấm **Tôi đã đăng nhập · Kiểm tra** trên web.
3. Nếu đã xác nhận phiên nhưng còn thiếu nơi đăng, chọn **Cấu hình đăng bài**, điền URL chuyên mục/Space/blog,
   bật **Tự bấm Đăng**, lưu và kiểm tra lại.

**Đã đăng nhập** chỉ xác nhận danh tính; **Đã kết nối** còn yêu cầu đã cấu hình và bật luồng đăng qua tiện ích.
Nền tảng chưa có luồng đăng tự động không thể bật đăng chỉ bằng cách đăng nhập lại. Tài khoản bị đình chỉ hoặc
bị từ chối quyền tạo bài vẫn nằm trong bộ lọc **Cần thao tác**, kể cả khi phiên đăng nhập còn hiệu lực.

## Cập nhật danh mục trong database đã có dữ liệu

Các bản cài mới lấy cấu hình từ seed. Với database hiện có, sau khi build và khởi động backend mới, đồng bộ riêng
metadata luồng; không chạy lại toàn bộ seed và không đổi trạng thái tài khoản:

```powershell
Get-Content scripts/sync-extension-flows.cjs -Raw -Encoding UTF8 | docker compose exec -T api node -
Get-Content scripts/sync-extension-flows.cjs -Raw -Encoding UTF8 | docker compose exec -T api node - --apply
```

Lệnh đầu chỉ xem thay đổi. Lệnh thứ hai gộp metadata vào `defaultSettings`, giữ cấu hình khác và kiểm tra xung đột.
Chạy lại sẽ không cập nhật nếu dữ liệu đã đúng. Nguồn danh mục: `src/connectors/extension/extension-flows.ts`.

Nếu database cũ vẫn ghi Tumblr là `manual`, đồng bộ riêng các connector API đã có (Tumblr, Bluesky, Mastodon.social,
Vivaldi). Script chỉ cập nhật metadata/capability của bốn nền tảng này, giữ tài khoản, credential và job:

```powershell
Get-Content scripts/sync-social-api-platforms.cjs -Raw -Encoding UTF8 | docker compose exec -T api node -
Get-Content scripts/sync-social-api-platforms.cjs -Raw -Encoding UTF8 | docker compose exec -T api node - --apply
```

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
đã đăng; chế độ chờ bấm hoạt động; bài vướng CAPTCHA không chặn bài khác.

Kiểm thử bản 1.1.0 với tiện ích MV3 thật và ba diễn đàn localhost: NGINX giả lập gặp CAPTCHA, Caddy và DirectAdmin
giả lập vẫn nhận đúng bài riêng. Kiểm tra thêm polling không mở popup, chống gửi trùng, thông báo chờ duyệt và
không nhận nhầm topic đang xem thành bài đã đăng:

```powershell
node --import tsx --test scripts/extension-e2e/background.test.cjs scripts/extension-e2e/page-actions.test.cjs scripts/extension-e2e/loaded-extension.test.cjs scripts/extension-e2e/multi-flow.test.cjs
node --import tsx --test scripts/extension-e2e/social-actions.test.cjs scripts/extension-e2e/social-extension.test.cjs
```

Ảnh người dùng cung cấp cho thấy NGINX thật đã nhận một bài chờ duyệt. Các diễn đàn mới chưa được kiểm chứng đăng
bằng tài khoản thật; bài kiểm thử trên localhost không đăng ra ngoài.
