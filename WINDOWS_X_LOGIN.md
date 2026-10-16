# Kiểm tra login X trên Windows 10

Bộ này chạy Chrome đã cài trên máy của bạn với profile riêng, nhận diện login và giữ session cho lần sau.
Không cần Docker, database, backend server hoặc auth_v2.csv để thử login thủ công.
Không đăng tweet. Chưa có kết quả login thật trên Windows cho đến khi bạn chạy và nhận đúng kết quả dưới đây.
Chrome do Playwright mở vẫn có thể bị X từ chối dù Chrome cá nhân truy cập được; không có cam kết đổi máy sẽ hết 403.

## Cách chạy

1. Tải và giải nén x-login-windows.zip vào một thư mục riêng trên máy Windows.
2. Máy cần Node.js 22 trở lên và Chrome đã cài. Bộ không tự cài Node/Chrome hoặc tải Chromium.
   Kiểm tra Node bằng `node --version`; nếu chưa có, nhờ người quản lý máy cài Node trước.
3. Chạy `1-SETUP.cmd` một lần. Lệnh cài dependency Node vào node_modules trong thư mục vừa giải nén,
   theo package-lock.json, không cài global và không chạy install scripts. Cần kết nối npm registry.
4. Chạy `2-LOGIN-X.cmd`. Trong **cửa sổ Chrome do lệnh này mở**, đăng nhập đúng tài khoản X,
   tự xử lý CAPTCHA, OTP/email/device nếu có. Sau login hãy mở `https://x.com/home`.
   Để cửa sổ mở cho đến khi terminal báo kết quả; timeout 5 phút.
5. Khi bot nhận diện được giao diện account và cookie xác thực, nó lưu phiên rồi tự đóng Chrome.
6. Chạy `3-CHECK-SESSION.cmd`. Bot mở lại cùng profile, truy cập /home và chỉ kiểm tra phiên;
   không điền mật khẩu, không submit login. Để cửa sổ mở tới khi kiểm tra xong.

Các file .cmd dừng để bạn đọc kết quả trước khi đóng terminal. Nếu Windows chặn file mới tải,
kiểm tra nguồn và nội dung file theo quy định máy của bạn; bộ không thay policy hệ thống.

## Kết quả để nghiệm thu

Lần login cần có các trường sau trong JSON cuối terminal:

```json
{"status":"READY","sessionSaved":true,"mode":"LOGIN"}
```

Lần kiểm tra lại cần có:

```json
{"status":"READY","reusedSession":true,"mode":"SESSION_CHECK_ONLY"}
```

Lần check có sessionSaved=false là bình thường: nó dùng phiên đã có, không tạo snapshot mới.
Đây là JSON minh họa tiêu chí, không phải kết quả đã chạy trên máy bạn.
Nếu thấy ERROR, SESSION_NOT_VERIFIED hoặc cần login lại thì chưa đạt. Gửi lại hai dòng JSON kết quả để đối soát;
không gửi password, OTP, cookie, file session hoặc key. Login và session đạt vẫn chưa chứng minh đăng tweet được.

## Profile và Chrome

Profile và snapshot mặc định giữ tại `%LOCALAPPDATA%\VPSTTT\SocialPublisher\profiles`.
Giữ nguyên profile và .session-key. Session hết hạn/bị thu hồi vẫn cần login lại.
Trên Windows, bảo vệ thư mục bằng quyền user Windows/NTFS; chmod POSIX không cung cấp ACL tương đương.
Snapshot mã hóa nhưng profile Chrome vẫn chứa dữ liệu nhạy cảm; bộ không gửi dữ liệu này lên VPS.
Chrome cá nhân đang mở có thể giữ nguyên, vì bot dùng profile riêng. Không mở cùng profile bot bằng hai tiến trình.

Bộ tìm chrome.exe trong Program Files, Program Files (x86) và LocalAppData của user.
Nếu Chrome nằm chỗ khác, đặt PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH tới đúng chrome.exe rồi chạy từ terminal đó.
Không trỏ profile bot vào User Data/Profile của Chrome cá nhân.

Muốn thử account khác bằng profile riêng, trong CMD ở thư mục bộ chạy:

```bat
node windows-x-login.cjs login account02
node windows-x-login.cjs check account02
```

Nhãn account01/account02 chỉ định profile, không phải username/email. Dùng cùng nhãn cho login và check,
và kiểm tra bạn đã đăng nhập đúng account trong giao diện X. Không có credential được đóng gói trong bộ này.
