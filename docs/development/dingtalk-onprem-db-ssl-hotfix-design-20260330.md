# DingTalk On-Prem DB SSL Hotfix Design

日期：2026-03-30

## 背景

`142.171.239.56` 上已部署的新 DingTalk OAuth / directory backend 在运行时出现：

```text
The server does not support SSL connections
```

目标 PostgreSQL 为容器内明文连接，`docker/app.env` 已显式配置：

```text
DB_SSL=false
DATABASE_URL=postgres://metasheet:***@postgres:5432/metasheet
```

但 `packages/core-backend/src/integration/db/connection-pool.ts` 在 `NODE_ENV=production` 下无条件构造 `ssl` 对象，导致 `pg` 始终尝试 SSL 连接。

## 目标

1. `DB_SSL=false` 在 production 下必须显式关闭 SSL。
2. 不破坏当前 production 默认“启用 SSL”的保守行为。
3. 为后续 on-prem / 多环境部署提供明确、可测试的 SSL 解析规则。

## 方案

在 `connection-pool.ts` 内新增集中式 SSL 解析函数 `buildPoolSslConfig()`：

- `DB_SSL=false|0|no|off|disable|disabled`：
  - 返回 `false`
- `DB_SSL=true|1|yes|on|require|required`：
  - 返回 `pg` 可识别的 SSL 对象
- `DB_SSL` 未设置：
  - `production` 默认启用 SSL
  - 非 `production` 默认关闭 SSL

补充规则：

- `DB_SSL_REJECT_UNAUTHORIZED=false` 继续生效
- `DB_SSL_CA` / `DB_SSL_CERT` / `DB_SSL_KEY` 仅在存在时写入 SSL 对象
- 不再把 `undefined` 证书字段硬塞给 `pg`

## 测试策略

新增定向单测 `packages/core-backend/tests/unit/connection-pool-ssl.test.ts`，锁定三种行为：

1. `NODE_ENV=production` + `DB_SSL=false` => `ssl === false`
2. `NODE_ENV=production` + `DB_SSL` 未设置 => `ssl.rejectUnauthorized === true`
3. `NODE_ENV=development` + `DB_SSL=true` => 显式启用 SSL

## 部署策略

1. 将 hotfix 提交到 `codex/dingtalk-onprem-rollout-20260330`
2. 远端基于该分支重建 backend 镜像
3. 保持 web 镜像不动，仅替换 backend 容器
4. 重新验证：
   - `/health`
   - `/api/auth/dingtalk/launch`
   - `/api/auth/dingtalk/callback`
   - `/api/admin/directory/*`

## 风险

1. 当前 OAuth `state` 仍是进程内存，不适用于多实例共享。
2. `docker-compose v1.29.2` 仍不可用，部署阶段继续依赖 `docker run`。
3. `DINGTALK_REDIRECT_URI` 当前仍为 HTTP，正式生产建议改为 HTTPS。
