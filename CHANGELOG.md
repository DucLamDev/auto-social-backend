# Nhật ký thay đổi

Mỗi lần sửa (mỗi Pull Request): tăng VERSION (sửa lỗi → số cuối, tính năng → số giữa) và thêm đúng một mục mới ở đầu
danh sách, theo mẫu bên dưới. Hàng chờ gộp tự đổi sang số kế tiếp khi hai nhánh cùng lấy một số.

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

## 1.0.0 · 21/10/2026
### Bảo trì
- Bắt đầu đánh số phiên bản
  Từ bản này mỗi lần gộp có một số phiên bản và ghi thay đổi ở đây.
