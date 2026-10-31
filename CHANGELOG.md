# Nhật ký thay đổi

Mỗi lần sửa (mỗi Pull Request): tăng VERSION (sửa lỗi → số cuối, tính năng → số giữa) và thêm đúng một mục mới ở đầu
danh sách, theo mẫu bên dưới. Hàng chờ gộp tự đổi sang số kế tiếp khi hai nhánh cùng lấy một số.

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
