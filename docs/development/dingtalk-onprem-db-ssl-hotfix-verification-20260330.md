# DingTalk On-Prem DB SSL Hotfix Verification

日期：2026-03-30

## 本地验证

已通过：

```bash
pnpm --filter @metasheet/core-backend exec vitest run tests/unit/connection-pool-ssl.test.ts
pnpm --filter @metasheet/core-backend exec vitest run tests/unit/auth-login-routes.test.ts tests/unit/admin-directory-routes.test.ts tests/unit/directory-sync.test.ts
pnpm --filter @metasheet/core-backend build
```

结果：

- `connection-pool-ssl.test.ts`：`3` 项通过
- `auth-login-routes + admin-directory-routes + directory-sync`：`77` 项通过
- backend TypeScript build：通过

## 远端重部署

目标主机：`142.171.239.56`

已执行：

1. 将 hotfix 分支推送到 `origin/codex/dingtalk-onprem-rollout-20260330`
2. 远端 clean baseline clone 拉取该分支
3. 使用根目录 `Dockerfile.backend` 构建：

```text
ghcr.io/zensgit/metasheet2-backend:dingtalk-rollout-20260330-63605322a
```

4. 用 `docker run` 手工替换 `metasheet-backend`

## 远端运行结果

### 镜像

```bash
docker inspect -f '{{.Config.Image}}' metasheet-backend
```

```text
ghcr.io/zensgit/metasheet2-backend:dingtalk-rollout-20260330-63605322a
```

### 健康检查

```bash
curl -s http://127.0.0.1:8900/health
```

结果：`ok`

### OAuth

```text
GET /api/auth/dingtalk/launch              -> 200
POST /api/auth/dingtalk/callback 缺 code   -> 400
POST /api/auth/dingtalk/callback 错 state  -> 400
```

### Admin Directory

通过唯一邮箱注册临时用户、数据库提升为 `admin` 后重新登录，以下端点均返回 `200`：

```text
GET /api/admin/directory/sync/status
GET /api/admin/directory/sync/history
GET /api/admin/directory/deprovisions
```

## 结论

`DB_SSL=false` 在 production 下已恢复为真实关闭 SSL，目标主机 PostgreSQL 明文连接正常。

这次 hotfix 已解除 on-prem rollout 的最后一个 backend 阻塞，并与
[dingtalk-onprem-rollout-verification-20260330.md](/Users/huazhou/Downloads/Github/metasheet2/docs/deployment/dingtalk-onprem-rollout-verification-20260330.md)
中的最终通过结论一致。
