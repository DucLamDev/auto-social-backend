# Nhật ký thay đổi
Mỗi lần sửa (mỗi Pull Request): tăng VERSION (sửa lỗi → số cuối, tính năng → số giữa) và thêm đúng một mục mới ở đầu
danh sách, theo mẫu bên dưới. Hàng chờ gộp tự đổi sang số kế tiếp khi hai nhánh cùng lấy một số.
## 1.6.3 · 03/11/2026
### Sửa lỗi
- Nhập file không còn lấy nhầm tên màn hình của trang làm username
  Ô URL Profile điền link như `voz.vn/register/complete`, `dev.to/onboarding`, `medium.com/get-started/topics`,
  `discord.com/channels/@me` từng bị đọc thành username "register", "onboarding"… nên kiểm tra đăng nhập luôn báo sai
  tài khoản và tài khoản nằm mãi ở "Cần thao tác". Nay các link đó không được dùng: lần kiểm tra đầu nhận tài khoản đang
  đăng nhập trong Chrome và lưu lại. Đọc đúng thêm link Tumblr `/blog/ten` và `/author/ten`. Nhập lại file để sửa các
  tài khoản đã nhập trước đây.
- Warrior Forum báo rõ là chỉ đăng thủ công
  Điều khoản Warrior Forum cấm bot, script hay hệ thống tự động truy cập trang, nên luồng đăng ghi "Chỉ đăng thủ công"
  kèm link điều khoản thay vì "chưa có luồng đăng" như đang chờ làm thêm.
## 1.6.2 · 03/11/2026
### Sửa lỗi
- Nhập file tài khoản từ giao diện web cũ báo lỗi dễ hiểu thay vì "Too many fields"
  Khi backend đã lên 1.6.1 mà giao diện web chưa cập nhật, hộp Nhập file còn ô "Google dùng chung" và lần nhập bị từ chối
  với chữ "Too many fields". Nay nếu các ô đó còn điền, hệ thống báo rõ ô Google dùng chung đã bỏ, cần xoá trống ba ô
  hoặc tải lại trang sau khi cập nhật giao diện 1.4.1; để trống thì nhập bình thường bằng tài khoản của từng dòng.
- Kiểm tra đăng nhập nhận ra tài khoản đã đăng nhập trên daily.dev, Tumblr, Hugging Face (tiện ích 1.8.2)
  daily.dev đã chuyển từ app.daily.dev sang daily.dev nên trước đây bị báo "tên miền chưa được cấu hình"; nay tài khoản
  đã nhập tự dùng tên miền mới, không cần nhập lại. Với trang chưa có cách nhận diện riêng, tiện ích nhận tài khoản khi
  thấy link tới đúng URL hồ sơ đã khai trong thanh điều hướng, hoặc tự mở URL hồ sơ đó một lần và thấy nút chỉ chủ tài
  khoản mới có (Edit profile, Modifier l'apparence…). Hugging Face đọc tên tài khoản đang đăng nhập từ chính trang.
  Bluesky đọc handle và email của phiên đang đăng nhập: email trùng email đăng nhập đã khai thì nhận đúng tài khoản và
  tự cập nhật handle mới. Khi Chrome đăng nhập tài khoản khác, lời báo ghi rõ @handle đang đăng nhập và @handle đã cấu
  hình để sửa đúng chỗ.
## 1.6.1 · 03/11/2026
### Sửa lỗi
- Kiểm tra đăng nhập hàng loạt đóng tab, nhận đúng tài khoản và không đứng im (tiện ích 1.8.1)
  Kiểm tra xong (thành công hay cần thao tác) là đóng tab và popup Google. Tài khoản đã đăng nhập không còn bị báo "Cần
  thao tác" chỉ vì tên hiển thị khác chữ hoa, dấu hay ký tự so với handle trong URL hồ sơ. Trang chỉ hỏi email như
  Substack: tài khoản mật khẩu được tự bấm "Sign in with password"; tài khoản Google mà trang không có nút Google được
  báo rõ ngay thay vì để trống tới hết giờ.
- Bỏ "Google dùng chung" khi nhập file tài khoản
  Mỗi dòng giờ đăng nhập bằng đúng email, mật khẩu và mã 2FA của chính dòng đó, vì các social trong một file thường dùng
  nhiều tài khoản Google khác nhau. API nhập file chỉ còn nhận file và Chrome đã chọn.
## 1.6.0 · 03/11/2026
### Tính năng
- Tiện ích Chrome nhờ AI tìm ô / nút khi giao diện mạng xã hội đổi (bản 1.8.0)
  Khi không thấy ô tiêu đề, ô nội dung, nút mở khung soạn hoặc nút Đăng, tiện ích gửi danh sách phần tử đang hiện (đã che
  dữ liệu, không có nội dung đã nhập hay mật khẩu) để AI chọn, rồi điền lại đúng một lần. Gợi ý chưa duyệt chỉ điền sẵn để
  bạn kiểm tra và bấm Đăng; gợi ý đã được ADMIN duyệt thì tự đăng và được dùng cho các lần sau. Chỉ thiếu nút Đăng thì
  chỉ ghi gợi ý. Cần backend bật EXTENSION_UI_RECOVERY_ENABLED; nạp lại extension để dùng bản mới.
## 1.5.0 · 03/11/2026
### Tính năng
- AI gợi ý ô và nút khi giao diện mạng xã hội thay đổi (phía máy chủ)
  Khi tiện ích Chrome không tìm thấy ô tiêu đề, ô nội dung, nút mở khung soạn hoặc nút Đăng, nó có thể gửi danh sách
  phần tử đang hiện (đã che email, số, chuỗi dài; không có giá trị ô nhập hay mật khẩu) để AI chọn đúng phần tử. Máy
  chủ kiểm lại từng lựa chọn (đúng loại ô, nút Đăng không phải nút Huỷ / Xoá / Nháp, đủ độ tin cậy) và lưu thành gợi ý
  chờ duyệt. Gợi ý chưa duyệt chỉ được dùng để điền sẵn, bạn tự bấm Đăng; ADMIN duyệt trên API hoặc qua Codex (MCP) thì
  lần sau tiện ích tự đăng bằng selector đó. Tắt sẵn (EXTENSION_UI_RECOVERY_ENABLED); cần chạy migration mới. Phần tiện
  ích dùng tính năng này ra ở bản tiện ích tiếp theo.
## 1.4.0 · 03/11/2026
### Tính năng
- Codex xem và điều phối hệ thống qua MCP
  Backend có cổng MCP tại /mcp để Codex (hoặc agent khác) làm việc bằng chat: xem tài khoản, tiện ích Chrome đã ghép
  nối, kết quả kiểm tra đăng nhập, việc đăng bài và chiến dịch; xếp kiểm tra đăng nhập, chạy lại việc lỗi, giao lại
  việc cho tiện ích, và nhờ AI viết bản nháp chiến dịch (dừng ở chờ duyệt). Cổng tắt sẵn (MCP_ENABLED); token tạo bằng
  lệnh pnpm mcp:token, chỉ lưu mã băm, có thể chỉ cho xem, đặt hạn và thu hồi. Quyền giống web của chủ token, không trả
  mật khẩu hay cookie, mọi lệnh ghi được ghi nhật ký. Duyệt và đăng thật qua Codex chỉ có khi bật MCP_ALLOW_PUBLISH.
  Cần chạy migration mới (mcp_tokens).
## 1.3.0 · 03/11/2026
### Tính năng
- Viết bài bằng AI API của IDE công ty (VPSTTT AI)
  Thêm nhà cung cấp AI thứ tư "VPSTTT AI" dùng mục AI API của IDE (tài khoản Claude/Codex công ty cấp), không cần mua
  key OpenAI hay Gemini. Đặt AI_DEFAULT_PROVIDER=vpsttt cùng VPSTTT_AI_BASE_URL (https) và VPSTTT_AI_API_KEY; Studio và
  Tạo tự động chọn được VPSTTT AI cho từng lần. Backend chỉ gửi đúng các tham số API này nhận, giữ mỗi lượt dưới 100.000
  ký tự, giới hạn số lượt cùng lúc và số lượt mỗi phút theo hạn mức của key, và báo rõ khi key sai hoặc IP chưa được
  cho phép. Gemini, OpenAI, DeepSeek giữ nguyên để dùng song song hoặc dự phòng.
## 1.2.1 · 03/11/2026
### Cải tiến
- Tiện ích Chrome nhận bài kế tiếp ngay sau bài trước (bản 1.7.6)
  Đăng xong một bài, hoặc bài chuyển sang chờ bạn xử lý (bản nháp chờ bấm Đăng, CAPTCHA, đăng nhập), tiện ích hỏi bài
  tiếp theo sau khoảng 1 giây thay vì chờ chu kỳ 30 giây, nên hàng đợi nhiều bài chạy nhanh hơn. Vẫn chỉ một lượt đăng
  tại một thời điểm, tối đa ba tab; tiện ích đang tạm dừng thì không nhận bài. Tệp VERSION được sửa lại còn đúng một
  dòng. Nạp lại extension trong chrome://extensions để dùng bản mới.
## 1.2.0 · 02/11/2026
### Tính năng
- Mật khẩu và khoá TOTP Google dùng chung khi nhập file tài khoản
  Hộp "Nhập file tài khoản" có thêm hai ô Mật khẩu Google và Khoá TOTP Google cạnh email Google dùng chung. Nhập một
  lần, hệ thống lưu mã hoá và áp cho mọi dòng đăng nhập bằng Google đó, nên tiện ích tự đăng nhập Google và tự điền mã
  2 bước khi phiên hết hạn. Khoá TOTP là khoá thiết lập hoặc chuỗi otpauth:// (xuất được từ extension Authenticator),
  không phải mã 6 số; khoá sai bị báo ngay trước khi nhập.
## 1.2.0 · 31/10/2026
### Tính năng
- Nhập file cấu hình API, hệ thống tự kết nối
  ADMIN tải lên một file Excel/CSV, mỗi dòng một tài khoản dev.to, Mastodon, Bluesky, Discord, Discourse hoặc
  WordPress kèm khoá. Hệ thống tạo hoặc cập nhật tài khoản, lưu khoá đã mã hoá, tự kiểm tra kết nối và báo kết quả
  từng dòng (đã kết nối, khoá sai, thiếu cột, trùng dòng…). Nhập lại cùng file chỉ cập nhật, không tạo trùng. Tài
  khoản đang đăng qua tiện ích Chrome cùng username được gắn khoá và chuyển sang đăng bằng API khi kiểm tra đạt.
  Instagram, Threads, Blogger, LinkedIn, Tumblr vẫn cần bấm Kết nối một lần; file báo rõ các dòng này.
## 1.1.2 · 02/11/2026
### Sửa lỗi
- Một nền tảng lỗi không còn làm kẹt cả hàng đợi đăng bài
  Trước đây khi 5 tab chờ bạn xử lý (Tinhte, DZone, Quora…) thì tiện ích ngừng nhận bài mới tới 30 phút, các social
  phía sau nằm chờ mãi. Nay tab chờ cũ nhất được nhả ra để bài mới chạy tiếp; bài đó vẫn ở Cần thao tác trên web.
- Bài đã đăng mà bị báo "không thấy bài mới" giảm hẳn
  Tiện ích chờ xác nhận tới 3 phút, kiểm mỗi 5 giây, nhận bài bị rút gọn trên feed, link theo tiêu đề và tự xem trang
  cá nhân của tài khoản (nếu đã khai URL hồ sơ) trước khi nhờ bạn kiểm tra. Không bao giờ bấm Đăng lại.
- Thông báo "Đang tạo bài viết đợi xíu nhé" của Tinhte (và các thông báo đang xử lý khác) không còn bị coi là lỗi.
- Minds đăng được từ khung soạn mới trên newsfeed; Stack Overflow / Server Fault nhận đúng tag đã chọn.
- Tài khoản bị nền tảng đình chỉ (vd. Discuit "is suspended") được báo đúng lý do thay vì như sai mật khẩu.
- Bài AI bị lỗi hiện nguyên chuỗi "\n" (ví dụ trên diễn đàn TrueNAS) được sửa thành xuống dòng thật, cả với bài đã tạo.
### Vận hành
- Cần nạp lại tiện ích Chrome bản 1.7.4.
## 1.2.0 · 31/10/2026
### Tính năng
- Bài AI viết hay hơn, đúng ngôn ngữ và đúng quy cách từng nơi đăng
  AI biết bài sẽ đăng ở đâu nên viết đúng ngôn ngữ người đọc: diễn đàn quốc tế dùng tiếng Anh, Tinhte và Voz dùng
  tiếng Việt. Bài cũng đúng giới hạn ký tự (Bluesky 300, Threads 500, X…) và đúng định dạng của nơi đăng. Prompt mới
  (phiên bản 3) yêu cầu câu mở đầu gây chú ý, chi tiết cụ thể và giọng người thật trong cộng đồng; với diễn đàn thì
  chia sẻ giá trị trước, nhắc thương hiệu nhẹ và có câu tự giới thiệu. Tên chiến dịch không còn bị dùng làm tiêu đề bài.
- Hồ sơ thương hiệu cho AI
  ADMIN lưu một lần ở cài đặt `ai.brand-profile`: sản phẩm, số liệu thật, link, giọng văn, câu tự giới thiệu, điều
  cấm nói. AI chỉ được nói về thương hiệu bằng các thông tin này hoặc thông tin trong mô tả bài.
- AI tự chấm bài trước khi đăng
  Mỗi bài được máy kiểm tra (độ dài, ngôn ngữ, tiêu đề, câu sáo) và AI chấm điểm từ 1 đến 10. Bài dưới 7 điểm được
  viết lại một lần. Vẫn chưa đạt thì bài không tự đăng mà nằm ở "Cần thao tác" kèm nhận xét. Người vận hành duyệt
  (có thể sửa) qua API `approve-content` thì bài được xếp lịch đăng lại. Mỗi nền tảng tốn thêm 1 đến 3 lượt gọi AI.
### Sửa lỗi
- Bài đăng qua tiện ích không còn vượt giới hạn ký tự vì bị nối thêm hashtag; diễn đàn không còn bị gắn dòng
  hashtag ở cuối bài; nơi chỉ nhận văn bản thường không còn hiện ký hiệu Markdown như `**` hay `##`.
- Một nền tảng gặp lỗi tạm thời của AI (giới hạn tốc độ, máy chủ AI bận, JSON sai) được thử lại một lần thay vì làm
  hỏng cả chiến dịch.
### Vận hành
- Database đang chạy cần chạy `scripts/sync-ai-prompts.cjs` (xem trước, rồi `--apply`) để dùng prompt mới; có
  `--rollback 2` để quay lại prompt cũ.
## 1.1.1 · 01/11/2026
### Sửa lỗi
- Tiện ích Chrome 1.7.3 chọn ô nhập và nút đăng trong hộp soạn đang mở, hỗ trợ cả Shadow DOM; không chọn nút ngoài hộp khi nút đăng chưa sẵn sàng.
- Chờ đủ tiêu đề và nội dung cho phép nhập trước khi điền, chuyển sang tab Text của Reddit khi cần và giữ bản nháp khác đang có trong các luồng social.
- Bổ sung kiểm thử trình duyệt cho khung soạn tải chậm, nhiều editor, nút trùng và bản nháp. Kiểm thử dùng trang giả lập, chưa xác nhận đăng trên tài khoản thật.
## 1.1.0 · 21/10/2026
### Tính năng
- Kết nối Instagram và Threads bằng một lần đăng nhập, token tự gia hạn
  Bấm "Kết nối" trên trang Tài khoản, đăng nhập Meta và cấp quyền là xong; không cần dán token tay nữa. Hệ thống
  đổi sang token 60 ngày và tự gia hạn mỗi giờ khi còn dưới 15 ngày, nên không phải đăng nhập lại trừ khi Meta thu
  hồi quyền. Cần đặt INSTAGRAM_APP_ID/SECRET, THREADS_APP_ID/SECRET trong cấu hình backend.
- Tự kiểm tra tài khoản và báo khi cần xử lý
  Mỗi ngày 03:15 hệ thống tự kiểm tra kết nối mọi tài khoản; API GET /account-health trả danh sách tài khoản cần
  kết nối lại, token sắp hết hạn và bài đăng bị kẹt. Nếu đặt ALERT_WEBHOOK_URL (Slack, Google Chat, Discord), cảnh
  báo được gửi về kênh chat.
- Đăng Instagram/Threads ổn định hơn
  Chờ Meta xử lý xong ảnh rồi mới đăng; dùng địa chỉ API mới graph.threads.com.
- Khi đăng nhập OAuth lỗi hoặc bị huỷ, người dùng được đưa về trang Tài khoản kèm lý do thay vì trang lỗi JSON.
- Kết nối Tumblr bằng nút "Kết nối"
  Mỗi blog của tài khoản thành một điểm đến; token tự làm mới, đăng bài chữ có tiêu đề và tag. Cần TUMBLR_CLIENT_ID/SECRET.
- Bluesky dùng App Password thay cho token 2 giờ, không còn phải nhập lại.
- Blogger, Tumblr có lựa chọn Đăng ngay hoặc Lưu nháp cho từng tài khoản.
- Đăng diễn đàn bằng tiện ích Chrome
  Cài tiện ích VPSTTT Social Publisher vào Chrome đã đăng nhập diễn đàn, ghép nối bằng mã ở trang Tài khoản. Tiện ích
  tự nhận bài, mở trang tạo chủ đề, điền và bấm Đăng rồi báo link bài về hệ thống. Hỗ trợ XenForo (Voz, cPanel,
  DirectAdmin…), Discourse (NGINX, Caddy, TrueNAS…) và phpBB. Gặp CAPTCHA thì điền sẵn và chờ bạn bấm; không lưu mật
  khẩu hay cookie trên máy chủ.
- Chế độ demo một tiến trình (INLINE_PUBLISH_WORKER, chỉ môi trường dev): chạy thử toàn bộ luồng chỉ với PostgreSQL.
### Sửa lỗi
- Không đăng trùng khi Instagram/Threads/Tumblr không trả lời ở bước đăng: job dừng ở Cần thao tác để người vận hành
  đối soát, thay vì tự gửi lại.
- Lỗi mạng khi làm mới token Google/Tumblr không còn đánh dấu tài khoản "Cần kết nối lại".
### Vận hành
- Thêm TESTING.md (hướng dẫn test từng bước) và lệnh `pnpm smoke:stack` kiểm tra nhanh hệ thống sau khi dựng.

## 1.0.0 · 21/10/2026
### Bảo trì
- Bắt đầu đánh số phiên bản
  Từ bản này mỗi lần gộp có một số phiên bản và ghi thay đổi ở đây.
