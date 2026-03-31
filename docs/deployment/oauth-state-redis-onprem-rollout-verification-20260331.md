# OAuth State Redis On-Prem Rollout Verification

日期：2026-03-31

## 目标环境

| 项 | 值 |
|----|-----|
| 主机 | `142.171.239.56` |
| 用户 | `mainuser` |
| 部署方式 | Docker `docker run` |
| backend 镜像 | `ghcr.io/zensgit/metasheet2-backend:dingtalk-rollout-20260331-1d9d867b0` |
| Redis 容器 | `metasheet-redis` |

## 执行摘要

1. 本地将 `feat(auth): persist dingtalk oauth state in redis` 推送到 `origin/codex/dingtalk-onprem-rollout-20260330`
2. 远端由于既有 `metasheet2-git-baseline` 工作树不干净，改用 fresh clone：
   - `/home/mainuser/metasheet2-rollout-oauth-state-redis`
3. 在 fresh clone 中使用根目录 `Dockerfile.backend` 构建新 backend 镜像
4. 继续沿用现网 `docker run` 参数：
   - `--network metasheet2_default`
   - `--env-file /home/mainuser/metasheet2/docker/app.env`
   - `-v metasheet-attendance-import-data:/app/uploads/attendance-import`
   - `-p 127.0.0.1:8900:8900`
5. 手工替换 `metasheet-backend` 容器并重跑 OAuth reachability

## 远端实测

### 1. 镜像与健康

```text
IMAGE=ghcr.io/zensgit/metasheet2-backend:dingtalk-rollout-20260331-1d9d867b0
```

```json
HEALTH={"status":"ok","timestamp":"2026-03-31T06:25:51.850Z","plugins":11,"pluginsSummary":{"total":11,"active":11,"failed":0},"dbPool":{"total":2,"idle":2,"waiting":0},"ok":true,"success":true}
```

**结果：PASS**

### 2. OAuth reachability

```text
MISSING_CODE_STATUS=400
MISSING_CODE_BODY={"success":false,"error":"Missing required parameter: code","ok":false}
```

```text
INVALID_STATE_STATUS=400
INVALID_STATE_BODY={"success":false,"error":"Invalid or unknown state parameter","ok":false}
```

**结果：PASS**

### 3. Redis state 跨重启复验

先调用 `GET /api/auth/dingtalk/launch` 获取有效 state：

```text
STATE=7bd8bfe4-9fb7-40f6-80e1-23f306e9c9b3
```

随后重启 `metasheet-backend`，再使用同一个 state 调用 callback：

```text
REPLAYED_STATE_STATUS=502
REPLAYED_STATE_BODY={"success":false,"error":"不合法的临时授权码","ok":false}
```

这个结果是本轮最关键的验收点：

- 如果 state 仍是旧的进程内存储，backend 重启后应直接返回 `400 Invalid or unknown state parameter`
- 实际结果是 `502`，说明 state 在重启后仍然可被服务端识别，并继续进入 DingTalk code 交换阶段
- 因此可以确认：当前 on-prem 实例已实际启用 Redis-backed OAuth state，而不是仅停留在代码层

## 结论

**结论：本次 `oauth-state-redis` on-prem rollout 通过。**

通过项：

- 新 backend 镜像已在 `142.171.239.56` 上运行
- `/api/auth/dingtalk/launch` 正常
- `/api/auth/dingtalk/callback` 的缺参 / 错 state 语义保持不变
- Redis-backed state 已通过“跨 backend 重启”方式得到实证

仍需跟踪但不阻塞本轮通过的事项：

1. 远端 `metasheet2-git-baseline` 当前不是干净工作树，后续部署仍建议使用 fresh clone 或先做远端工作树整理
2. 现网仍继续依赖 `docker run`，因为 `docker-compose v1.29.2` 兼容问题未解除
3. `DINGTALK_REDIRECT_URI` 仍为 HTTP，正式生产建议切 HTTPS
