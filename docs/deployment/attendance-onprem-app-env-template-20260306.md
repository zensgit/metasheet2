# Attendance On-Prem 生产 `app.env` 模板（Windows Server + Ubuntu VM）

用途：给新服务器部署时直接复制使用。模板不包含任何真实密钥。

## 1) 使用方式

```bash
cd /opt/metasheet
cp docker/app.env.example docker/app.env
```

将下面模板内容覆盖到 `docker/app.env`，再把 `<...>` 占位符替换为真实值。

## 2) 推荐模板（考勤专注模式）

```env
# Runtime
NODE_ENV=production
HOST=127.0.0.1
PORT=8900

# Product shell
PRODUCT_MODE=attendance
DEPLOYMENT_MODEL=onprem

# Security
JWT_SECRET=<replace-with-64+chars-random-secret>

# Database
POSTGRES_USER=metasheet
POSTGRES_PASSWORD=<replace-with-strong-db-password>
POSTGRES_DB=metasheet
DATABASE_URL=postgres://metasheet:<replace-with-strong-db-password>@127.0.0.1:5432/metasheet

# Redis
REDIS_HOST=127.0.0.1
REDIS_PORT=6379
REDIS_PASSWORD=

# Attendance import safety guards
ATTENDANCE_IMPORT_REQUIRE_TOKEN=1
ATTENDANCE_IMPORT_UPLOAD_DIR=/opt/metasheet/storage/attendance-import
ATTENDANCE_IMPORT_CSV_MAX_ROWS=20000
ATTENDANCE_IMPORT_HEAVY_QUERY_TIMEOUT_MS=180000
```

## 3) 生成安全值（照抄）

生成 `JWT_SECRET`：

```bash
openssl rand -hex 48
```

生成数据库强密码（示例）：

```bash
openssl rand -base64 36
```

## 4) 变量校验（部署前必须）

```bash
cd /opt/metasheet
ENV_FILE=/opt/metasheet/docker/app.env \
REQUIRE_ATTENDANCE_ONLY=1 \
scripts/ops/attendance-onprem-env-check.sh
```

期望输出：`Env check OK`。

## 5) 常见错误

1. `JWT_SECRET is still 'change-me'`
   - 原因：未替换默认值。
2. `ATTENDANCE_IMPORT_REQUIRE_TOKEN must be 1`
   - 原因：生产门禁要求强制开启 token。
3. `ATTENDANCE_IMPORT_UPLOAD_DIR must be an absolute path`
   - 原因：使用了相对路径。
4. `PRODUCT_MODE ... expected attendance`
   - 原因：目标是考勤专注部署，但模式配置错误。

## 6) 配套文档

- [attendance-windows-onprem-easy-start-20260306.md](/Users/huazhou/Downloads/Github/metasheet2/docs/deployment/attendance-windows-onprem-easy-start-20260306.md)
- [attendance-onprem-postdeploy-30min-verification-20260306.md](/Users/huazhou/Downloads/Github/metasheet2/docs/deployment/attendance-onprem-postdeploy-30min-verification-20260306.md)
