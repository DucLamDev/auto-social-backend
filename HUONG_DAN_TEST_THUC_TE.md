# Hướng dẫn test thực tế từng bước (máy Windows)

Mục tiêu: tự tay thấy hệ thống **tạo bài → tự đăng lên diễn đàn bằng tiện ích Chrome → báo link bài về**, trước trên
diễn đàn giả lập (an toàn tuyệt đối), sau đó trên diễn đàn thật.

Mọi thứ chạy trên **một máy Windows** của bạn: backend bằng Docker Desktop, giao diện quản trị bằng Node, tiện ích trong
Chrome bạn đang dùng. Không cần tên miền, không cần máy chủ.

> Ghi chú cách đọc: `Kết quả đúng` là thứ bạn phải nhìn thấy. Không giống thì xem mục **J. Khi gặp lỗi** trước khi đi
> tiếp. Đánh dấu kết quả vào **Bảng nghiệm thu** ở cuối.

| Phần | Việc | Thời gian |
|---|---|---|
| A | Chuẩn bị máy | 20–30 phút (lần đầu) |
| B | Dựng backend | 10–15 phút |
| C | Chạy giao diện quản trị | 5 phút |
| D | Cài và ghép nối tiện ích Chrome | 5 phút |
| E | Test với diễn đàn giả lập (6 tình huống) | 30 phút |
| F | Test diễn đàn thật (Voz / XenForo) | 20 phút |
| G | Test diễn đàn thật loại Discourse / phpBB (tuỳ chọn) | 15 phút |
| H | Test kênh API nhanh: Discord, Bluesky (tuỳ chọn) | 10 phút |
| I | Theo dõi, cảnh báo | 10 phút |

---

## A. Chuẩn bị máy

1. **Docker Desktop** cho Windows: <https://www.docker.com/products/docker-desktop/>. Cài xong mở Docker Desktop, chờ
   dòng trạng thái góc dưới báo *Engine running*.
2. **Node.js 22 LTS**: <https://nodejs.org/>. Mở **PowerShell** kiểm tra:
   ```powershell
   node -v        # v22.x
   corepack enable
   ```
   Nếu `corepack enable` báo thiếu quyền: mở PowerShell bằng *Run as administrator* rồi chạy lại lệnh đó.
3. **Google Chrome** bản mới (từ 120 trở lên).
4. **Mã nguồn**: tải 3 tệp trong `~/ssd/tai-ve/goi-test-auto-social/` trên Dev VPS (VPSTTT IDE → thanh trái → Tệp →
   chuột phải → Tải về):
   - `auto-social-backend.zip`, `auto-social-frontend.zip`: giải nén vào `C:\social\backend` và `C:\social\frontend`.
   - `VPSTTT-Social-Publisher-1.0.0.zip`: giải nén vào `C:\social\extension`.
   Khi đã được thêm vào dự án, có thể dùng `vpsttt-git clone` thay cho tải zip (nhánh
   `feature/thanhnguyen-meta-oauth-auto-refresh`).
5. **Khoá AI** (để AI tự viết bài): một khoá DeepSeek (rẻ nhất) hoặc OpenAI / Gemini. Không có khoá vẫn test được bằng
   cách tự viết bài (E.2 cách 2) nhưng mất thêm vài bước.

**Kết quả đúng:** Docker Desktop chạy; `node -v` ra v22; có 3 thư mục `C:\social\backend`, `C:\social\frontend`,
`C:\social\extension` (trong thư mục extension thấy tệp `manifest.json`).

---

## B. Dựng backend

Mở PowerShell:

```powershell
cd C:\social\backend
Copy-Item .env.example .env
notepad .env
```

Trong Notepad sửa các dòng sau (giữ nguyên các dòng khác), lưu lại:

| Dòng | Đặt thành |
|---|---|
| `CREDENTIAL_ENCRYPTION_KEY=` | Kết quả lệnh `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"` |
| `JWT_ACCESS_SECRET=` | Kết quả lệnh `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| `JWT_REFRESH_SECRET=` | Chạy lại lệnh trên, dán chuỗi **khác** |
| Mọi giá trị `change_me` (`POSTGRES_PASSWORD`, `RABBITMQ_PASSWORD`, `MINIO_ROOT_PASSWORD`, `S3_SECRET_KEY`…) | Một mật khẩu tự đặt (chữ + số, không dấu cách). `S3_SECRET_KEY` đặt **giống** `MINIO_ROOT_PASSWORD` |
| `SEED_ADMIN_EMAIL=` | Email bạn dùng để đăng nhập trang quản trị |
| `SEED_ADMIN_PASSWORD=` | Mật khẩu ≥ 12 ký tự |
| `AI_DEFAULT_PROVIDER=` | `deepseek` (hoặc `openai` / `gemini` theo khoá bạn có) |
| `DEEPSEEK_API_KEY=` | Khoá AI của bạn |
| `FRONTEND_URL=` | `http://localhost:3000` (mặc định, giữ nguyên) |

Mở terminal mới cho từng lệnh `node -e` nếu cần, chỉ dán **kết quả**, không dán cả câu lệnh vào `.env`.

Chạy:

```powershell
docker compose up -d --build --wait
docker compose exec api corepack pnpm prisma:seed
Invoke-RestMethod http://localhost:3001/ready | ConvertTo-Json
```

Lần đầu `--build` mất 5–10 phút (tải image, cài thư viện).

**Kết quả đúng:**
- Lệnh `up` kết thúc với các dòng `Healthy` / `Started`, không có `Error`.
- Seed in `Seed completed`.
- `/ready` trả `"status": "ready"`, `"database": "up"`, `"redis": "up"`, `"rabbitmq": "up"`.
- `docker compose ps` thấy `api`, `worker`, `postgres`, `redis`, `rabbitmq`, `minio` đều `running` / `healthy`.

---

## C. Chạy giao diện quản trị

PowerShell mới:

```powershell
cd C:\social\frontend
Copy-Item .env.example .env
corepack pnpm install
corepack pnpm dev
```

`.env` mặc định đã trỏ `NEXT_PUBLIC_API_URL=http://localhost:3001`. Mở <http://localhost:3000>, đăng nhập bằng
`SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD`.

**Kết quả đúng:** vào được **Dashboard**; bảng **Cần xử lý** ghi *Ổn định*; menu trái có Tài khoản, Chiến dịch,
Publishing. Giữ cửa sổ PowerShell này mở suốt quá trình test.

---

## D. Cài và ghép nối tiện ích Chrome

1. Chrome → gõ `chrome://extensions` → bật **Developer mode** (góc phải trên) → **Load unpacked** → chọn
   `C:\social\extension`.
   **Kết quả đúng:** thấy thẻ *VPSTTT Social Publisher 1.0.0*, không có nút *Errors* màu đỏ. Bấm biểu tượng mảnh ghép
   trên thanh Chrome → ghim (📌) tiện ích cho dễ thấy.
2. Trang quản trị → **Tài khoản** → khung *Tiện ích Chrome* → **Ghép nối Chrome** → đặt tên (ví dụ `Chrome máy tôi`)
   → **Tạo mã** → **Sao chép**. Mã dạng `spx_…` chỉ hiện **một lần**.
3. Bấm biểu tượng tiện ích → **Cài đặt**:
   - *Địa chỉ API backend*: `http://localhost:3001`
   - *Mã ghép nối*: dán mã vừa sao chép
   - **Lưu & kiểm tra** → Chrome hỏi quyền truy cập `localhost` → **Allow / Cho phép**.
   **Kết quả đúng:** dòng chữ xanh *Đã ghép nối: Chrome máy tôi. 0 bài đang chờ.*
4. Quay lại trang **Tài khoản**, bấm F5. **Kết quả đúng:** cạnh tên `Chrome máy tôi` có chấm **xanh** và chữ *đang
   chạy* (có thể chờ tối đa 30 giây).

---

## E. Test với diễn đàn giả lập

Diễn đàn giả lập có sẵn trong mã backend, mô phỏng đúng form của XenForo, Discourse và phpBB, chạy trên máy bạn nên
không ảnh hưởng ai.

### E.1 Bật diễn đàn giả lập và "đăng nhập"

PowerShell mới:

```powershell
cd C:\social\backend
node scripts\extension-e2e\fake-forum.mjs 3922 C:\social\threads.json
```

**Kết quả đúng:** in `fake forum on 3922`. Giữ cửa sổ này mở.

Trong Chrome (đúng Chrome đã cài tiện ích) mở <http://127.0.0.1:3922/login-as>. **Kết quả đúng:** trang ghi *Đã đăng
nhập demo*. Đây là bước giả lập việc bạn đã đăng nhập diễn đàn.

### E.2 Tạo 3 tài khoản diễn đàn dùng tiện ích

Lặp 3 lần theo bảng (trang **Tài khoản** → **Kết nối / cấu hình** → ô *Tìm điểm đến* gõ tên nền tảng → bấm thẻ nền
tảng → *Tên hiển thị* như bảng; nếu form có ô **Trang tạo bài** thì dán chính link ở cột *Trang tạo chủ đề* → **Lưu &
kiểm tra**):

| Nền tảng chọn | Tên hiển thị | Loại diễn đàn | Trang tạo chủ đề |
|---|---|---|---|
| DirectAdmin Forums | `Test XenForo` | XenForo | `http://127.0.0.1:3922/forums/hosting.12/post-thread` |
| NGINX Community | `Test Discourse` | Discourse | `http://127.0.0.1:3922/discourse` |
| Unraid Forums | `Test phpBB` | phpBB | `http://127.0.0.1:3922/posting.php?mode=post&f=3` |

Với NGINX Community, form có thể đòi *Discourse API key*: điền tạm bất kỳ (ví dụ `none`) và tên người dùng bất kỳ, bỏ
qua kết quả kiểm tra (tiện ích không dùng key này).

Sau khi tạo, trên dòng tài khoản bấm **Tiện ích** → bật *Đăng bằng tiện ích Chrome* → chọn *Loại diễn đàn* và dán
*Trang tạo chủ đề* theo bảng → để **Tự bấm Đăng = bật** → **Lưu**.

**Kết quả đúng:** 3 dòng có cột *Kiểu kết nối* ghi **Tiện ích Chrome · 127.0.0.1:3922 · tự bấm Đăng**, trạng thái
*Đã kết nối*.

Cấp quyền: biểu tượng tiện ích → **Cài đặt** → mục 2 hiện `○ http://127.0.0.1:3922` → **Cấp quyền diễn đàn** → **Cho
phép**. **Kết quả đúng:** dòng đó đổi thành `✓` màu xanh.

### E.3 Tình huống 1: tự động hoàn toàn (3 diễn đàn cùng lúc)

**Cách 1: có khoá AI.** **Chiến dịch** → **Tạo tự động**:
- *Mô tả bài đăng*: `[TEST] Chia sẻ 5 mẹo tối ưu VPS cho website WordPress`
- *Nhà cung cấp AI*: DeepSeek (hoặc cái bạn có)
- *Đăng tới tài khoản*: tick `Test XenForo`, `Test Discourse`, `Test phpBB`
- Chọn **chạy ngay** → bấm nút tạo.

**Cách 2: không có khoá AI.** **Nguồn nội dung** → thêm nguồn kiểu *Thủ công* với tiêu đề + nội dung bất kỳ có
`[TEST]` → **Content Studio** mở nội dung đó → **Tạo biến thể thủ công** cho từng nền tảng DirectAdmin Forums, NGINX
Community, Unraid Forums → duyệt từng biến thể → **Chiến dịch** → tạo chiến dịch chọn 3 tài khoản → **Publish**.

Theo dõi:
1. Trang **Publishing**: 3 job lần lượt *Đã lên lịch* → *Chờ tiện ích* (nhãn tím) trong ≤ 20 giây.
2. Trong ≤ 30 giây/bài, Chrome tự mở tab nền tới diễn đàn giả lập, điền rồi tự đóng tab. Biểu tượng tiện ích hiện `…`
   khi đang làm.
3. Bấm biểu tượng tiện ích: mục *Gần đây* có 3 dòng xanh *Đã đăng · …* kèm link.

**Kết quả đúng:**
- Publishing: 3 job **Đã đăng**, mỗi job có nút ↗ mở link bài (`/threads/….101/`, `/t/…/102`, `viewtopic.php?…t=103`).
- Mở <http://127.0.0.1:3922/api/threads>: thấy 3 bài với đúng tiêu đề AI viết.
- **Chiến dịch**: chiến dịch ở trạng thái *Hoàn tất*.
- Tổng thời gian từ bấm tạo đến bài thứ 3 lên: khoảng 1–2 phút (cộng thời gian AI viết bài).

### E.4 Tình huống 2: diễn đàn đòi CAPTCHA

1. **Tài khoản** → dòng `Test XenForo` → **Tiện ích** → sửa *Trang tạo chủ đề* thành
   `http://127.0.0.1:3922/forums/hosting.12/post-thread?captcha=1` → **Lưu**.
2. Tạo chiến dịch mới chỉ chọn `Test XenForo` (như E.3).

**Kết quả đúng:**
- Chrome **tự đưa tab diễn đàn lên trước**, form đã điền sẵn, có ô xám *CAPTCHA*; tiện ích **không** bấm Đăng.
- Biểu tượng tiện ích hiện số **1** màu cam. Publishing: job *Cần thao tác* với dòng *Tiện ích cần bạn* và nội dung
  "Diễn đàn đòi CAPTCHA…".
- Bạn bấm **Đăng chủ đề** trên tab đó (giả lập đã giải CAPTCHA). Trong vài giây: job **Đã đăng** kèm link; số cam trên
  biểu tượng biến mất.

Đặt lại *Trang tạo chủ đề* về bản không có `?captcha=1` sau khi xong.

### E.5 Tình huống 3: điền sẵn, chờ bạn bấm Đăng

1. Dòng `Test phpBB` → **Tiện ích** → tắt **Tự bấm Đăng** → **Lưu**. Cột *Kiểu kết nối* đổi thành *chờ bạn bấm Đăng*.
2. Tạo chiến dịch chỉ chọn `Test phpBB`.

**Kết quả đúng:** tab diễn đàn bật lên với nội dung đã điền; job *Cần thao tác · Tiện ích cần bạn* ("Kiểm tra nội dung
rồi bấm Đăng"). Sửa thử vài chữ trong ô nội dung rồi bấm **Submit** → job **Đã đăng**, bài trên
`/api/threads` mang nội dung đã sửa.

Bật lại **Tự bấm Đăng** sau khi xong.

### E.6 Tình huống 4: CAPTCHA không làm tắc các bài khác

1. Đặt lại `Test XenForo` dùng link có `?captcha=1` (như E.4).
2. Tạo một chiến dịch chọn cả `Test XenForo` và `Test Discourse`. **Chưa** bấm gì trên tab CAPTCHA.

**Kết quả đúng:** trong lúc tab XenForo đang chờ bạn, bài Discourse vẫn tự đăng xong (*Đã đăng*). Sau đó mới bấm Đăng
trên tab XenForo → job còn lại cũng *Đã đăng*.

### E.7 Tình huống 5: chưa đăng nhập diễn đàn

Cookie "đã đăng nhập" của diễn đàn giả lập chỉ gắn với `127.0.0.1`, nên đổi sang `localhost` là thành "chưa đăng nhập".

1. Dòng `Test XenForo` → **Tiện ích** → *Trang tạo chủ đề* =
   `http://localhost:3922/forums/hosting.12/post-thread` → **Lưu**. Vào **Cài đặt** tiện ích → **Cấp quyền diễn
   đàn** cho `http://localhost:3922`.
2. Tạo chiến dịch chỉ chọn `Test XenForo`.

**Kết quả đúng:**
- Tab hiện trang đăng nhập; tiện ích **không điền gì**. Publishing: job **Thất bại** với lỗi
  `EXTENSION_LOGIN_REQUIRED`; popup tiện ích: *Chưa đăng được · … Chưa đăng nhập localhost:3922…*.
- Mở `http://localhost:3922/login-as` (giả lập bạn đăng nhập) → Publishing bấm **Retry** trên job đó → xác nhận →
  job đi lại *Chờ tiện ích* → **Đã đăng**.

Đặt lại link `127.0.0.1` sau khi xong.

### E.8 Tình huống 6: Chrome tắt / tạm dừng

1. Popup tiện ích → **Tạm dừng** (biểu tượng hiện `II`). Tạo một chiến dịch chọn `Test Discourse`.
   **Kết quả đúng:** job nằm *Chờ tiện ích*, không có tab nào mở.
2. Chờ hơn 3 phút. **Kết quả đúng:** Dashboard → **Cần xử lý** có dòng *Chờ tiện ích Chrome · Chrome chưa chạy*, chuông
   có số; trang Tài khoản: chấm xám, chữ *Không có Chrome nào đang chạy*.
3. Popup → **Tiếp tục** → **Kiểm tra ngay**. **Kết quả đúng:** bài được đăng; cảnh báo biến mất sau ≤ 1 phút.

Có thể thử thêm: đóng hẳn Chrome, tạo chiến dịch, 5 phút sau mở lại Chrome → tiện ích tự chạy tiếp và đăng bài.

---

## F. Test diễn đàn thật: Voz (XenForo)

**Trước khi làm:**
- Tài khoản Voz phải đủ điều kiện tạo chủ đề (tài khoản mới có thể bị giới hạn hoặc phải chờ duyệt).
- Chọn box cho phép bài thử, hoặc chuẩn bị xoá bài ngay sau khi kiểm tra. Đọc nội quy box; không đăng quảng cáo.
- Nội dung thử phải có `[TEST]` để dễ nhận ra và xoá.

**Các bước:**
1. Trong Chrome đã cài tiện ích, đăng nhập <https://voz.vn> như bình thường.
2. Vào box muốn đăng → bấm **Đăng chủ đề** / **Post thread**. Copy địa chỉ trên thanh địa chỉ, dạng
   `https://voz.vn/f/<tên-box>.<số>/post-thread`. Đóng tab đó (không đăng tay).
3. **Tài khoản** → **Kết nối / cấu hình** → *Voz Forums* (nhóm *Tự động bằng Playwright*) → *Tên hiển thị*
   `Voz của tôi`, *Đường dẫn box VOZ* = phần đường dẫn của box, ví dụ `/f/chuyen-tro-linh-tinh.17` (bỏ
   `https://voz.vn` và `/post-thread`); để trống các ô xác nhận/tự bấm của Playwright → **Tạo & tiếp tục đăng nhập**.
   Hộp hướng dẫn đăng nhập Playwright hiện ra: **đóng lại**, không cần làm (tiện ích dùng Chrome của bạn).
4. Dòng `Voz của tôi` → **Tiện ích** → bật → *XenForo* → dán link bước 2 → **TẮT Tự bấm Đăng** cho lần đầu → **Lưu**.
5. Tiện ích → **Cài đặt** → **Cấp quyền diễn đàn** → cho phép `https://voz.vn`.
6. Tạo chiến dịch chỉ chọn `Voz của tôi`, mô tả có `[TEST]`, chạy ngay.

**Kết quả đúng:**
- Trong ≤ 1 phút tab Voz bật lên ở trang đăng chủ đề, **tiêu đề và nội dung đã điền**; job *Tiện ích cần bạn*.
- Kiểm tra nội dung → bấm **Đăng chủ đề** trên Voz → trang chuyển sang chủ đề mới `https://voz.vn/t/….<số>/` → vài giây
  sau job **Đã đăng**, nút ↗ mở đúng chủ đề đó.
- Nếu Voz hiện CAPTCHA hoặc yêu cầu chọn *prefix*: tự xử lý trên tab rồi bấm Đăng; hệ thống vẫn ghi nhận.

7. Khi lần thử với **Tự bấm Đăng tắt** đã ổn: bật **Tự bấm Đăng**, chạy chiến dịch `[TEST]` thứ hai.
   **Kết quả đúng:** tiện ích tự đăng trong tab nền, tự đóng tab, job **Đã đăng**. Xoá các chủ đề thử nếu cần.

Nếu job báo *Thất bại – Không thấy form đăng bài / Trình soạn thảo không giữ được nội dung*: chụp màn hình tab Voz và
gửi kèm tên box để chỉnh bộ chỉ dẫn ở backend (không phải cài lại tiện ích).

Các diễn đàn XenForo khác (forums.cpanel.net, forum.directadmin.com…) làm y hệt, link dạng
`https://<diễn-đàn>/forums/<box>.<số>/post-thread`.

---

## G. Diễn đàn thật loại Discourse / phpBB (tuỳ chọn)

**Discourse** (community.nginx.org, caddy.community, forums.truenas.com…):
- Tài khoản mới thường phải đạt *trust level* mới được tạo chủ đề hoặc gắn link; kiểm tra bằng cách thử tạo chủ đề tay
  trước.
- *Trang tạo chủ đề*: trang chủ diễn đàn, hoặc `https://<diễn-đàn>/new-topic?category=<slug-chuyên-mục>` (slug lấy từ
  link chuyên mục `…/c/<slug>/<số>`).
- **Kết quả đúng:** khung soạn bài Discourse bật lên ở dưới trang, đã điền; sau khi đăng, link dạng `/t/<tên>/<số>`.

**phpBB**: vào box → **New Topic** → copy link `…/posting.php?mode=post&f=<số>` → làm như F.

---

## H. Kênh API nhanh (tuỳ chọn, không cần tiện ích)

Chứng minh luồng API độc lập với tiện ích:
- **Discord**: Server test riêng → Server Settings → Integrations → Webhooks → New Webhook → Copy Webhook URL →
  **Tài khoản → Kết nối / cấu hình → Discord** → dán → **Lưu & kiểm tra** → tạo chiến dịch chọn Discord.
  **Kết quả đúng:** tin nhắn hiện trong kênh Discord, job **Đã đăng**.
- **Bluesky**: bsky.app → Settings → Privacy and security → App passwords → Add → form **Bluesky** nhập *Handle* +
  *App Password* → chiến dịch. **Kết quả đúng:** bài hiện trên profile Bluesky.

---

## I. Theo dõi và cảnh báo

- **Dashboard → Cần xử lý**: số tài khoản cần kết nối lại, bài cần thao tác, bài thất bại, bài chờ tiện ích. Chuông
  trên cùng hiện tổng số việc.
- **Popup tiện ích**: trạng thái, số bài chờ, bài đang làm, 6 kết quả gần nhất.
- **Cảnh báo qua chat (tuỳ chọn)**: đặt `ALERT_WEBHOOK_URL` trong `C:\social\backend\.env` = webhook một kênh
  Discord/Slack test → `docker compose up -d` → làm lại E.7 (thất bại do chưa đăng nhập).
  **Kết quả đúng:** trong ≤ 5 phút kênh chat nhận tin "Bài đăng cần xử lý: … FAILED (EXTENSION_LOGIN_REQUIRED)".

---

## J. Khi gặp lỗi

| Hiện tượng | Kiểm tra / cách xử lý |
|---|---|
| `docker compose up` báo cổng 3001/5432/6379 đang dùng | Tắt chương trình đang chiếm cổng hoặc đổi `PORT`, `POSTGRES_HOST_PORT`, `REDIS_HOST_PORT` trong `.env` |
| `/ready` báo `down` | `docker compose ps`; chờ container *healthy*; xem `docker compose logs api --tail 100` |
| Không đăng nhập được trang quản trị | Đúng `SEED_ADMIN_EMAIL`/`SEED_ADMIN_PASSWORD` lúc seed chưa? Sửa `.env` rồi chạy lại lệnh seed |
| Trang quản trị báo lỗi kết nối API | Backend chạy chưa (`/ready`)? `FRONTEND_URL` trong `.env` backend là `http://localhost:3000`? |
| Tiện ích: *Mã ghép nối sai hoặc đã bị thu hồi* | Tạo mã mới ở trang Tài khoản, dán lại |
| Tiện ích: *Failed to fetch* / `ERR` | Địa chỉ API đúng `http://localhost:3001` chưa? Đã cho phép quyền truy cập localhost chưa (Lưu & kiểm tra lại) |
| Job đứng mãi *Chờ tiện ích* | Popup có *Đang chạy*? Không bị *Tạm dừng*? Bấm **Kiểm tra ngay**. Tài khoản đó có bật tiện ích không? |
| Job *Thất bại – PERMISSION_REQUIRED* | Cài đặt tiện ích → **Cấp quyền diễn đàn** → Retry |
| Job *Thất bại – LOGIN_REQUIRED* | Đăng nhập diễn đàn trong đúng Chrome này → Retry |
| Job *Thất bại – EDITOR_NOT_FOUND* | Link *Trang tạo chủ đề* có mở ra đúng form không (thử mở tay)? Chọn đúng *Loại diễn đàn* chưa? Diễn đàn tuỳ biến giao diện → gửi ảnh chụp |
| Job *Tiện ích cần bạn – SUBMIT_UNCONFIRMED / RESULT_UNKNOWN* | Vào diễn đàn kiểm tra: có bài → **Đã đăng** (dán link, ID là số cuối link); chưa có → **Giao lại cho tiện ích** |
| Tạo tự động báo lỗi AI | Khoá AI sai/hết tiền; kiểm tra `DEEPSEEK_API_KEY` rồi `docker compose up -d --force-recreate api worker` |

**Xem log chi tiết:**
- Backend: `docker compose logs -f api worker` (Ctrl+C để thoát).
- Tiện ích: `chrome://extensions` → thẻ VPSTTT Social Publisher → link **service worker** → tab *Console*.
- Khi báo lỗi cho người phát triển, gửi: ảnh màn hình trang Publishing, popup tiện ích, đoạn log liên quan. **Không**
  gửi mã `spx_…`, mật khẩu, nội dung `.env`.

---

## K. Dọn dẹp sau khi test

```powershell
# Tắt diễn đàn giả lập và giao diện: Ctrl+C ở các cửa sổ PowerShell tương ứng
cd C:\social\backend
docker compose down          # giữ dữ liệu; thêm -v để xoá sạch database thử
```

Trang **Tài khoản** → thu hồi (biểu tượng thùng rác) Chrome đã ghép nối nếu không dùng tiếp; `chrome://extensions` →
gỡ tiện ích nếu muốn.

---

## Bảng nghiệm thu

| # | Mục | Đạt khi | Kết quả |
|---|---|---|---|
| 1 | Backend | `/ready` cả 4 dịch vụ `up` | ☐ |
| 2 | Giao diện | Đăng nhập, thấy Dashboard | ☐ |
| 3 | Ghép nối | Trang Tài khoản: Chrome *đang chạy* | ☐ |
| 4 | E.3 tự động | 3/3 job *Đã đăng*, chiến dịch *Hoàn tất* | ☐ |
| 5 | E.4 CAPTCHA | Dừng chờ, bấm Đăng xong tự *Đã đăng* | ☐ |
| 6 | E.5 chờ bấm | Điền sẵn, bấm xong *Đã đăng* với nội dung đã sửa | ☐ |
| 7 | E.6 không tắc | Bài Discourse lên trong lúc tab CAPTCHA chờ | ☐ |
| 8 | E.7 chưa đăng nhập | *Thất bại* đúng lý do; Retry sau khi đăng nhập thì *Đã đăng* | ☐ |
| 9 | E.8 Chrome tắt | Cảnh báo *Chrome chưa chạy*; bật lại thì đăng tiếp | ☐ |
| 10 | F Voz – chờ bấm | Điền đúng trên Voz, đăng xong có link chủ đề | ☐ |
| 11 | F Voz – tự động | Tự đăng, tự đóng tab, có link | ☐ |
| 12 | G Discourse/phpBB thật | (tuỳ chọn) | ☐ |
| 13 | H Discord/Bluesky | (tuỳ chọn) bài hiện trên kênh | ☐ |
| 14 | I Cảnh báo chat | (tuỳ chọn) nhận tin trong ≤ 5 phút | ☐ |
