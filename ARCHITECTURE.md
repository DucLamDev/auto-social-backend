# Architecture

## Ranh giới process

API (`src/main.ts`) xử lý HTTP, validation, auth và transaction tạo business record. Worker (`src/worker.ts`) là Nest standalone process tiêu thụ RabbitMQ. Có thể scale worker ngang; không tạo process riêng cho từng social account.

```text
Browser ─REST─> API ─Prisma─> PostgreSQL
                  ├────────> Redis (lock/rate limit)
                  ├────────> RabbitMQ ──> Worker(s) ──> Connector ──> Platform
                  ├────────> OpenAI Responses API
                  └────────> S3/MinIO
```

## Nguyên tắc dependency

- Controller chỉ chuyển request/response; service giữ business rule; Prisma chỉ được gọi từ service/data boundary.
- `PublishingService` resolve adapter bằng `ConnectorRegistryService`; core không import connector Instagram/X/etc.
- Credential chỉ được giải mã trong backend, sát thời điểm test/publish. DTO response dùng select an toàn.
- Scheduler không publish trực tiếp. Nó claim row atomically rồi enqueue.
- Queue là at-least-once; uniqueness trong PostgreSQL, Redis lock và platform idempotency (khi API hỗ trợ) cùng giảm duplicate.
- Nếu worker chết sau khi platform có thể đã nhận request nhưng trước khi lưu response, job cũ `PUBLISHING` chuyển `NEEDS_ACTION` với mã đối soát. Redelivery không gọi provider; người vận hành phải xác minh trước khi dùng action gửi lại chính job.

## API contract

Business API dùng prefix `/api/v1`. Response thành công:

```json
{"success":true,"data":{},"meta":{"requestId":"...","timestamp":"..."}}
```

Error production không lộ stack/internal exception:

```json
{"success":false,"error":{"code":"PLATFORM_RATE_LIMITED","message":"..."},"meta":{}}
```

Backend export `openapi.json`; frontend không tự viết lại DTO.

## Scale

- `platform_accounts` giữ N account trên một connector class.
- Queue routing `publish.<platform>` và prefetch/concurrency có thể tăng theo worker replica.
- Redis key tách theo `platform + account`; không có global rate bucket gây nghẽn 1000 destination.
- Query scheduler claim bằng conditional update nên nhiều API replica không enqueue cùng job.
