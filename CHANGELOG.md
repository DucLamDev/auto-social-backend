# Nhật ký thay đổi

Mỗi lần sửa (mỗi Pull Request): tăng VERSION (sửa lỗi → số cuối, tính năng → số giữa) và thêm đúng một mục mới ở đầu
danh sách, theo mẫu bên dưới. Hàng chờ gộp tự đổi sang số kế tiếp khi hai nhánh cùng lấy một số.

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
