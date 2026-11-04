# Tự đăng bài từ web bằng tiện ích Chrome

## Bản 1.10.1: tag của bài AI cho Stack Exchange, Discourse, DEV, SlideShare

- Trước đây tiện ích chỉ nhận tag cấu hình trong tài khoản, bỏ mất tag AI viết kèm bài. Vì vậy Stack Exchange (Stack
  Overflow, Server Fault, Unix & Linux) báo "Câu hỏi cần ít nhất một tag", chuyên mục Discourse bắt buộc tag thì dừng ở
  "Đã điền bài", còn DEV và SlideShare đăng thiếu tag.
- Nay máy chủ gửi kèm **tag AI gợi ý** đã chuẩn hoá theo từng trang. Tiện ích dùng tag cố định trong cấu hình trước,
  rồi thêm tag AI:
  - Stack Exchange: chỉ chọn tag trang đã có trong gợi ý, không bấm Enter tạo tag mới; tối đa 5. Tag AI không có trên
    trang thì bỏ qua; không còn tag nào thì dừng và nêu tên các tag đã thử.
  - Discourse: tra tag trong chuyên mục (`/tags/filter/search`), chỉ dùng tag chuyên mục cho phép; diễn đàn tắt tag thì
    bỏ qua. Lối điền giao diện thử tối đa 3 tag và không dùng dòng "Create tag".
  - DEV và SlideShare: tài khoản chưa cấu hình tag thì điền tag AI (DEV: chữ thường và số, tối đa 4).
- Tài khoản Stack Exchange không còn bắt buộc cấu hình tag.
- Cần backend 1.12.2. Tải lại tiện ích trên Chrome (`chrome://extensions` → Tải lại) để có bản mới. Bài đang báo lỗi tag
  thì bấm **Giao lại cho tiện ích**.

## Bản 1.10.0: đăng bài daily.dev

- daily.dev có luồng đăng bài viết (tiêu đề + nội dung) lên **hồ sơ cá nhân** đang đăng nhập, qua khung soạn
  **Create post** tại `https://daily.dev/squads/create`. Chưa hỗ trợ đăng vào Squad: khi tài khoản không có quyền đăng
  vào Squad trong `?sid=`, daily.dev lặng lẽ chuyển sang đăng lên hồ sơ, nên trang có tham số bị từ chối.
- Tiện ích điền tiêu đề (tối đa 250 ký tự) và nội dung dạng đoạn văn, kiểm tra lại cả hai rồi bấm **Post** đúng một lần;
  sau khi daily.dev chuyển sang trang `/posts/…`, tiện ích so tiêu đề và đầu bài rồi báo **Đã đăng** kèm link.
- Khung soạn còn bản nháp khác (daily.dev tự lưu nháp) thì dừng, không ghi đè. Tắt **Tự bấm Đăng** thì chỉ điền sẵn.
- Ô và nút được lấy từ mã nguồn mở của daily.dev (`dailydotdev/apps`), chưa thử với tài khoản thật từ máy dev. Nếu báo
  lỗi, mở `flow-audit.html?open=daily` (trang chẩn đoán đã trỏ sang `daily.dev/squads/create`) hoặc bật gợi ý ô bằng AI (bản 1.8.0).
- Cần backend 1.8.0. Tài khoản daily.dev đã nhập trước đó cần cấu hình nơi đăng: nhập lại file tài khoản, hoặc bấm
  **Tiện ích** ở dòng tài khoản, giữ trang tạo bài mặc định, bật **Tự bấm Đăng** rồi **Lưu**.
- Hugging Face chưa có luồng: Blog Article chỉ mở cho tài khoản PRO hoặc thành viên tổ chức gói Team/Enterprise.

## Bản 1.9.1: kiểm tra đăng nhập trên Chrome mới (VPS)

- Trước khi bấm nút **Đăng nhập bằng Google**, **Log in** hay nút SSO, tiện ích đưa tab kiểm tra lên trước. Nhiều trang
  không mở đăng nhập Google từ tab đang chạy ẩn, nên trước đây tab đứng yên rồi báo "Bước đăng nhập chưa được chấp nhận".
- Trang kiểm tra trình duyệt toàn màn hình của Cloudflare ("Just a moment…", hay gặp với IP của VPS) được chờ tự qua tới
  20 giây thay vì báo CAPTCHA ngay. reCAPTCHA, hCaptcha hay Turnstile nằm trong form vẫn dừng để bạn xử lý.
- Cần backend 1.7.1 và frontend 1.6.1: nút **Test**, **Kiểm tra tất cả** cũng tự đăng nhập như kiểm tra hàng loạt.

## Bản 1.9.0: gắn ảnh cho Bluesky, Mastodon, Tumblr, LinkedIn

- Bài có ảnh (ảnh AI của kênh hoặc ảnh bạn tải lên) được gắn vào khung soạn **sau khi** điền và kiểm tra chữ:
  - Mastodon / Vivaldi Social: ô chọn tệp ẩn của nút tải ảnh; chờ tải xong mới bấm Publish.
  - Bluesky: dán ảnh vào ô soạn; Bluesky tự thu nhỏ ảnh dưới 1 MB.
  - Tumblr: nút Photo hoặc dán ảnh vào trình soạn.
  - LinkedIn: Add media → chọn tệp → Next; điền alt text nếu có ô.
- Chỉ bấm Đăng khi khung soạn hiện ảnh. Không thấy ảnh trong 45 giây thì tiện ích dừng với "Đã điền bài nhưng chưa
  gắn được ảnh": gắn ảnh rồi bấm Đăng tay, hoặc bỏ ảnh của kênh đó trên web rồi chạy lại. Bài không có ảnh đi như cũ.
- Giao diện thật của bốn trang chưa được thử từ máy dev; nếu báo lỗi, mở `flow-audit.html?open=bluesky,mastodon,tumblr,linkedin`
  trong tiện ích để xem ô chọn tệp (`fileInputs`) nằm ở đâu.
- Nạp lại extension trong `chrome://extensions` để dùng bản 1.9.0. Test giả lập: `scripts/extension-e2e/social-media-attach.test.cjs`.

## Bản 1.8.2: nhận ra thêm tài khoản đã đăng nhập

- **daily.dev**: trang đã chuyển từ `app.daily.dev` sang `daily.dev`; tài khoản đã nhập tự dùng tên miền mới (backend
  1.6.2). Cấp quyền `https://daily.dev` trong Cài đặt tiện ích nếu được hỏi.
- **Trang chưa có cách nhận diện riêng** (daily.dev, Tumblr…): tiện ích coi là đúng tài khoản khi thanh điều hướng có
  link tới đúng **URL hồ sơ** đã khai, hoặc tự mở URL hồ sơ đó một lần và thấy nút chỉ chủ tài khoản mới có (Edit
  profile, Edit appearance, Modifier l'apparence, Chỉnh sửa hồ sơ…). Vì vậy cần khai đúng URL hồ sơ cho từng tài khoản.
- **Hugging Face**: đọc tên tài khoản đang đăng nhập từ trang (`/api/whoami-v2`), không cần mở menu avatar.
- **Bluesky**: đọc handle và email của phiên đang đăng nhập (chỉ hai trường này, không đọc token). Email trùng email
  đăng nhập đã khai thì nhận đúng tài khoản dù handle đã đổi; backend lưu handle mới.
- **"Chrome đang đăng nhập tài khoản khác"** giờ ghi rõ `@handle` đang đăng nhập và `@handle` đã cấu hình.
- Nạp lại extension trong `chrome://extensions` để dùng bản 1.8.2.

## Bản 1.8.1: kiểm tra đăng nhập gọn và đúng hơn

- **Kiểm tra đăng nhập xong là đóng tab**, kể cả popup đăng nhập Google, dù thành công hay cần thao tác. Kết quả xem
  trên web; nút **Hướng dẫn kết nối → Mở nền tảng** mở lại trang khi cần đăng nhập tay.
- **Nhận đúng tài khoản dù tên hiển thị khác chữ hoa / dấu / ký tự** ("VPSTTT Group" khớp `vpsttt_group`), và khi link hồ
  sơ của tài khoản đang đăng nhập trùng URL hồ sơ đã khai (không phân biệt hoa thường). Tài khoản khác hẳn vẫn bị báo
  "Chrome đang đăng nhập tài khoản khác".
- **Trang chỉ hỏi email (Substack…)**: tài khoản đăng nhập bằng mật khẩu được tự bấm "Sign in with password" rồi điền
  email + mật khẩu. Tài khoản đăng nhập bằng Google mà trang không có nút Google thì báo rõ sau vài giây (không đứng im
  tới hết giờ); tiện ích không bao giờ điền mật khẩu Google vào form của nền tảng.
- Link không có địa chỉ trên trang không còn làm bước đăng nhập dừng ngầm tới hết giờ.
- Nạp lại extension trong `chrome://extensions` để dùng bản 1.8.1.

## Bản 1.8.0: AI tìm ô / nút khi giao diện mạng xã hội đổi

Cần backend 1.5.0 trở lên và bật `EXTENSION_UI_RECOVERY_ENABLED=true`; tắt thì tiện ích chạy như bản 1.7.6.

- **Khi không tìm thấy ô tiêu đề, ô nội dung, nút mở khung soạn hoặc nút Đăng**, tiện ích mô tả các phần tử đang hiện
  (tối đa 60: loại, nhãn, placeholder, chữ trên nút; không có giá trị đã nhập, ô mật khẩu, nội dung bài; email, chuỗi dài,
  dãy số dài bị che) và hỏi backend. AI chỉ trả số thứ tự phần tử; backend và tiện ích cùng kiểm lại đúng loại ô.
- **Điền lại đúng một lần** bằng phần tử AI chọn. Gợi ý **chưa được duyệt** thì chỉ điền sẵn, tab chờ bạn kiểm tra rồi
  bấm Đăng (báo "AI đã tìm ô / nút mới…" ở Cần thao tác). Gợi ý **đã được ADMIN duyệt** (API
  `POST /api/v1/extension/selector-suggestions/:id/approve` hoặc Codex qua MCP) thì được tự đăng như bình thường, và từ
  lần sau backend gửi luôn selector đó cho đúng trang này nên không cần hỏi AI nữa.
- **Chỉ thiếu nút Đăng** (bài đã nằm trong khung soạn): tiện ích chỉ ghi gợi ý, không điền lại; bạn bấm Đăng trong tab.
- **Thiếu nút mở khung soạn**: sau khi AI tìm được nút mở, tiện ích được hỏi thêm một lần cho các ô bên trong; không bao
  giờ quá hai lần cho một bài. AI không trả lời được thì bài báo "Không thấy form đăng bài" như trước.
- Không chạy cho kiểm tra đăng nhập, khi gặp CAPTCHA / đăng nhập / tài khoản bị khoá, hoặc sau khi đã bấm Đăng.
- Nạp lại extension trong `chrome://extensions` để dùng bản 1.8.0.

## Bản 1.7.6: nhận bài kế tiếp ngay

- Đăng xong một bài, hoặc bài chuyển sang chờ bạn xử lý (bản nháp chờ bấm Đăng, CAPTCHA, đăng nhập, không thấy form),
  tiện ích hỏi backend bài kế tiếp sau khoảng 1 giây thay vì chờ chu kỳ 30 giây. Hàng đợi nhiều bài chạy nhanh hơn tới
  30 giây mỗi bài.
- Giới hạn giữ nguyên: một lượt đăng tại một thời điểm, tối đa ba tab tác vụ, không mở tab thứ hai trên diễn đàn đang
  có bản nháp chờ. Tiện ích đang tạm dừng thì không nhận bài mới.
- Nạp lại extension trong `chrome://extensions` để dùng bản 1.7.6.

## Bản 1.7.4: không kẹt hàng đợi, xác nhận bài chắc hơn

- **Tab chờ không còn chặn bài mới.** Trước đây đủ 5 tab "chờ bạn" thì tiện ích ngừng nhận bài cho tới khi các tab hết
  hạn 30 phút. Nay khi đã có 5 tab chờ, tiện ích ngừng theo dõi tab chờ cũ nhất để nhận bài tiếp; ưu tiên nhả tab đã bấm
  Đăng. Tab vẫn mở, bài vẫn ở **Cần thao tác** trên web để bấm **Đã đăng** hoặc **Giao lại cho tiện ích**. Tab đã bấm
  Đăng không còn giữ chỗ tên miền, nên bài khác trên cùng nền tảng vẫn chạy.
- **Thông báo đang xử lý không còn bị coi là lỗi.** Câu như "Đang tạo bài viết đợi xíu nhé" (Tinhte), "please wait" hay
  báo thành công bị bỏ qua. Một thông báo lỗi chỉ được coi là bị từ chối khi vẫn còn hiện ở lần kiểm sau ít nhất 8 giây.
- **Xác nhận bài sau khi bấm Đăng:**
  - Chờ tối đa 3 phút (trước là 60 giây), kiểm mỗi 5 giây.
  - So 12 từ đầu của nội dung, vì feed hay rút gọn bài (Quora "(more)").
  - Tìm link bài trong khối chứa bài kể cả khi trang không dùng thẻ `article`, và nhận link có chữ đúng bằng tiêu đề bài
    (trang danh sách, trang cá nhân).
  - Hết 3 phút vẫn chưa thấy: nếu **Phiên Chrome / 2FA** có URL hồ sơ cùng tên miền, tiện ích mở trang hồ sơ đó (Quora
    mở `/posts`) để tìm bài, tối đa 60 giây. Bước này chỉ đọc trang, không điền và không bấm Đăng lại.
  - Không tìm thấy thì báo **Cần thao tác** như trước. Tab còn được theo dõi 10 phút để tự nhận bài nếu bài hiện muộn.
- **Nhận diện thêm câu báo đã gửi duyệt** ("submitted to moderation", "Staging Ground", "đang chờ kiểm duyệt"), nhưng bỏ
  qua câu mô tả tương lai như "will be reviewed".
- **Minds:** đăng được từ khung soạn "Speak your mind…" ngay trên newsfeed; hộp soạn kiểu cũ vẫn phải là **My Channel**.
- **Stack Exchange:** nhận đúng tag đã chọn (chip `nginx ×`); không có gợi ý khớp thì nhập tag bằng Enter như người dùng.
  Lời nhắn lỗi ghi đúng tên trang (Server Fault, Unix & Linux…).
- **Tài khoản bị đình chỉ hoặc khoá** (vd. "@vpsttt is suspended." trên Discuit) được báo đúng lý do và dừng; không coi là
  sai mật khẩu, không thử đăng nhập lại.
- Lời nhắn gửi về web được cắt dưới 500 ký tự. Backend từ chối kết quả (4xx) thì tiện ích ngừng gửi lại và giải phóng chỗ.
- Nạp lại extension trong `chrome://extensions` để dùng bản 1.7.4.

## Bản 1.7.3: nhận diện đúng khung soạn bài

- Chọn tiêu đề, nội dung và nút đăng trong hộp soạn đang mở, kể cả hộp dùng Shadow DOM. Khi có nhiều hộp không xác định được duy nhất, dừng để người dùng xử lý.
- Chờ đủ các ô cho phép nhập; nút đăng bị khóa không khiến tiện ích bấm sang nút Post ngoài hộp. Với editor nằm trong form, tìm nút trong cùng form.
- Reddit chuyển sang tab Text/Văn bản nếu chưa có ô nội dung. Các luồng social kiểm tra cả tiêu đề và nội dung trước khi điền để không ghi đè bản nháp khác.
- Nạp lại extension trong `chrome://extensions` để dùng bản 1.7.3. Kiểm thử tự động tại `scripts/extension-e2e/composer-discovery.test.cjs` dùng trang giả lập; chưa thay thế kiểm chứng trên phiên Chrome và quyền đăng thật.
- Các kênh chưa có luồng (`FLOW_REQUIRED`), thiếu nơi đăng (`DESTINATION_REQUIRED`) hoặc bị hạn chế quyền vẫn cần xử lý riêng. Đăng nhập thành công không đồng nghĩa đã kiểm tra được composer.

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

- **Tài khoản → Nhập file tài khoản**: chọn XLSX/CSV/TSV (tối đa 2 MiB, 500 dòng) và Chrome đã ghép nối. Cột Social Network và User/Email bắt buộc; hỗ trợ cả file Excel cũ có Tên Social, Email / Account, Password / Auth, URL Social. Có mật khẩu thì dùng thông tin dòng đó; dòng chỉ có email dùng Google. Không thực thi công thức hoặc hướng dẫn trong file.
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
**Test đăng nhập hàng loạt** xếp lượt kiểm tra vào hàng đợi của hồ sơ đã gán, **bỏ qua tài khoản mà lần kiểm tra gần
nhất đã đăng nhập thành công** (từ backend 1.12.1; gửi `skipAuthenticated: true`), để không đăng nhập lại vô ích và
gặp CAPTCHA. Muốn kiểm lại một tài khoản đã đăng nhập, bấm **Test** ở dòng của nó. Tiện ích chỉ đăng nhập,
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
  làm tắc các bài khác: tiện ích theo dõi tối đa 5 tab chờ, quá số đó thì ngừng theo dõi tab cũ nhất (tab vẫn mở).
- **Chưa đăng nhập diễn đàn**, không thấy form, tab bị đóng trước khi điền, chưa cấp quyền: job "Thất bại" kèm lý
  do. Những lỗi này chắc chắn chưa gửi gì, nên bấm **Retry** trên trang Publishing là an toàn.
- **Đã bấm Đăng nhưng không thấy bài mới / diễn đàn báo lỗi / tiện ích im lặng quá 10 phút**: không bao giờ tự đăng
  lại. Kiểm tra diễn đàn rồi bấm **Đã đăng** (dán link) hoặc **Giao lại cho tiện ích**.
- **Post Needs Approval**: bài đã được diễn đàn nhận và đang chờ quản trị viên duyệt. Web hiển thị **Chờ diễn đàn
  duyệt**, không tự gửi lại và không cho giao lại bài này. Sau khi duyệt, dùng link bài thật để xác nhận **Đã đăng**.
  Hiện bộ nhận diện tự động hỗ trợ thông báo tiếng Anh đã quan sát trên NGINX.
- Nội dung gửi cho tiện ích được dựng ở backend bằng `src/platforms/post-text.ts`, không cần cài lại tiện ích:
  - Diễn đàn và bài viết dài không còn bị nối dòng hashtag vào cuối; tag đi qua ô tags của từng tài khoản.
  - Mastodon, Bluesky, LinkedIn… giữ hashtag ngay trong bài và chỉ thêm tag còn thiếu khi bài vẫn nằm trong giới hạn ký tự.
  - Nơi đăng chỉ nhận văn bản thường (XenForo, Tinhte, Medium, Quora, Reddit…) được chuyển Markdown sang đoạn văn sạch, không còn `**`, `##`.
  - Dòng nguồn ghi "Nguồn:" hoặc "Source:" theo ngôn ngữ của bài.
  - Tiêu đề chỉ bị cắt ở nơi có giới hạn đã biết: diễn đàn 150, Stack Exchange 150, Reddit 300 ký tự.
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
| `POST /api/v1/extension/accounts/import` | Web (ADMIN) | Multipart XLSX/CSV/TSV tối đa 2 MiB, `deviceId`; mỗi dòng dùng email / mật khẩu / 2FA của chính dòng đó; mã hoá credential và xếp lượt kiểm tra, không trả secret |
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
Mỗi dòng đăng nhập bằng đúng tài khoản của dòng đó; không có Google dùng chung (từ backend 1.6.1), vì các social trong
một file thường dùng nhiều tài khoản Google khác nhau. Với dòng "Gmail / Google Auth", cột Pass và 2FA là mật khẩu và
khoá 2 bước của chính email Google ở cột User; tiện ích dùng chúng khi phiên Google trong Chrome hết hạn. Trang chỉ hỗ
trợ email/mật khẩu, chưa có blog/Space, yêu cầu CAPTCHA hoặc xác minh khác sẽ hiện lý do ở **Cần thao tác**.

- **URL Profile** phải là trang hồ sơ (ví dụ `https://voz.vn/u/ten.12345/`, `https://dev.to/ten`). Link màn hình của trang
  như `…/register/complete`, `…/onboarding`, `…/get-started/topics`, `…/dashboard` không được lấy làm username (từ
  backend 1.6.3): tài khoản đó không có username dự kiến, lần kiểm tra đầu nhận tài khoản đang đăng nhập rồi lưu lại.
  Trước đây Voz bị nhận là "register" nên luôn báo **Cần thao tác**; nhập lại file để sửa các dòng như vậy.
- **Warrior Forum** chỉ đăng thủ công: điều khoản của trang cấm bot, script hay hệ thống tự động truy cập, nên không có
  luồng tự đăng.
- Khoá TOTP là **khoá thiết lập** (chuỗi Base32) hoặc chuỗi `otpauth://totp/…`, không phải mã 6 số đang hiện.
- Đang dùng extension **Authenticator**: mở phần sao lưu/xuất của Authenticator để lấy chuỗi `otpauth://…` của tài
  khoản Google, rồi dán vào cột 2FA. Tiện ích VPSTTT tự tính mã giống Authenticator, nên không cần đọc dữ liệu từ
  extension kia; Chrome cũng không cho phép extension đọc dữ liệu của nhau.
- Google vẫn có thể đòi xác nhận trên điện thoại, passkey hoặc CAPTCHA. Khi đó tiện ích dừng và báo **Cần thao tác**.
  Nếu Google cho chọn "Thử cách khác", tiện ích chọn ứng dụng Authenticator.

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

Trong **Tài khoản**, nút **Test**, **Kiểm tra tất cả** và bật công tắc tài khoản (từ frontend 1.6.1) chạy giống
**Test đăng nhập hàng loạt**: dùng phiên sẵn có, Chrome chưa đăng nhập thì tự đăng nhập bằng mật khẩu đã lưu rồi
Google, mỗi cách thử một lần. **Kiểm tra tất cả** cũng bỏ qua tài khoản đã đăng nhập thành công; **Test** ở một dòng luôn
kiểm lại tài khoản đó. Chỉ **Hướng dẫn kết nối → Tôi đã đăng nhập · Kiểm tra** xác nhận phiên sẵn có mà không
lấy mật khẩu/TOTP từ backend, dành cho lúc bạn vừa đăng nhập tay. Không lượt nào đăng bài. Các tài khoản dùng chung
phiên của một nền tảng vẫn được kiểm tra lần lượt.

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

Từ bản 1.7.5, extension chỉ chạy một lượt đăng tại một thời điểm. Tab đã xác nhận đăng thành công hoặc được nền tảng nhận để kiểm duyệt sẽ tự đóng sau khi báo kết quả về backend. Tab CAPTCHA/bản nháp cần người xử lý vẫn được theo dõi; khi có ba tab tác vụ đang giữ, extension ngừng mở thêm cho đến khi có chỗ trống. Sau khi cập nhật thư mục extension, Reload tại `chrome://extensions` để nạp mã mới; trang `reload.html` của extension chờ lượt đang chạy xong và giữ checkpoint trước khi reload.

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
node --import tsx --test scripts/extension-e2e/ui-recovery.test.cjs
```

Ảnh người dùng cung cấp cho thấy NGINX thật đã nhận một bài chờ duyệt. Các diễn đàn mới chưa được kiểm chứng đăng
bằng tài khoản thật; bài kiểm thử trên localhost không đăng ra ngoài.
