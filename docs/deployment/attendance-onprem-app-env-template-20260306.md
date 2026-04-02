# Attendance On-Prem 生产 `app.env` 模板（Windows Server + Ubuntu VM）

用途：给新服务器部署时直接复制使用。模板不包含任何真实密钥。

## 1) 使用方式

```bash
cd /opt/metasheet
cp docker/app.env.example docker/app.env
```

将下面模板内容覆盖到 `docker/app.env`，再把 `<...>` 占位符替换为真实值。

如果你希望直接用仓库内成品模板：

```bash
cd /opt/metasheet
cp docker/app.env.attendance-onprem.template docker/app.env
```

注意：模板中的敏感值默认是 `change-me`，用于强制拦截未替换配置。请全部替换后再部署。

如果你希望使用“部署草案版（非敏感项已填好）”：

```bash
cd /opt/metasheet
cp docker/app.env.attendance-onprem.ready.env docker/app.env
```

然后只替换这 3 项：

1. `JWT_SECRET`
2. `POSTGRES_PASSWORD`
3. `DATABASE_URL` 里的数据库密码

注意：
- `JWT_SECRET` 现在要求至少 32 字符，且不能继续使用任何开发默认值。
- `BCRYPT_SALT_ROUNDS` 需要保持 `12` 或更高，on-prem 校验脚本会直接拦截更低配置。

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
BCRYPT_SALT_ROUNDS=12

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
ATTENDANCE_IMPORT_CSV_MAX_ROWS=100000
ATTENDANCE_IMPORT_HEAVY_QUERY_TIMEOUT_MS=180000
```

## 3) 生成安全值（照抄）

生成 `JWT_SECRET`：

```bash
openssl rand -hex 48
```

如果你确实要调整 bcrypt 代价系数，生产环境只允许 `>= 12`：

```env
BCRYPT_SALT_ROUNDS=12
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
2. `JWT_SECRET uses an insecure placeholder/default value`
   - 原因：仍在使用 `test`、`dev-secret`、`dev-secret-key` 等弱默认值，或长度不足 32 字符。
3. `BCRYPT_SALT_ROUNDS must be >= 12`
   - 原因：生产配置过低，部署校验会拒绝继续。
4. `ATTENDANCE_IMPORT_REQUIRE_TOKEN must be 1`
   - 原因：生产门禁要求强制开启 token。
5. `ATTENDANCE_IMPORT_UPLOAD_DIR must be an absolute path`
   - 原因：使用了相对路径。
6. `PRODUCT_MODE ... expected attendance`
   - 原因：目标是考勤专注部署，但模式配置错误。

## 6) 配套文档

- [attendance-windows-onprem-easy-start-20260306.md](/Users/huazhou/Downloads/Github/metasheet2/docs/deployment/attendance-windows-onprem-easy-start-20260306.md)
- [attendance-onprem-postdeploy-30min-verification-20260306.md](/Users/huazhou/Downloads/Github/metasheet2/docs/deployment/attendance-onprem-postdeploy-30min-verification-20260306.md)
