# Queue, retry và idempotency

RabbitMQ exchange topic mặc định `social.publisher`; durable queue `publish.jobs` bind `publish.*`; message sai schema và publish failure đã persist `FAILED` bị dead-letter vào `publish.dead-letter` qua `social.publisher.dead`.

## State flow

```text
SCHEDULED → QUEUED → PUBLISHING → PUBLISHED
              │          ├──────→ PROCESSING
              │          ├──────→ NEEDS_ACTION
              │          ├──────→ RETRY → QUEUED
              │          └──────→ FAILED
              └─ duplicate guard → POSSIBLE_DUPLICATE
```

- Retry: 30 giây, 2 phút, 10 phút; connector có thể override bằng `Retry-After`.
- Retryable: HTTP 429, 5xx, timeout/network.
- Không retry: credential/token invalid, permission, invalid media, content rejected.
- Redis lock `lock:publish:<jobId>` có random token, TTL và Lua compare-delete.
- Rate limit `rate_limit:<platform>:<accountId>`; mặc định 10 request/60 giây, override trong account settings.
- Rabbit consumer tự reconnect và đăng ký lại consumer sau connection close.
- Lỗi connector retryable được persist `RETRY`, ACK message hiện tại, rồi scheduler enqueue lại đúng `nextAttemptAt`; không hot-loop Rabbit.
- Lỗi permanent/max-attempt được persist `FAILED`, refresh campaign rồi NACK không requeue để vào DLQ.
- Lỗi hạ tầng ngoài dự kiến được Rabbit requeue đúng một lần; redelivery vẫn lỗi sẽ vào DLQ để tránh poison-message loop.
- Scheduler mỗi 10 giây dispatch job đến hạn. Job `QUEUED` stale 15 phút được enqueue lại, nhờ vậy job vào DLQ trước khi tạo attempt không bị kẹt vô hạn. Redis lock, database idempotency và terminal-state check chặn duplicate publish khi message cũ vẫn còn trong queue.
- Job `PUBLISHING` stale 15 phút chuyển `NEEDS_ACTION` với mã `WORKER_CRASH_UNCERTAIN_RESULT` thay vì retry mù, vì provider có thể đã nhận request trước khi worker dừng. UI yêu cầu đối soát topic/moderation queue; chỉ xác nhận “không tìm thấy” mới xếp hàng lại cùng job.
- Mỗi vòng scheduler reconcile campaign `SCHEDULED`/`RUNNING` khi toàn bộ job đã terminal; manual confirmation và crash recovery vì vậy không để campaign kẹt sai trạng thái.
- Scheduler chỉ dispatch job thuộc campaign `SCHEDULED` hoặc `RUNNING`; campaign `DRAFT` không thể tự publish.

Scale worker:

```bash
docker compose up -d --scale worker=4
```

Theo dõi DLQ trong RabbitMQ Management; không requeue hàng loạt trước khi sửa nguyên nhân.
