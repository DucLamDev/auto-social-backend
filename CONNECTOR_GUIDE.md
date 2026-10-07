# Connector Guide

Mục tiêu của adapter là thêm platform mà không sửa campaign/worker core.

## Contract

Implement `SocialPublisher` trong `src/connectors/<slug>/`:

```ts
export interface SocialPublisher {
  readonly platform: string;
  readonly mode: PlatformMode;
  readonly capability: ConnectorCapability;
  validate(post: PostPayload): Promise<void>;
  publish(account: ConnectorAccount, post: PostPayload): Promise<PublishResult>;
  testConnection?(account: ConnectorAccount): Promise<ConnectionTestResult>;
  getStatus?(account: ConnectorAccount, publishId: string): Promise<PublishStatus>;
  delete?(account: ConnectorAccount, publishId: string): Promise<void>;
  refreshToken?(account: ConnectorAccount): Promise<void>;
}
```

## Thêm platform

1. Nghiên cứu **official docs hiện tại**: auth, scope, endpoint, rate limit, app review, restriction. Lưu link nguồn trong seed/docs. Nếu chưa xác minh, dùng `API_RESEARCH_REQUIRED`; không đoán endpoint.
2. Tạo `src/connectors/example/example.connector.ts`, kế thừa `HttpConnectorBase` nếu gọi HTTP.
3. Khai báo capability đúng phần đã chạy thật. Nếu code chưa upload media thì `image/video=false`; frontend dựa trực tiếp vào giá trị này.
4. Validate payload trước network call. Map 401/403/429/5xx bằng `ConnectorError`; không đưa raw token/body nhạy cảm vào log.
5. Dùng `account.externalId/settings/credentials`, không hard-code account/platform ID. Một class phục vụ N account.
6. Đăng ký provider trong `ConnectorsBootstrapService` và module.
7. Thêm/upsert Platform + PlatformCapability + prompt trong `prisma/seed.ts`.
8. Nếu OAuth: thêm provider definition chỉ sau khi xác minh endpoint; state phải one-time/provider-bound/expiring; token phải đi qua `CredentialsService`.
9. Viết unit mock cho success, 401, 403, 429, 500, timeout; kiểm tra idempotency và URL trả về.
10. Chạy `pnpm lint && pnpm typecheck && pnpm test && pnpm build && pnpm openapi:export`.
11. Chạy integration test với sandbox/test account. Chỉ đổi availability thành `READY` khi Definition of Done được chứng minh.

## Mode

- `OFFICIAL_API`: endpoint/vendor docs chính thức.
- `COMPATIBLE_API`: API engine chuẩn như Mastodon/Forem trên site khác.
- `BROWSER_ASSISTED`: chỉ hỗ trợ hành động người dùng hợp lệ; không bypass CAPTCHA/2FA/anti-bot.
- `MANUAL`: AI sinh nội dung; job thành `NEEDS_ACTION`; UI copy/open/mark-published.

Forum dùng connector theo engine (`Discourse`, `XenForo`, `Forem`, `ActivityPub`), còn site URL/category/forum ID nằm trong account settings.
