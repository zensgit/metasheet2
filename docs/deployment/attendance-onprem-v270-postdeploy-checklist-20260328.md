# Attendance On-Prem v2.7.0 部署后验收清单

目标：在 `metasheet-attendance-onprem-v2.7.0.zip` 或 `.tgz` 部署完成后，用最短路径确认环境可交付、可登录、可跑通考勤核心闭环。

适用版本：

- `metasheet-attendance-onprem-v2.7.0.zip`
- `metasheet-attendance-onprem-v2.7.0.tgz`

建议在部署完成后 15 到 30 分钟内执行完毕。

## 0. 前置

- 已完成部署或升级到 `v2.7.0`
- 已拿到管理员账号：`ADMIN_EMAIL / ADMIN_PASSWORD`
- 目标机可访问：
  - 前端 `BASE_URL`
  - 后端 `API_BASE`
- 以下命令默认在部署目录执行：

```bash
cd /opt/metasheet
```

## 1. 版本包与校验文件确认

至少确认你实际部署的包来自 `v2.7.0` release：

- `metasheet-attendance-onprem-v2.7.0.zip`
- 或 `metasheet-attendance-onprem-v2.7.0.tgz`
- 对应：
  - `metasheet-attendance-onprem-v2.7.0.zip.sha256`
  - `metasheet-attendance-onprem-v2.7.0.tgz.sha256`
  - `SHA256SUMS-v2.7.0`

如果部署前还没做校验，至少补做一次：

```bash
shasum -a 256 metasheet-attendance-onprem-v2.7.0.zip
cat metasheet-attendance-onprem-v2.7.0.zip.sha256
```

期望：本地计算出的哈希与发布文件一致。

## 2. 5 分钟：服务与基础链路

```bash
cd /opt/metasheet
SERVICE_MANAGER=auto \
CHECK_NGINX=1 \
scripts/ops/attendance-onprem-healthcheck.sh
```

期望：

- 输出 `Healthcheck OK`
- 后端健康检查可达
- 前端根路径可达
- `/api/plugins` 可达

## 3. 5 分钟：登录与产品模式确认

```bash
API_BASE="http://127.0.0.1/api"
ADMIN_EMAIL="admin@your-company.local"
ADMIN_PASSWORD="<StrongPasswordAtLeast12Chars>"

curl -sS -X POST "${API_BASE}/auth/login" \
  -H 'Content-Type: application/json' \
  --data "{\"email\":\"${ADMIN_EMAIL}\",\"password\":\"${ADMIN_PASSWORD}\"}" > /tmp/v270-login.json

TOKEN="$(node -e 'const fs=require(\"fs\");const r=JSON.parse(fs.readFileSync(\"/tmp/v270-login.json\",\"utf8\"));process.stdout.write((r?.data?.token||r?.token||\"\"))')"

curl -sS "${API_BASE}/auth/me" \
  -H "Authorization: Bearer ${TOKEN}" > /tmp/v270-me.json

node -e 'const fs=require("fs");const r=JSON.parse(fs.readFileSync("/tmp/v270-me.json","utf8"));console.log("mode=",r?.data?.features?.mode);'
```

期望：

- 登录成功
- `mode= attendance`

## 4. 10 分钟：考勤核心 API 闭环

```bash
cd /opt/metasheet
API_BASE="http://127.0.0.1/api" \
AUTH_TOKEN="${TOKEN}" \
bash scripts/ops/attendance-smoke-api.sh
```

期望：

- 脚本结束返回 `SMOKE PASS`

## 5. 5 分钟：上传 / 幂等 / 导出链路

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

## 6. 5 到 10 分钟：页面人工走查

浏览器打开：

- `http://<server-ip>/attendance`

人工确认：

1. 可用管理员账号登录。
2. 首页能进入考勤模式页面。
3. `Check In / Check Out` 操作入口可见。
4. `Adjustment Request` 可提交。
5. `Admin Center` 可打开。
6. 管理区保存操作无明显卡死或报错。

## 7. 推荐补充检查

如果这次部署目标包含管理员场景，建议再补两项：

1. 打开 Admin Center，确认时区下拉和 admin rail 正常渲染。
2. 打开导入相关区块，确认 preview / commit 路径可见且没有报错。

## 8. 验收结论模板

```text
Attendance On-Prem v2.7.0 Post-Deploy Verification: PASS
Date: <YYYY-MM-DD HH:mm TZ>
Server: <IP/hostname>
Package: metasheet-attendance-onprem-v2.7.0.zip
Healthcheck: PASS
Admin Login: PASS
Product Mode: attendance
API Smoke: PASS
Upload + Idempotency + Export: PASS
UI Walkthrough: PASS
Operator: <name>
```

## 9. 失败时优先排查

先跑环境校验：

```bash
cd /opt/metasheet
ENV_FILE=/opt/metasheet/docker/app.env \
REQUIRE_ATTENDANCE_ONLY=1 \
scripts/ops/attendance-onprem-env-check.sh
```

再看日志：

```bash
pm2 logs metasheet-backend --lines 200
sudo tail -n 200 /var/log/nginx/error.log
```

## 10. 配套文档

- [attendance-onprem-postdeploy-30min-verification-20260306.md](/Users/huazhou/Downloads/Github/metasheet2/.worktrees/attendance-onprem-v270-postdeploy-20260328/docs/deployment/attendance-onprem-postdeploy-30min-verification-20260306.md)
- [attendance-uat-signoff-template-20260306.md](/Users/huazhou/Downloads/Github/metasheet2/.worktrees/attendance-onprem-v270-postdeploy-20260328/docs/deployment/attendance-uat-signoff-template-20260306.md)
- [attendance-onprem-app-env-template-20260306.md](/Users/huazhou/Downloads/Github/metasheet2/.worktrees/attendance-onprem-v270-postdeploy-20260328/docs/deployment/attendance-onprem-app-env-template-20260306.md)
