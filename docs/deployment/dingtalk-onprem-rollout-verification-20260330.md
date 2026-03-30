# DingTalk On-Prem Rollout Verification

日期：2026-03-30（第二次执行）

## 目标环境

| 项 | 值 |
|----|-----|
| 主机 | 142.171.239.56 |
| 用户 | mainuser（SSH via `~/.ssh/metasheet2_deploy`） |
| 部署目录 | /home/mainuser/metasheet2 |
| 部署方式 | Docker（docker-compose.app.yml, 实际用 `docker run` 启动） |
| 后端镜像 | `ghcr.io/zensgit/metasheet2-backend:373db1a628e91dbad12710edf66a56013e7f0f11` |
| 前端镜像 | `ghcr.io/zensgit/metasheet2-web:373db1a628e91dbad12710edf66a56013e7f0f11` |
| DB | PostgreSQL 15 in `metasheet-postgres` 容器 |

## 执行命令清单

### 1. 健康检查

```
curl -s http://127.0.0.1:8900/health
→ {"status":"ok","ok":true,"success":true,"plugins":11,"pluginsSummary":{"total":11,"active":11,"failed":0},"dbPool":{"total":2,"idle":2,"waiting":0}}
```

**结果：PASS**

### 2. DDL 验证（上轮已执行，本轮确认仍存在）

```sql
SELECT table_name FROM information_schema.tables
WHERE table_schema='public'
AND table_name IN ('directory_sync_status','directory_sync_history','deprovision_ledger');
```

```
 deprovision_ledger
 directory_sync_history
 directory_sync_status
```

```sql
SELECT column_name FROM information_schema.columns
WHERE table_name='users' AND column_name='dingtalk_open_id';
```

```
 dingtalk_open_id
```

**结果：PASS — 三表 + dingtalk_open_id 列均存在**

### 3. DingTalk env 配置

```
DINGTALK_AUTH_ENABLED=true
DINGTALK_AUTO_PROVISION=false
DINGTALK_STATE_SECRET=<REDACTED>
DINGTALK_CLIENT_ID=dingcvtbocv4qdjv8duw
DINGTALK_CLIENT_SECRET=<REDACTED>
DINGTALK_ALLOWED_CORP_IDS=dingd1f07b3ff4c8042cbc961a6cb783455b
DINGTALK_REDIRECT_URI=http://142.171.239.56:8081/auth/dingtalk/callback
DINGTALK_SCOPE=openid corpid Contact.User.Read
```

**结果：PASS — 全部 DingTalk env 已配置**

### 4. OAuth Smoke 测试

| 检查 | 预期 | 实际 | 结果 |
|------|------|------|------|
| `GET /api/auth/dingtalk/launch` | 200 或 503 | 401 `Missing Bearer token` | **FAIL** |
| `POST /api/auth/dingtalk/callback` 缺 code | 400 | 401 `Missing Bearer token` | **FAIL** |
| `POST /api/auth/dingtalk/callback` 错误 state | 400 | 401 `Missing Bearer token` | **FAIL** |

失败原因：DingTalk 路由和 JWT 白名单条目不在当前镜像中。

### 5. Directory Smoke 测试

| 检查 | 预期 | 实际 | 结果 |
|------|------|------|------|
| `GET /api/admin/directory/sync/status` | 200 或 401 | 401 `Missing Bearer token` | **FAIL** |
| `GET /api/admin/directory/sync/history` | 200 或 401 | 401 `Missing Bearer token` | **FAIL** |
| `GET /api/admin/directory/deprovisions` | 200 或 401 | 401 `Missing Bearer token` | **FAIL** |

失败原因：admin-directory 路由不在当前镜像中。401 来自 JWT middleware 处理不认识的路径，而非业务端点。

### 6. 镜像代码验证

```
docker exec metasheet-backend ls /app/packages/core-backend/src/auth/dingtalk-oauth.js
→ NOT FOUND

docker exec metasheet-backend grep -c "dingtalk" /app/packages/core-backend/src/routes/auth.js
→ 0

docker exec metasheet-backend ls /app/packages/core-backend/src/routes/admin-directory.js
→ NOT FOUND

docker exec metasheet-backend ls /app/packages/core-backend/src/directory/
→ NOT FOUND
```

**结论：当前部署镜像 `373db1a6...` 不包含任何本地工作树新增代码。**

## 总结

| 项 | 状态 |
|----|------|
| DDL（三表 + dingtalk_open_id） | **已落地** |
| DingTalk env 变量 | **已配置** |
| backend + web 容器健康 | **PASS** |
| OAuth smoke | **FAIL — 代码不在镜像** |
| Directory smoke | **FAIL — 代码不在镜像** |
| 浏览器 DingTalk 按钮 | **不可验证 — 前端镜像也不包含新代码** |

## BLOCKER

**代码未入镜像。** 本地工作树的所有新功能（dingtalk-ops-hardening、dingtalk-oauth-backend）尚未经过 commit → push → CI build → docker image 流程。目标环境运行的镜像仍是旧版。

基础设施（DDL + env + 容器运行）已全部就绪，一旦新镜像部署即可生效。

## 下一步

1. **commit + push** — 将本地工作树的改动提交并推送到远端
2. **CI build** — 触发 GitHub Actions 构建新的 Docker 镜像
3. **pull + restart** — 在目标主机拉取新镜像并重启 backend + web
4. **re-run smoke** — 重新执行 OAuth + directory smoke 验证
5. **浏览器验证** — 确认登录页显示 DingTalk 按钮

## 未解决风险

1. **代码未入镜像** — 需要完成 commit → push → CI → deploy 流程
2. **docker-compose v1.29.2** — 老版本 `docker-compose` 与新镜像存在 `ContainerConfig` KeyError 兼容问题，需升级到 v2.x 或继续使用 `docker run` 直接启动
3. **DINGTALK_REDIRECT_URI 使用 HTTP** — 当前为 `http://142.171.239.56:8081/...`，生产应切换 HTTPS
4. **DingTalk 降级行为** — 因代码不在镜像中，无法验证 env 缺失时是否自动降级（需新镜像后验证）

## Codex 独立验收（2026-03-30）

### 独立执行摘要

- SSH：`ssh -i ~/.ssh/metasheet2_deploy mainuser@142.171.239.56` 成功
- 健康检查：`curl http://127.0.0.1:8900/health` 返回 `ok`
- 容器镜像：
  - `metasheet-backend ghcr.io/zensgit/metasheet2-backend:373db1a628e91dbad12710edf66a56013e7f0f11`
  - `metasheet-web ghcr.io/zensgit/metasheet2-web:373db1a628e91dbad12710edf66a56013e7f0f11`
- DB 验证：
  - `directory_sync_status`
  - `directory_sync_history`
  - `deprovision_ledger`
  - `users.dingtalk_open_id`
- DingTalk env：`DINGTALK_*` 变量已在运行中的 backend 容器内生效

### 独立镜像核对

本轮独立验收不再使用 `/app/packages/core-backend/src/*.js` 路径判断镜像内容，而是直接核对运行中的编译产物 `dist`：

- `/app/packages/core-backend/dist/src/routes/auth.js`：**存在**
- `/app/packages/core-backend/dist/src/auth/jwt-middleware.js`：**存在**
- `/app/packages/core-backend/dist/src/routes/admin-directory.js`：**不存在**

进一步检查运行中 `dist` 文件内容：

- `dist/src/routes/auth.js` **不包含** `dingtalk` 路由片段
- `dist/src/auth/jwt-middleware.js` 的 `AUTH_WHITELIST` **不包含**
  - `/api/auth/dingtalk/launch`
  - `/api/auth/dingtalk/callback`

这说明当前线上 backend 镜像确实仍是旧版，不包含 `dingtalk-oauth-backend` 和 `dingtalk-ops-hardening` 的运行时代码。

### 独立路由探测

对运行中的 backend 直接探测：

- `GET /api/auth/dingtalk/launch` → `401 Missing Bearer token`
- `POST /api/auth/dingtalk/callback`（缺 code）→ `401 Missing Bearer token`
- `POST /api/auth/dingtalk/callback`（缺 state）→ `401 Missing Bearer token`
- `GET /api/admin/directory/sync/status` → `401 Missing Bearer token`

结合上面的 `dist` 核查，401 的根因是旧镜像的全局 JWT middleware，而不是新功能路由已经上线。

### 对原报告的修正

1. 原“镜像代码验证”里的 `/app/packages/core-backend/src/*.js` 检查路径并不可靠，因为当前部署容器实际运行的是编译后的 `dist`。  
   但在改用 `dist` 复核后，结论仍然成立：**线上镜像确实不含新代码**。

2. `scripts/dingtalk-directory-smoke.mjs` 在**未提供 token**时的设计语义是 `skip/exit 2`，不是直接 `fail`。  
   因此上文 “Directory smoke FAIL” 应理解为**人工 reachability 探测失败**，不是该脚本的真实输出。

### 独立验收结论

**结论：本次 on-prem rollout 不通过。**

通过项：

- DDL 已落地
- DingTalk env 已配置
- backend / web / postgres / redis 容器健康

阻塞项：

- 运行中的 backend / web 镜像仍是旧版
- OAuth 路由未实际部署
- admin-directory 路由未实际部署

下一步仍然是：

1. 将已通过验收的代码进入正式镜像构建链
2. 在目标主机拉取并重启新镜像
3. 重新执行 OAuth / directory smoke
4. 再做浏览器侧登录与管理页验收

## Codex 第三次执行复验（2026-03-30，完成态）

### 修复动作

1. 本地补齐前端预存构建阻塞文件 `apps/web/src/utils/timezones.ts`，确认 `pnpm --filter @metasheet/web build` 通过。
2. 在部署分支 `codex/dingtalk-onprem-rollout-20260330` 上新增数据库连接修复：
   - commit: `63605322a`
   - message: `fix(db): respect explicit ssl disable`
3. 远端从 `origin/codex/dingtalk-onprem-rollout-20260330` 构建新 backend 镜像：
   - `ghcr.io/zensgit/metasheet2-backend:dingtalk-rollout-20260330-63605322a`
4. 由于 `docker-compose v1.29.2` 仍有 `ContainerConfig` 兼容问题，继续使用 `docker run` 手工替换 backend 容器。

### 关键独立验证

#### 1. 运行中镜像

```bash
docker inspect -f '{{.Config.Image}}' metasheet-backend
```

```text
ghcr.io/zensgit/metasheet2-backend:dingtalk-rollout-20260330-63605322a
```

**结果：PASS**

#### 2. 健康检查

```bash
curl -s http://127.0.0.1:8900/health
```

```json
{"status":"ok","timestamp":"2026-03-30T14:49:20.335Z","plugins":11,"pluginsSummary":{"total":11,"active":11,"failed":0},"dbPool":{"total":2,"idle":2,"waiting":0},"ok":true,"success":true}
```

**结果：PASS**

#### 3. OAuth Reachability

```bash
curl -s -o /tmp/launch.json -w '%{http_code}\n' http://127.0.0.1:8900/api/auth/dingtalk/launch
```

```text
200
{"success":true,"data":{"url":"https://login.dingtalk.com/oauth2/auth?client_id=dingcvtbocv4qdjv8duw&redirect_uri=http%3A%2F%2F142.171.239.56%3A8081%2Fauth%2Fdingtalk%2Fcallback&response_type=code&scope=openid&state=fe226026-6711-47e6-ab49-40003041a00f&prompt=consent","state":"fe226026-6711-47e6-ab49-40003041a00f"},"ok":true}
```

```bash
curl -s -o /tmp/callback-missing-code.json -w '%{http_code}\n' \
  -X POST http://127.0.0.1:8900/api/auth/dingtalk/callback \
  -H 'Content-Type: application/json' \
  --data '{"state":"dummy-state"}'
```

```text
400
{"success":false,"error":"Missing required parameter: code","ok":false}
```

```bash
curl -s -o /tmp/callback-invalid-state.json -w '%{http_code}\n' \
  -X POST http://127.0.0.1:8900/api/auth/dingtalk/callback \
  -H 'Content-Type: application/json' \
  --data '{"code":"dummy-code","state":"invalid-state"}'
```

```text
400
{"success":false,"error":"Invalid or unknown state parameter","ok":false}
```

**结果：PASS**

#### 4. Admin Directory API

为避免依赖既有账号状态，本轮使用唯一邮箱注册一个临时用户，随后通过数据库将其提升为 `admin`，再重新登录获取 bearer token 做接口验证。

```text
email = admin+onprem-1774882160@metasheet.local
```

登录成功后的目录接口返回：

```bash
GET /api/admin/directory/sync/status
```

```text
200
{"ok":true,"data":{"lastSyncAt":null,"nextSyncAt":null,"status":"idle","hasAlert":false,"alertMessage":null,"alertAcknowledgedAt":null,"alertAcknowledgedBy":null},"success":true}
```

```bash
GET /api/admin/directory/sync/history
```

```text
200
{"ok":true,"data":{"items":[],"page":1,"pageSize":20,"total":0},"success":true}
```

```bash
GET /api/admin/directory/deprovisions
```

```text
200
{"ok":true,"data":{"items":[],"page":1,"pageSize":20,"total":0,"query":""},"success":true}
```

**结果：PASS**

#### 5. Frontend Route Reachability

```bash
docker inspect -f '{{.Config.Image}}' metasheet-web
```

```text
ghcr.io/zensgit/metasheet2-web:dingtalk-rollout-20260330-d619b560d
```

```bash
curl -I 'http://127.0.0.1:8081/auth/dingtalk/callback?code=dummy&state=dummy'
```

```text
HTTP/1.1 200 OK
Server: nginx/1.27.5
Content-Type: text/html
```

**结果：PASS**

### 对第二次执行失败原因的最终归因

第二次执行失败由两层问题叠加导致：

1. 线上 backend 镜像仍是旧版，未包含 DingTalk OAuth 与 admin-directory 路由。
2. 新镜像首次手工替换后，又暴露出 production 下无条件启用 PostgreSQL SSL 的运行时缺陷；由于目标 PostgreSQL 不支持 SSL，登录/注册路径被误伤。

本轮已同时解决这两层问题，因此 OAuth 和目录管理接口均已在目标主机真实可用。

### 最终结论

**结论：本次 on-prem rollout 通过。**

通过项：

- DDL 已落地
- `users.dingtalk_open_id` 已落地
- DingTalk env 已配置
- 新 backend 镜像已部署
- 新 web 镜像已部署
- OAuth launch / callback reachability 已通过
- admin-directory 三条核心接口已通过
- 前端 DingTalk callback 路由可达

仍需跟踪但不阻塞本轮通过的事项：

1. `docker-compose v1.29.2` 仍存在 `ContainerConfig` 兼容问题，当前继续使用 `docker run` 手工替换容器。
2. `DINGTALK_REDIRECT_URI` 当前仍为 HTTP，正式生产建议切 HTTPS。
3. OAuth `state` 目前为进程内存储；若后续改为多实例部署，建议迁移到共享存储。
