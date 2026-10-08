# Triển khai Social Publisher lên VPS

> Runbook cho Ubuntu LTS + Docker Compose, cập nhật 2026-10-08. Backend production dùng `docker-compose.prod.yml` với các service `api`, `worker`, `postgres`, `redis`, `rabbitmq`, `minio`, `minio-init`. Luôn deploy đúng release/tag đã kiểm thử vì file Compose và schema có thể thay đổi ở release sau.

Các file Compose đã được kiểm tra cấu hình tĩnh; image backend và frontend cũng đã build/chạy kiểm tra cục bộ. Backend đã được xác nhận có Prisma target `debian-openssl-3.0.x`, TSX và FFmpeg ngay cả khi container không có mạng; frontend trả `/api/health` ở trạng thái Docker `healthy`. Production Compose với PostgreSQL, Redis, RabbitMQ, MinIO, API và hai worker đã qua smoke test cô lập: migrate, seed, readiness, login và luồng campaign thủ công `NEEDS_ACTION → PUBLISHED → COMPLETED` đều đạt. Credential thật và sandbox của từng nhà cung cấp vẫn là quality gate bắt buộc trên VPS staging trước khi nhận traffic production.

## 1. Kiến trúc production

```text
Internet
   |
   +-- app.example.com:443 ---- Caddy ---- 127.0.0.1:3000 (Next.js)
   |
   +-- api.example.com:443 ---- Caddy ---- 127.0.0.1:3001 (NestJS API)
                                                   |
                         Docker private network ---+--- worker
                                                   +--- PostgreSQL
                                                   +--- Redis
                                                   +--- RabbitMQ
                                                   +--- MinIO/S3

Provider OAuth callback ---------------------------> api.example.com
Provider media pull -------------------------------> public HTTPS object/route
```

Frontend và backend là hai repository/build độc lập. Chỉ API/reverse proxy được phép chạm vào dịch vụ nội bộ; PostgreSQL, Redis, RabbitMQ và MinIO Console không mở ra Internet.

## 2. Tài nguyên và DNS

Khởi điểm hợp lý cho production nhỏ/trung bình:

- Tối thiểu để thử tải: 4 vCPU, 8 GB RAM, SSD 80 GB.
- Khuyến nghị cho API + worker + database + RabbitMQ + Redis + MinIO cùng một VPS: 8 vCPU, 16 GB RAM, SSD 150 GB trở lên.
- Nếu xử lý nhiều video/FFmpeg hoặc crawl song song, tách worker/object storage và tăng CPU/disk IOPS. Các con số trên là baseline vận hành, không phải cam kết cho 150/500/1.000 destinations; benchmark bằng workload thật rồi scale worker ngang.

Tạo DNS `A/AAAA`:

- `app.example.com` → IP VPS.
- `api.example.com` → IP VPS.
- `media.example.com` → object storage/CDN hoặc public media gateway đã triển khai. Không trỏ hostname này vào MinIO Console.

Chờ DNS resolve đúng trước khi xin TLS. OAuth review nên dùng domain production ổn định; đổi domain/callback sau review thường buộc cập nhật mọi provider.

## 3. Hardening VPS

1. Cài Ubuntu LTS còn được Docker hỗ trợ, cập nhật security packages và bật đồng bộ thời gian.
2. Tạo user deploy riêng, dùng SSH key. Chỉ tắt password/root SSH **sau khi** đã mở một phiên SSH mới và xác minh key hoạt động.
3. Chỉ mở TCP 22 (hoặc SSH port riêng), 80, 443. Giới hạn SSH theo IP/VPN nếu có thể.
4. Không publish `5432`, `6379`, `5672`, `15672`, `9000`, `9001` trên `0.0.0.0`.
5. Docker-published ports có thể đi vòng một số rule UFW. Ngoài firewall, Compose phải bind web ports vào `127.0.0.1` và để infra chỉ ở Docker network; xem cảnh báo firewall trong tài liệu Docker.
6. Cấu hình log rotation và cảnh báo disk. Docker `json-file` mặc định có thể làm đầy ổ đĩa nếu không giới hạn.
7. Backend có Redis throttle cho auth: login theo IP `100/15 phút` và theo normalized-email hash `10/15 phút`; refresh theo IP `180/15 phút`. Trước public exposure vẫn đặt bot/rate protection ở CDN/WAF/ingress và alert credential-stuffing để có lớp phòng thủ phân tán. Caddy core không tự cung cấp rate-limit nếu không có module.

Ví dụ firewall cơ bản (đổi SSH rule trước nếu server không dùng profile `OpenSSH`):

```bash
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
sudo ufw status verbose
```

## 4. Cài Docker Engine và Compose plugin

Dùng repository APT chính thức, không dùng convenience script cho production:

```bash
sudo apt update
sudo apt install -y ca-certificates curl git
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
```

```bash
sudo tee /etc/apt/sources.list.d/docker.sources >/dev/null <<EOF
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: $(. /etc/os-release && echo "${UBUNTU_CODENAME:-$VERSION_CODENAME}")
Components: stable
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/docker.asc
EOF
```

```bash
sudo apt update
sudo apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo systemctl enable --now docker containerd
sudo docker version
sudo docker compose version
```

Thành viên group `docker` có quyền gần tương đương root. Có thể tiếp tục dùng `sudo docker ...`; nếu thêm deploy user vào group, coi đó là cấp quyền root-level và bảo vệ tài khoản tương ứng.

Trước khi tạo container, kiểm tra `/etc/docker/daemon.json`. Nếu chưa có logging policy, merge cấu hình sau bằng `sudoedit` (không overwrite các key daemon hiện hữu), validate JSON rồi restart Docker:

```json
{
  "log-driver": "local"
}
```

```bash
sudo systemctl restart docker
sudo docker info --format '{{.LoggingDriver}}'
```

Driver `local` tự rotate và tránh `json-file` mặc định tăng không giới hạn. Thay đổi default chỉ áp dụng cho container tạo lại sau đó.

Nguồn: [Docker Engine on Ubuntu](https://docs.docker.com/engine/install/ubuntu/), [Linux post-installation/security note](https://docs.docker.com/engine/install/linux-postinstall/), [Compose in production](https://docs.docker.com/compose/how-tos/production/), [Docker logging drivers](https://docs.docker.com/engine/logging/configure/).

## 5. Tạo thư mục và lấy đúng release

Hai repository vẫn độc lập:

```bash
sudo install -d -m 0750 -o deploy -g deploy /opt/social-publisher
cd /opt/social-publisher
git clone <BACKEND_GIT_URL> social-publisher-backend
git clone <FRONTEND_GIT_URL> social-publisher-frontend
```

Deploy bằng release tag hoặc commit SHA đã qua CI; không chạy production lâu dài từ nhánh đang thay đổi và không dùng Docker tag `latest` làm rollback reference.

```bash
cd /opt/social-publisher/social-publisher-backend
git fetch --tags --prune
git checkout <BACKEND_RELEASE_TAG_OR_SHA>

cd /opt/social-publisher/social-publisher-frontend
git fetch --tags --prune
git checkout <FRONTEND_RELEASE_TAG_OR_SHA>
```

## 6. Secret và `.env` backend

Tạo từ template rồi giới hạn permission:

```bash
cd /opt/social-publisher/social-publisher-backend
cp .env.example .env
chmod 600 .env
```

Sinh secret trong phiên quản trị an toàn, copy thẳng vào secret manager/file quyền 600 và xóa terminal scrollback nếu quy trình của tổ chức yêu cầu:

```bash
openssl rand -base64 48   # JWT_ACCESS_SECRET
openssl rand -base64 48   # JWT_REFRESH_SECRET
openssl rand -base64 32   # CREDENTIAL_ENCRYPTION_KEY: đúng 32 byte trước khi base64
openssl rand -hex 32      # chạy riêng cho từng password DB/Redis/RabbitMQ/MinIO
```

Production Compose đọc trực tiếp `env_file: .env`, vì vậy không đổi file thành `.env.production` nếu chưa sửa Compose. Dùng chuỗi hex/alphanumeric cho password được nhúng vào PostgreSQL/Redis/AMQP URL; ký tự URI như `@`, `:`, `/`, `#` phải được percent-encode đúng, nếu không URL kết nối sẽ hỏng.

Các key hiện có trong `.env.example`:

| Nhóm | Key | Cấu hình production |
|---|---|---|
| Runtime | `NODE_ENV` | `production` |
| Runtime | `PORT` | `3001` trong container/process API |
| Runtime | `FRONTEND_URL` | `https://app.example.com`; dùng cho CORS/redirect |
| Runtime | `TRUST_PROXY` | `true` khi API đứng sau Caddy; chỉ tin proxy do mình quản lý |
| Runtime | `LOG_LEVEL` | `info` hoặc mức phù hợp; không bật debug chứa payload nhạy cảm |
| Database | `DATABASE_URL` | URL PostgreSQL nội bộ; URL-encode ký tự đặc biệt trong password |
| Infra | `REDIS_URL` | Host service nội bộ, không public |
| Infra | `RABBITMQ_URL` | User/password riêng, host service nội bộ |
| Infra | `RABBITMQ_EXCHANGE` | Giữ đồng nhất API/worker, mặc định template `social.publisher` |
| Infra | `RABBITMQ_PREFETCH` | Số message chưa ACK tối đa trên mỗi consumer; đây là nút điều chỉnh concurrency trong từng worker. Bắt đầu thấp, benchmark rồi mới tăng |
| Auth | `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET` | Hai random secret khác nhau, tối thiểu như validator yêu cầu |
| Auth | `JWT_ACCESS_TTL`, `JWT_REFRESH_TTL` | Baseline template `15m`/`30d`; cân nhắc chính sách phiên |
| Encryption | `CREDENTIAL_ENCRYPTION_KEY` | Base64 của đúng 32 random bytes |
| Encryption | `CREDENTIAL_ENCRYPTION_KEY_VERSION` | Bắt đầu `v1`; dùng cho migration/rotation |
| AI | `OPENAI_API_KEY`, `OPENAI_MODEL`, `OPENAI_TIMEOUT_MS` | Server-side only; model phải được account cấp quyền |
| Storage | `S3_ENDPOINT`, `S3_REGION`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_BUCKET`, `S3_FORCE_PATH_STYLE` | MinIO nội bộ hoặc S3-compatible production; user/bucket riêng |
| Storage | `S3_PUBLIC_URL` | Public HTTPS origin **đã gồm bucket/prefix**, ví dụ `https://media.example.com/social-publisher`; provider phải tải được từ Internet |
| OAuth future | `META_APP_ID`, `META_APP_SECRET`, `META_GRAPH_API_VERSION` | Placeholder cho OAuth Meta tương lai; source release hiện **không đọc** các key này, điền giá trị không bật được Instagram/Threads OAuth |
| OAuth | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Blogger OAuth |
| OAuth | `LINKEDIN_CLIENT_ID`, `LINKEDIN_CLIENT_SECRET` | LinkedIn OAuth |
| OAuth | `LINKEDIN_API_VERSION` | Bắt buộc khi bật LinkedIn OAuth; version Posts API còn hỗ trợ dạng `YYYYMM`, backend lưu vào account khi callback |
| OAuth future | `X_CLIENT_ID`, `X_CLIENT_SECRET` | Placeholder; source hiện không đọc và không có X OAuth route |
| OAuth future | `REDDIT_CLIENT_ID`, `REDDIT_CLIENT_SECRET` | Placeholder; source hiện không đọc, Reddit vẫn là manual cho đến khi được duyệt và implement |
| OAuth future | `TIKTOK_CLIENT_KEY`, `TIKTOK_CLIENT_SECRET` | Placeholder; source hiện không đọc, TikTok vẫn là manual/review-required |
| OAuth | `OAUTH_REDIRECT_BASE_URL` | `https://api.example.com/api/v1/oauth`; callback hiện có là `/linkedin/callback` và `/google/callback` |
| Seed | `SEED_ADMIN_EMAIL`, `SEED_ADMIN_PASSWORD` | Chỉ dùng bootstrap; đặt password production random mạnh **trước lần seed đầu tiên** |

`WORKER_CONCURRENCY` không phải biến runtime của source hiện tại; tự thêm key này sẽ không có tác dụng. Điều chỉnh lượng việc đồng thời bằng `RABBITMQ_PREFETCH` và số replica của service `worker` (production Compose hiện đặt `deploy.replicas: 2`).

Tương tự, `META_*`, `X_CLIENT_*`, `REDDIT_*` và `TIKTOK_*` trong template chỉ giữ chỗ cho milestone sau. Không cần điền chúng cho release hiện tại và tuyệt đối không coi việc điền key là đã có OAuth/publish automation; chỉ LinkedIn và Google/Blogger có consumer + OAuth route trong source.

`docker-compose.prod.yml` dùng thêm nhóm biến điều phối sau; template `.env.example` hiện đã liệt kê chúng để không bị thiếu khi deploy:

| Key Compose | Ví dụ/ý nghĩa |
|---|---|
| `BACKEND_IMAGE` | Image vừa build, ví dụ `social-publisher-backend:2026.10.08`; không dùng `latest` làm mốc rollback |
| `POSTGRES_DB`, `POSTGRES_USER`, `POSTGRES_PASSWORD` | Database và credential riêng; mặc định DB là `social_publisher` |
| `REDIS_PASSWORD` | Password Redis production |
| `RABBITMQ_USER`, `RABBITMQ_PASSWORD` | Credential RabbitMQ production |
| `MINIO_ROOT_USER`, `MINIO_ROOT_PASSWORD` | Bootstrap MinIO; giữ kín và cân nhắc user ít quyền hơn khi tách object storage |

Compose production tự override `DATABASE_URL`, `REDIS_URL`, `RABBITMQ_URL`, `S3_ENDPOINT`, `S3_ACCESS_KEY` và `S3_SECRET_KEY` trong container từ các biến trên. Đừng để hai nhóm giá trị mâu thuẫn rồi debug nhầm file.

Ví dụ giá trị topology nội bộ (tên database/user/password phải khớp Compose production):

```dotenv
NODE_ENV=production
PORT=3001
BACKEND_IMAGE=social-publisher-backend:2026.10.08
FRONTEND_URL=https://app.example.com
TRUST_PROXY=true
LOG_LEVEL=info
POSTGRES_DB=social_publisher
POSTGRES_USER=social_publisher
POSTGRES_PASSWORD=<UNIQUE_HEX_PASSWORD>
REDIS_PASSWORD=<UNIQUE_HEX_PASSWORD>
RABBITMQ_USER=social_publisher
RABBITMQ_PASSWORD=<UNIQUE_HEX_PASSWORD>
MINIO_ROOT_USER=<UNIQUE_MINIO_USER>
MINIO_ROOT_PASSWORD=<UNIQUE_HEX_PASSWORD>
S3_ENDPOINT=http://minio:9000
S3_PUBLIC_URL=https://media.example.com/social-publisher
S3_REGION=us-east-1
S3_BUCKET=social-publisher
S3_FORCE_PATH_STYLE=true
OAUTH_REDIRECT_BASE_URL=https://api.example.com/api/v1/oauth
LINKEDIN_API_VERSION=<SUPPORTED_YYYYMM>
```

Giữ `PORT=3001` với Compose hiện tại: container và healthcheck đều nghe cổng 3001, còn host chỉ bind `127.0.0.1:3001`. Không copy literal `<...>` vào file thật.

### Cảnh báo đặc biệt về encryption key

`CREDENTIAL_ENCRYPTION_KEY` là chìa khóa giải mã toàn bộ social credential. Mất key đồng nghĩa token trong database không thể dùng; thay key trực tiếp đồng nghĩa account cũ hỏng. Backup key tách biệt, mã hóa và kiểm soát truy cập. Rotation phải có quy trình decrypt bằng key cũ → encrypt bằng key mới → cập nhật version; không chỉ sửa env rồi restart.

## 7. `.env` frontend

```bash
cd /opt/social-publisher/social-publisher-frontend
cp .env.example .env
chmod 600 .env
```

```dotenv
NEXT_PUBLIC_API_URL=https://api.example.com
NEXT_PUBLIC_APP_NAME=Social Publisher
NEXT_PUBLIC_POLL_INTERVAL_MS=10000
```

Biến `NEXT_PUBLIC_*` được đóng vào JavaScript client lúc `next build`. Thay API URL thì phải rebuild frontend. Tuyệt đối không đặt database password, OpenAI key, app secret, access token hay webhook URL ở frontend env.

## 8. Build, migrate và khởi động

Backend dev dùng `docker-compose.yml` và cố ý publish các cổng hạ tầng; **không dùng file đó trên VPS production**. Build image rồi validate đúng `docker-compose.prod.yml`:

```bash
cd /opt/social-publisher/social-publisher-backend
sudo docker build --pull -t social-publisher-backend:2026.10.08 .
sudo docker compose -f docker-compose.prod.yml --env-file .env config --quiet
```

Tag build phải trùng `BACKEND_IMAGE` trong `.env`. Production Compose chỉ tham chiếu image, không có `build:`. Không in `docker compose config` đầy đủ vào log CI vì output có thể chứa secret. Khởi động dependency trước:

```bash
sudo docker compose -f docker-compose.prod.yml --env-file .env up -d postgres redis rabbitmq minio minio-init
sudo docker compose -f docker-compose.prod.yml --env-file .env ps
sudo docker compose -f docker-compose.prod.yml --env-file .env run --rm api corepack pnpm prisma:deploy
```

Seed chỉ chạy lần bootstrap và chỉ sau khi đã kiểm tra email/password seed. Source hiện tại không có endpoint đổi password; `seed.ts` cũng không cập nhật password của user đã tồn tại, vì vậy không dùng password tạm rồi kỳ vọng đổi trong UI:

```bash
sudo docker compose -f docker-compose.prod.yml --env-file .env run --rm api corepack pnpm prisma:seed
```

Sau đó:

```bash
sudo docker compose -f docker-compose.prod.yml --env-file .env up -d api worker
sudo docker compose -f docker-compose.prod.yml --env-file .env ps
curl --fail --silent http://127.0.0.1:3001/health
curl --fail --silent http://127.0.0.1:3001/ready
```

Service `api` cũng chạy `pnpm prisma:deploy` trước `node dist/main.js`; lệnh migrate riêng phía trên là bước fail-fast và có thể chạy lặp an toàn. `/health` chứng minh process sống; `/ready` kiểm tra PostgreSQL, Redis và RabbitMQ. Compose healthcheck dùng `/ready`; reverse proxy/orchestrator cũng phải loại instance khi readiness fail, không route traffic chỉ vì process còn sống.

Production Compose hiện khai báo hai replica `worker`. Khi benchmark cho thấy cần đổi tạm thời, dùng `--scale` và nhớ áp lại cùng giá trị ở các lần `up` sau (nếu không Compose có thể trở về giá trị trong file):

```bash
sudo docker compose -f docker-compose.prod.yml --env-file .env up -d --scale worker=4 worker
```

Scale ngang làm tổng số message đang xử lý tăng theo `replicas × RABBITMQ_PREFETCH`; theo dõi DB connection, RabbitMQ unacked và quota từng provider/account trước khi tăng.

Frontend có `Dockerfile` multi-stage Next standalone và `docker-compose.yml`; Compose bind an toàn vào `127.0.0.1:3000`:

```bash
cd /opt/social-publisher/social-publisher-frontend
sudo docker compose --env-file .env build --pull \
  --build-arg NEXT_PUBLIC_API_URL=https://api.example.com
sudo docker compose --env-file .env up -d
sudo docker compose --env-file .env ps
curl --fail --silent http://127.0.0.1:3000/api/health
```

Compose cũng truyền `NEXT_PUBLIC_APP_NAME` và `NEXT_PUBLIC_POLL_INTERVAL_MS` từ `.env` thành build args. Trên production, luôn đặt `FRONTEND_IMAGE=social-publisher-frontend:<RELEASE_TAG>` trong `.env` trước khi build; chỉ local development mới nên dùng giá trị mặc định `:local`. Giữ tag release trước đó để rollback mà không rebuild.

## 9. Reverse proxy và TLS bằng Caddy

Cài stable package từ repository chính thức cho Debian/Ubuntu:

```bash
sudo apt install --yes debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
  | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
  | sudo tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
sudo chmod o+r /usr/share/keyrings/caddy-stable-archive-keyring.gpg
sudo chmod o+r /etc/apt/sources.list.d/caddy-stable.list
sudo apt update
sudo apt install -y caddy
```

Đây là chuỗi lệnh đang được [Caddy công bố chính thức cho Debian/Ubuntu](https://caddyserver.com/docs/install#debian-ubuntu-raspbian); kiểm tra lại nguồn trước một lần cài mới trong tương lai. Sau đó sửa `/etc/caddy/Caddyfile`:

```caddyfile
app.example.com {
    encode zstd gzip
    reverse_proxy 127.0.0.1:3000
}

api.example.com {
    encode zstd gzip
    @blocked_docs {
        path /api/docs*
        not {
            remote_ip 127.0.0.1 ::1 ADMIN_PUBLIC_IP/32
        }
    }
    respond @blocked_docs 404
    request_body {
        max_size 55MB
    }
    reverse_proxy 127.0.0.1:3001
}
```

Validate và reload:

```bash
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
sudo systemctl status caddy --no-pager
curl --fail https://api.example.com/health
curl --fail https://api.example.com/ready
curl --fail --head https://app.example.com/
```

Caddy tự quản lý TLS khi DNS và port 80/443 đúng. Reverse proxy không được cache API auth và không ghi Authorization/cookie vào access log. Xem [Caddy reverse proxy quick-start](https://caddyserver.com/docs/quick-starts/reverse-proxy).

Thay `ADMIN_PUBLIC_IP` bằng IP quản trị thật hoặc bỏ hẳn ngoại lệ để Swagger `/api/docs` và `/api/docs-json` chỉ còn truy cập qua loopback/VPN tunnel. Dashboard đã có form write-only cho các credential connector MVP, nên production có thể chặn hoàn toàn Swagger từ Internet. Pipeline frontend nên generate từ artifact `openapi.json` đã commit hoặc mạng nội bộ, không phụ thuộc endpoint Swagger public. Nếu Caddy đứng sau CDN/load balancer, cấu hình trusted proxy đúng trước khi dựa vào `remote_ip`; nếu chưa làm được, chỉ mở docs qua VPN/SSH tunnel.

Đặt rule ở CDN/WAF/ingress cho auth endpoint với ngưỡng bảo thủ, burst nhỏ và response `429`; không áp một ngưỡng quá thấp lên toàn API vì worker/admin có pattern khác nhau. Edge rule bổ sung cho Redis limiter trong app: IP có thể dùng chung hoặc bị xoay, nên theo dõi cả audit/alert theo account và IP.

### Public media cho Meta/Threads/TikTok

`S3_ENDPOINT=http://minio:9000` chỉ dùng nội bộ; provider bên ngoài không truy cập hostname Docker đó. `StorageService` tạo URL bằng `S3_PUBLIC_URL + / + object-key`, vì vậy `S3_PUBLIC_URL` phải gồm cả bucket/prefix. Trước khi bật media publishing, chọn một trong hai thiết kế:

- Khuyến nghị: S3-compatible public endpoint/CDN riêng; đặt `S3_PUBLIC_URL=https://media.example.com/social-publisher` và policy chỉ cho đọc object cần publish.
- Với MinIO cùng VPS: thêm Compose override được review để bind **S3 API** `127.0.0.1:9000:9000`, không bind console 9001; Caddy chỉ proxy `GET`/`HEAD` dưới `/social-publisher/*` tới 9000. `minio-init` hiện đặt bucket thành anonymous download, vì vậy bucket này chỉ được chứa media có thể công khai.

Override tối thiểu, ví dụ `docker-compose.media-public.yml` đặt cạnh Compose production:

```yaml
services:
  minio:
    ports:
      - "127.0.0.1:9000:9000"
```

Áp dụng bằng cách thêm `-f docker-compose.media-public.yml` sau `-f docker-compose.prod.yml` khi chạy lệnh `up` có service MinIO. Validate merged config bằng `config --quiet` trước; không thêm mapping cho cổng 9001.

Ví dụ phần Caddy khi đã có loopback binding nói trên:

```caddyfile
media.example.com {
    @public_media {
        method GET HEAD
        path /social-publisher/*
    }
    handle @public_media {
        reverse_proxy 127.0.0.1:9000
    }
    handle {
        respond 404
    }
}
```

Kiểm tra một object thật từ mạng ngoài bằng `curl -I` và `curl` có Range trước khi publish. Không public MinIO Console (`9001`) và không để dữ liệu riêng tư trong bucket anonymous. Nếu chưa có public origin được kiểm thử, text-only connector vẫn dùng được, nhưng Instagram/Threads media phải để `CREDENTIAL_REQUIRED`/`NEEDS_ACTION`.

## 10. Cấu hình OAuth sau khi TLS hoạt động

1. Đăng nhập role `ADMIN`, mở `GET /api/v1/oauth/providers` hoặc Swagger của đúng release. Release hiện chỉ implement LinkedIn và Google/Blogger; chúng chỉ hiện `READY` sau khi đủ client credential (và `LINKEDIN_API_VERSION` cho LinkedIn).
2. Đăng ký chính xác `https://api.example.com/api/v1/oauth/linkedin/callback` trong LinkedIn và `https://api.example.com/api/v1/oauth/google/callback` trong Google Cloud.
3. Đặt app homepage/Privacy Policy/Terms/data deletion URL trên `app.example.com`.
4. Đặt `LINKEDIN_CLIENT_ID`/`LINKEDIN_CLIENT_SECRET`/`LINKEDIN_API_VERSION` và `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` trong backend `.env`, rồi recreate `api` và `worker`. Chọn LinkedIn version từ danh sách đang được hỗ trợ, không sao chép một `YYYYMM` cũ từ blog/tutorial.
5. Dùng một account test connect từ frontend. Kiểm tra callback không redirect loop, state chỉ dùng một lần, external account ID đúng.
6. Chỉ sau smoke test mới bật provider/account trong production. Meta/X/Reddit/TikTok env keys là chỗ dành cho connector tương lai/review; có key không đồng nghĩa OAuth route đã được bật.

Không dùng callback localhost trong app production. Không cấu hình OAuth callback trực tiếp vào frontend vì token exchange/client secret thuộc backend.

## 11. Backup bắt buộc

Backup có giá trị chỉ khi restore đã được thử trên môi trường khác.

### Thành phần cần giữ

- PostgreSQL: source of truth cho user/content/job/account/audit.
- Object storage: media gốc và derivative cần thiết.
- Backend `.env`/secret manager, đặc biệt `CREDENTIAL_ENCRYPTION_KEY` và version của key. Lưu tách khỏi database backup nhưng phải khôi phục được cùng nhau.
- Caddy config, release SHA, Compose file và provider app configuration inventory.
- RabbitMQ/Redis chủ yếu là trạng thái vận hành; không dùng chúng thay database source of truth. Persistent volumes giúp restart, nhưng recovery phải có khả năng rebuild/requeue an toàn từ DB.

Ví dụ dump PostgreSQL từ container (tên biến/service phải khớp Compose):

```bash
sudo install -d -m 0700 -o deploy -g deploy /var/backups/social-publisher
umask 077
cd /opt/social-publisher/social-publisher-backend
sudo docker compose -f docker-compose.prod.yml --env-file .env exec -T postgres \
  sh -c 'pg_dump --format=custom --no-owner --username="$POSTGRES_USER" "$POSTGRES_DB"' \
  > /var/backups/social-publisher/postgres-$(date -u +%Y%m%dT%H%M%SZ).dump
```

Mã hóa backup và đẩy sang storage/account khác VPS. Đặt retention (ví dụ daily/weekly/monthly) theo RPO, kèm checksum và cảnh báo nếu dump rỗng/thất bại.

Khôi phục là thao tác ghi đè dữ liệu. Luôn tạo VPS/database staging mới, xác nhận đúng target rồi mới dùng `pg_restore`. Test tối thiểu: migrate tương thích, đăng nhập, giải mã một credential bằng key khôi phục, đọc campaign/publish history và truy cập media.

Với MinIO, dùng replication/snapshot của volume hoặc `mc mirror` theo tài liệu MinIO/S3-compatible đang vận hành. Database backup không chứa binary object.

## 12. Nâng cấp và rollback

### Trước deploy

```bash
cd /opt/social-publisher/social-publisher-backend
git status --short
git fetch --tags --prune
git checkout <NEW_BACKEND_TAG_OR_SHA>
```

Xác nhận CI của SHA đó đã pass lint, typecheck, test, build và image scan theo quy trình tổ chức. Tạo DB backup trước migration.

```bash
sudo docker build --pull -t social-publisher-backend:<NEW_RELEASE_TAG> .
# Sửa BACKEND_IMAGE trong .env thành đúng tag trên, rồi validate trước khi chạy.
sudo docker compose -f docker-compose.prod.yml --env-file .env config --quiet
sudo docker compose -f docker-compose.prod.yml --env-file .env run --rm api corepack pnpm prisma:deploy
sudo docker compose -f docker-compose.prod.yml --env-file .env up -d --no-deps api worker
curl --fail https://api.example.com/ready
```

Theo dõi logs/error rate/queue lag và chạy smoke test publish vào account test. Frontend deploy độc lập sau khi API contract tương thích:

1. Backend thay đổi DTO/API.
2. Export `/api/docs-json`/`openapi.json` từ backend release.
3. Frontend `pnpm api:generate`, test/build trong CI.
4. Build image frontend với production API URL, khởi động phiên bản mới và kiểm tra login/dashboard.

Ví dụ build một tag frontend bất biến rồi nâng cấp. Trước khi đổi, ghi lại giá trị `FRONTEND_IMAGE` hiện tại để rollback:

```bash
cd /opt/social-publisher/social-publisher-frontend
git checkout <NEW_FRONTEND_TAG_OR_SHA>
# Đặt trong .env: NEXT_PUBLIC_API_URL=https://api.example.com
#                 FRONTEND_IMAGE=social-publisher-frontend:<NEW_RELEASE_TAG>
sudo docker compose --env-file .env build --pull frontend
sudo docker compose --env-file .env up -d --no-build --force-recreate frontend
curl --fail https://app.example.com/api/health
```

Rollback backend bằng cách trả `BACKEND_IMAGE` về tag cũ rồi recreate `api`/`worker`. Rollback frontend bằng cách trả `FRONTEND_IMAGE` trong `.env` về tag bất biến trước đó rồi chạy `docker compose up -d --no-build --force-recreate frontend`. **Không tự động rollback database** bằng cách chạy migration down hoặc restore backup khi chưa đánh giá dữ liệu mới; Prisma production migrations thường cần forward fix. Mọi migration phá vỡ tương thích phải dùng expand/contract: thêm schema mới → deploy code tương thích → backfill → chỉ xóa schema cũ ở release sau.

## 13. Monitoring và cảnh báo

Tối thiểu theo dõi:

- HTTP: `/health`, `/ready`, latency p50/p95/p99, 4xx/5xx, OAuth callback failures.
- Worker: queue depth, oldest job age, publish duration, retry/DLQ count, `POSSIBLE_DUPLICATE` và `NEEDS_ACTION`.
- Provider: 401/403/429 theo platform + account, token sắp hết hạn, quota remaining/reset, app review/version sunset.
- PostgreSQL: connections, slow queries, disk, backup age/success.
- RabbitMQ: ready/unacked messages, consumer count, disk/memory alarm.
- Redis: memory, eviction, connection failure; mất Redis không được gây duplicate publish.
- Object storage: capacity, 4xx/5xx, signed/public URL fetch từ ngoài VPS.
- Host: CPU, load, RAM/swap, filesystem/inode, Docker log size, TLS expiry và clock drift.

Log cần có `requestId`, `jobId`, `campaignId`, `platform`, `platformAccountId`, `attempt`, `status`; redaction bắt buộc cho password/token/secret/cookie/webhook URL và presigned URL query.

Các lệnh chẩn đoán an toàn:

```bash
cd /opt/social-publisher/social-publisher-backend
sudo docker compose -f docker-compose.prod.yml --env-file .env ps
sudo docker compose -f docker-compose.prod.yml --env-file .env logs --since=15m api worker
sudo docker stats --no-stream
df -h
df -i
curl --fail --silent https://api.example.com/ready
```

Không paste log thô vào ticket công khai trước khi chạy secret scanner/redaction.

## 14. Sự cố thường gặp

| Triệu chứng | Kiểm tra | Xử lý an toàn |
|---|---|---|
| API live nhưng `/ready` fail | Postgres/Redis/RabbitMQ/DNS nội bộ, healthchecks | Không đưa traffic; sửa dependency, không restart loop toàn stack |
| OAuth `redirect_uri_mismatch` | Exact scheme/host/path/trailing slash trong provider và `OAUTH_REDIRECT_BASE_URL` | Cập nhật provider/env, restart API; không nới wildcard tùy tiện |
| Frontend gọi localhost | `NEXT_PUBLIC_API_URL` trong artifact build | Rebuild frontend với URL production |
| CORS/login fail | `FRONTEND_URL`, proxy scheme, cookie Secure/SameSite | Căn origin chính xác; xác minh `TRUST_PROXY=true` chỉ sau trusted proxy |
| Media container fail | URL có public không, TLS/MIME/redirect/TTL/range; upload có bị từ chối vì MIME không khớp magic bytes | Test URL từ máy ngoài; dùng file đúng định dạng/chữ ký, tạo signed URL mới, không public cả MinIO Console |
| Hàng đợi tăng | consumer/worker health, provider 429, DB pool, prefetch | Giảm `RABBITMQ_PREFETCH` hoặc số replica `worker` khi provider/DB quá tải; tăng replica có kiểm soát khi worker thiếu năng lực; giữ idempotency |
| Duplicate nghi ngờ sau timeout | DB idempotency, Redis fingerprint-lock connectivity/contention, external ID/status endpoint | Chuyển `POSSIBLE_DUPLICATE`, đối soát; không blind-retry |
| Không giải mã được credential | encryption key/version đúng bản backup không | Dừng publish; phục hồi key đúng. Không overwrite credential hàng loạt |
| Disk đầy | Docker logs, DB/WAL, MinIO, backup local | Dọn theo retention có kiểm tra; bật rotation/remote backup, không xóa volume mù |

## 15. Checklist go-live

- [ ] DNS/TLS của app, API và media route hợp lệ từ Internet.
- [ ] Web ports chỉ bind loopback; database/Redis/RabbitMQ/MinIO Console không public.
- [ ] Swagger/admin credential routes được giới hạn bằng VPN/IP/access control phù hợp.
- [ ] Xác minh shared connector SSRF guard đang bật bằng smoke test URL private/redirect; chỉ admin tin cậy được cấu hình base URL và egress vẫn chặn loopback, metadata endpoint, mạng quản trị như defense-in-depth.
- [ ] Backend `.env` permission 600; secret không nằm trong Git/image/frontend.
- [ ] `CREDENTIAL_ENCRYPTION_KEY` đã backup tách biệt và restore-test.
- [ ] `docker compose config --quiet`, migrations, `/health`, `/ready` đều pass.
- [ ] Admin bootstrap đã được seed ngay từ đầu bằng password production random mạnh; seed không chạy lặp ngoài ý muốn.
- [ ] Frontend build trỏ đúng API HTTPS; CORS/cookie/login/refresh/logout pass.
- [ ] Redis auth limiter và Edge/WAF rate limit cho login/refresh đã test `429`; alert credential-stuffing hoạt động.
- [ ] OpenAPI contract và generated frontend client cùng version.
- [ ] Public media pull được test từ mạng ngoài nếu bật connector media.
- [ ] Mỗi provider đã qua checklist trong [SOCIAL_CONFIGURATION.md](SOCIAL_CONFIGURATION.md).
- [ ] Backup database/object storage và restore drill pass.
- [ ] Alert queue lag, 5xx, 429, token expiry, disk và backup failure hoạt động.
- [ ] Có release SHA/image tag cũ và kế hoạch rollback không làm hỏng migration.



