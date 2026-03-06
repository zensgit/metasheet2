# Attendance On-Prem 部署后 30 分钟验证清单

目标：新服务器部署完成后，30 分钟内完成可上线验证。

## 0) 前置

- 服务器已完成部署脚本：`attendance-onprem-deploy-easy.sh`
- 已拿到管理员账号：`ADMIN_EMAIL / ADMIN_PASSWORD`
- 以下命令在 Ubuntu VM 内执行

## 1) 5 分钟：服务与基础链路

```bash
cd /opt/metasheet
SERVICE_MANAGER=auto \
CHECK_NGINX=1 \
scripts/ops/attendance-onprem-healthcheck.sh
```

期望：输出 `Healthcheck OK`。

## 2) 5 分钟：登录与产品壳确认

```bash
API_BASE="http://127.0.0.1/api"
ADMIN_EMAIL="admin@your-company.local"
ADMIN_PASSWORD="<StrongPasswordAtLeast12Chars>"

curl -sS -X POST "${API_BASE}/auth/login" \
  -H 'Content-Type: application/json' \
  --data "{\"email\":\"${ADMIN_EMAIL}\",\"password\":\"${ADMIN_PASSWORD}\"}" > /tmp/login.json

TOKEN="$(node -e 'const fs=require("fs");const r=JSON.parse(fs.readFileSync("/tmp/login.json","utf8"));process.stdout.write((r?.data?.token||r?.token||""))')"

curl -sS "${API_BASE}/auth/me" -H "Authorization: Bearer ${TOKEN}" > /tmp/me.json
node -e 'const fs=require("fs");const r=JSON.parse(fs.readFileSync("/tmp/me.json","utf8"));console.log("mode=",r?.data?.features?.mode);'
```

期望：`mode= attendance`。

## 3) 10 分钟：考勤核心 API 最小闭环

```bash
cd /opt/metasheet
API_BASE="http://127.0.0.1/api" \
AUTH_TOKEN="${TOKEN}" \
bash scripts/ops/attendance-smoke-api.sh
```

期望：脚本结束返回 `SMOKE PASS`。

## 4) 5 分钟：核心页面人工走查

浏览器打开：

- `http://<server-ip>/attendance`

人工检查：

1. 可用管理员账号登录。
2. 顶栏为考勤专注入口（非完整平台导航）。
3. `Check In / Check Out` 按钮可见。
4. Adjustment Request 可提交。
5. Admin Center 可打开并保存设置。

## 5) 5 分钟：导入上传链路检查（upload 通道）

```bash
cd /opt/metasheet
REQUIRE_IMPORT_UPLOAD="true" \
REQUIRE_IDEMPOTENCY="true" \
REQUIRE_IMPORT_EXPORT="true" \
EXPECT_PRODUCT_MODE="attendance" \
API_BASE="http://127.0.0.1/api" \
AUTH_TOKEN="${TOKEN}" \
node scripts/ops/attendance-smoke-api.mjs
```

期望日志包含：

- `import upload ok`
- `idempotency ok`
- `export csv ok`
- 末尾 `SMOKE PASS`

## 6) 验证结论模板

把以下结论写入你的上线记录：

```text
Deployment Verification: PASS
Date: <YYYY-MM-DD HH:mm TZ>
Server: <IP/hostname>
Admin Login: PASS
Healthcheck: PASS
API Smoke: PASS
Upload+Idempotency+Export: PASS
Operator: <name>
```

## 7) 失败时优先排查

1. 先跑环境校验：

```bash
cd /opt/metasheet
ENV_FILE=/opt/metasheet/docker/app.env \
REQUIRE_ATTENDANCE_ONLY=1 \
scripts/ops/attendance-onprem-env-check.sh
```

2. 再看服务日志：

```bash
pm2 logs metasheet-backend --lines 200
sudo tail -n 200 /var/log/nginx/error.log
```

## 8) 配套文档

- [attendance-onprem-app-env-template-20260306.md](/Users/huazhou/Downloads/Github/metasheet2/docs/deployment/attendance-onprem-app-env-template-20260306.md)
- [attendance-go-live-checklist-20260306.md](/Users/huazhou/Downloads/Github/metasheet2/docs/deployment/attendance-go-live-checklist-20260306.md)
- [attendance-uat-signoff-template-20260306.md](/Users/huazhou/Downloads/Github/metasheet2/docs/deployment/attendance-uat-signoff-template-20260306.md)
