# Kết nối chat VPSTTT

auto-social nói chuyện với chat VPSTTT (repo `chat-vpsttt-project`) qua bot API của chat. Hai mức:

- **Mức 1 — thông báo:** báo vào kênh chung "Auto Social" khi bài đăng lỗi / cần thao tác, tài khoản cần kết nối lại
  hoặc token sắp hết hạn, chiến dịch xong.
- **Mức 2 — duyệt bài:** mỗi bài AI viết xong thành một yêu cầu duyệt gửi riêng cho chủ chiến dịch (khớp theo email).
  Duyệt / từ chối trong chat (web hoặc app) có hiệu lực như bấm trên trang "Content đợi duyệt".

Mặc định **tắt**. Mã: `src/chat-integration/`. Bảng: `ChatOutboxEvent`, `ChatApprovalLink` (xem [DATABASE.md](DATABASE.md)).

## Luồng

```text
Duyệt / từ chối / khôi phục / xoá trên web ─┐
AI viết xong từng bài (và lúc kết thúc lượt) ┼─> ghi sổ ChatOutboxEvent ──cron 10 giây, khoá Redis──> bot API của chat
Cron 1 phút quét trạng thái (mức 1, /result) ┘
Chat ──webhook approval.* có chữ ký──> POST /api/v1/integrations/chat/events ──> CampaignAutomationService.approveVariant / rejectVariant
```

- Các điểm móc trong luồng duyệt chỉ **ghi sổ**, tự bắt lỗi; chat hỏng không làm hỏng duyệt, từ chối hay lượt chạy AI.
- Mỗi việc có một khoá chống trùng (`dedupeKey` unique), nên gọi lại / quét lại bao nhiêu lần cũng chỉ gửi một lần.

### Việc gửi sang chat

| Việc | Khi nào | Gọi | Khoá chống trùng |
|---|---|---|---|
| Tạo yêu cầu duyệt | bài sẵn sàng duyệt (đã có ảnh, AI không đang viết lại), lượt duyệt thứ `c` | `POST /api/v1/bot/approvals`, `channel_id = null`, `approver_rule.emails = [email chủ]`, hết hạn 7 ngày, kèm `display` (chữ bài, ảnh, kênh, tài khoản, giờ đăng, AI duyệt, liên kết) | `variant:<id>:c<c>` |
| Huỷ yêu cầu | bài được duyệt / từ chối / khôi phục trên web, hoặc chiến dịch bị xoá | `POST …/approvals/:id/cancel`, lý do "Đã xử lý ở auto-social" | `cancel:<approvalId>` |
| Báo kết quả đăng | mọi job của bài đã duyệt trong chat kết thúc | `POST …/approvals/:id/result`: `executed` + `label: "Đã đăng"` nếu đăng được ít nhất một tài khoản (kèm số bài / link); không thì `failed` + `label: "Đăng lỗi"` | `result:<approvalId>` |
| Đăng lỗi / cần thao tác | `PublishJob` `FAILED` / `NEEDS_ACTION` (trong 1 giờ gần nhất, trừ bài đang chờ tiện ích Chrome) | tin thẻ v2 vào kênh "Auto Social" | `job:<id>:<status>` |
| Tài khoản | `RECONNECT_REQUIRED` (trong 24 giờ gần nhất); token không tự gia hạn được, hết hạn trong 7 ngày | như trên | `account:<id>:RECONNECT_REQUIRED:<ngày vào trạng thái>`, `account:<id>:EXPIRING:<ngày hết hạn>` |
| Chiến dịch xong | `COMPLETED` / `PARTIAL` (trong 24 giờ gần nhất), "Đăng được X/Y bài" | như trên | `campaign:<id>:done` |
| Chưa khớp tài khoản | chat trả 422 `APPROVER_NOT_FOUND` | thẻ cảnh báo vào kênh | `unmatched:<email>:<ngày>` |

- Lượt duyệt `c`: bài bị từ chối rồi được khôi phục, hoặc yêu cầu cũ đã đóng, thì lần sẵn sàng sau là lượt `c+1`.
- Thân yêu cầu duyệt và mã băm của thứ người duyệt thấy (chữ, tiêu đề, hashtag, ảnh hiện ra và mọi ảnh của bài, tài
  khoản sẽ đăng, giờ hẹn) được tính và lưu vào `ChatApprovalLink` **trước** lần gọi đầu; mọi lần gửi lại dùng đúng thân
  đã lưu. Chat trả yêu cầu cũ (200, trùng `external_key`) mà `display.text` khác chữ đã lưu thì yêu cầu đó bị huỷ và
  mở lượt mới.
- Huỷ yêu cầu: chat trả 409 `APPROVAL_NOT_PENDING` (đã kết thúc) hoặc 404 thì coi là xong, ghi log, không thử lại.
- Bộ gửi: khoá Redis 5 phút, gia hạn trước mỗi việc; một lượt không bắt đầu việc mới sau 2 phút; mỗi việc được
  "giữ chỗ" 3 phút trong cơ sở dữ liệu trước khi gọi, nên hai bộ gửi không gửi cùng một việc.
- Thử lại: 30 giây, 2 phút, 10 phút, 1 giờ, 1 giờ; lần thứ 6 vẫn lỗi thì dừng (`FAILED`, ghi lỗi). 429 thì chờ đúng
  `Retry-After`, không tính là một lần thử, và dừng cả lượt gửi đó. 400 / 404 / 409 / 422 không thử lại.
- Công tắc tắt: không gửi gì; việc mới vẫn ghi sổ nhưng đánh dấu `SKIPPED`, việc đang chờ cũng chuyển `SKIPPED`. Chưa từng
  lưu cấu hình thì không ghi gì.
- Ngày trong khoá chống trùng tính theo giờ Việt Nam. Liên kết trong tin lấy từ địa chỉ đầu tiên của `FRONTEND_URL`, chỉ
  khi là https; liên kết nằm trong thân tin (nút `open` của chat chỉ nhận `webtui://`).

### Nhận kết quả duyệt

`POST /api/v1/integrations/chat/events`, công khai, guard riêng kiểm theo thứ tự:

1. Thân ≤ 256 KB (đọc nguyên byte riêng cho đường này; các đường khác vẫn dùng bộ đọc JSON chung).
2. `X-WebTui-Timestamp` lệch giờ máy ≤ 300 giây.
3. `X-WebTui-Signature` hoặc `X-WebTui-Signature-Previous` = `sha256=` + hex `HMAC-SHA256(khoá, "<timestamp>.<thân gốc>")`,
   so thời gian hằng với khoá đang dùng và khoá cũ.
   Khoá cũ chỉ được nhận trong 24 giờ kể từ lúc đổi khoá (thời hạn hiện trên trang cài đặt).
4. Kết nối đang tắt: 503, chưa ghi nhớ mã sự kiện, để chat gửi lại sau.
5. `event_id` trong thân (đã được ký; phải trùng `X-WebTui-Event-ID` nếu có) chưa gặp trong 24 giờ (Redis `SET NX`).

Sai chữ ký / quá giờ: 401. Sự kiện lặp: 200, bỏ qua. Xử lý lỗi bất ngờ: 500 và quên mã sự kiện để chat gửi lại.

Chỉ xử lý yêu cầu của chính mình: `payload.action` = `auto_social.publish_variant`, `resource_id` = mã bài của liên kết,
`approval_id` trùng mã đã lưu. Liên kết chưa lưu mã (webhook tới trước khi bộ gửi lưu) thì hỏi lại chat bằng
`GET /api/v1/bot/approvals/:id` với khoá bot của mình (yêu cầu của bot khác trả 404) và so `external_key`; không khớp thì
bỏ và ghi audit `CHAT_APPROVAL_IGNORED`.

| Sự kiện | Xử lý |
|---|---|
| `approval.decided` + `approved` | Lấy quyết định `approve` cuối → user theo email (không phân biệt hoa thường). Bắt buộc: tài khoản bật, vai trò ADMIN / EDITOR, là chủ chiến dịch. Bài phải còn đúng như lúc gửi duyệt (chữ, ảnh, tài khoản, giờ hẹn; kiểm trong giao dịch đã khoá của lần duyệt; liên kết thiếu mã băm thì từ chối). Khác thì báo `failed` và gửi yêu cầu lượt mới. Duyệt đã ghi xong mà bước sau lỗi thì giữ trạng thái đã duyệt và để phần báo kết quả gửi `/result`. Gọi `approveVariant` như trang web: `SCHEDULED` theo giờ hẹn của chiến dịch nếu còn ở tương lai, không thì `NOW`. Không duyệt được (bài quá dài, ảnh chưa xong, hết tài khoản…) thì báo `/result failed` bằng lời tiếng Việt. |
| `approval.decided` + `rejected` | Cùng các kiểm như trên; gọi `rejectVariant`, `note` lưu làm lý do trong audit. |
| `approval.decided` + `expired` | Chỉ đánh dấu liên kết hết hạn; bài vẫn chờ ở auto-social. |
| `approval.cancelled` | Đánh dấu liên kết đã huỷ. |
| `approval.executed`, loại khác | Bỏ qua. |

Người quyết định không hợp lệ: bỏ, ghi audit `CHAT_APPROVAL_IGNORED` (lý do `NOT_OWNER`, `ROLE_NOT_ALLOWED`,
`USER_DISABLED`, `UNKNOWN_USER`), báo `/result failed` "Người duyệt không hợp lệ". Quyết định hợp lệ ghi audit
`CAMPAIGN_AI_APPROVED` / `CAMPAIGN_AI_REJECTED` với `trigger: chat`, `source: chat`, `approvalId`.

## Cấu hình (chỉ ADMIN)

- `GET /api/v1/settings/chat-integration`: cấu hình đã che khoá, số việc đang chờ / đã dừng, lần gửi gần nhất.
- `PUT /api/v1/settings/chat-integration`: lưu (`revision` lấy từ GET; khoá để trống thì giữ khoá cũ). Đổi khoá webhook
  thì khoá đang dùng tự thành khoá cũ, để chat ký bằng khoá nào trong lúc đổi cũng được nhận.
- `POST /api/v1/settings/chat-integration/test`: gửi ngay một tin thử vào kênh, trả `{ok, error}` (tối đa 10 lần/phút).
- Giao diện: **Cài đặt → Kết nối chat**.

Không có biến môi trường mới: mọi giá trị nằm mã hoá trong `SystemSetting` `integration.chat`.

## Hướng dẫn quản trị

Làm theo thứ tự. Không gửi khoá qua chat / email; nhập thẳng vào ô.

### Bên chat (quản trị workspace nội bộ)

1. Tạo bot "Auto Social" trong workspace của nhân viên VPSTTT.
2. Tạo khoá bot (`wtb_…`) có scope `message.write` và `approval.write`. Chép khoá một lần.
3. Tạo kênh "Auto Social", cài bot vào kênh, mời người cần nhận thông báo. Lấy mã kênh (UUID).
4. Tạo webhook đi của workspace:
   - địa chỉ: `https://<địa chỉ API auto-social>/api/v1/integrations/chat/events`;
   - chọn đủ ba sự kiện `approval.decided`, `approval.cancelled`, `approval.executed` (bộ lọc so đúng tên sự kiện, không
     nhận dạng `approval.*`);
   - chép khoá ký (secret) của webhook.
5. Kiểm mỗi chủ chiến dịch có tài khoản chat **đang hoạt động** cùng email với tài khoản auto-social. Ai chưa có thì kênh
   "Auto Social" nhận thẻ "Chưa khớp tài khoản chat" và người đó duyệt trên auto-social như cũ.

### Bên auto-social (ADMIN)

1. Vào **Cài đặt → Kết nối chat**.
2. Nhập địa chỉ chat (https), khoá bot, mã kênh "Auto Social", khoá webhook. Lưu.
3. Bấm **Gửi tin thử**: kênh "Auto Social" phải nhận thẻ "Tin thử từ auto-social". Lỗi thì sửa theo lời báo
   (khoá sai / thiếu scope / bot chưa vào kênh / địa chỉ bị chặn).
4. Bật công tắc **Bật kết nối** rồi lưu.
5. Theo dõi "Lần gửi gần nhất" và số việc đã dừng trên cùng khối.

### Đổi khoá

- Khoá bot: tạo khoá mới bên chat, nhập vào auto-social, lưu, rồi thu hồi khoá cũ bên chat.
- Khoá webhook: nhập khoá mới vào auto-social trước (khoá cũ tự được giữ và còn nhận trong 24 giờ), rồi xoay khoá bên
  chat trong 24 giờ đó. Hết hạn thì khoá cũ tự thôi được nhận; bấm "Quên khoá cũ" để bỏ sớm.

## Giới hạn đã biết

- Thông báo mức 1 chỉ quét sự việc gần đây (job: 1 giờ, tài khoản / chiến dịch: 24 giờ); bật kết nối sau thời gian đó
  thì sự việc cũ không được báo.
- Yêu cầu duyệt chỉ tạo cho lượt chạy AI chạy nền ("Content đợi duyệt"); bài chờ duyệt của luồng tạo tức thì
  (`NEEDS_ACTION` / `CONTENT_REVIEW_REQUIRED`) chỉ có thông báo mức 1.
- Sửa chữ / ảnh bài trên web sau khi đã gửi duyệt không tự cập nhật thẻ bên chat; lúc duyệt trong chat sẽ bị chặn và
  một yêu cầu lượt mới được gửi.
- Chat phải được gọi bằng địa chỉ công khai https: lớp gọi ra ngoài chặn IP nội bộ / riêng.
