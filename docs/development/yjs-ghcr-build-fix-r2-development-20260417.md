# Yjs GHCR Build Fix R2 Development

日期：2026-04-17

## 背景

- 服务器当前已回稳在 `20260417-yjs-rollout-r1`，但该版本不能视为真正的 Yjs rollout 基线。
- 阻塞真正 Yjs 镜像发布的核心问题不是 GHCR，也不是部署脚本，而是源码构建：
  - `packages/core-backend` 在 Docker build 中会被一组 `multitable_*` 的 Kysely / JSON 类型错误卡住。
- 在清理类型错误后，又暴露出 Docker build context 过脏的问题：
  - 嵌套 `node_modules` 和运行产物被打进 context，导致 monorepo `pnpm install` 不稳定。

## 本轮修改

### 1. 收口 multitable JSON 写入类型

修改文件：

- `packages/core-backend/src/multitable/api-token-service.ts`
- `packages/core-backend/src/multitable/automation-log-service.ts`
- `packages/core-backend/src/multitable/dashboard-service.ts`
- `packages/core-backend/src/multitable/webhook-service.ts`
- `packages/core-backend/src/db/types.ts`

调整内容：

- 不再把 JSON 列写入混成 `RawBuilder<Record<...>>` 或 `unknown`。
- 对 `JSONColumnType` 列统一改成稳定的 `JSON.stringify(...)` 写入路径。
- 读取逻辑继续保持 string / object 双兼容，不改已有业务语义。
- `automation-log-service.cleanup()` 的时间比较改成 `sql<Date>\`now() - (${retentionDays} * interval '1 day')\``，去掉不稳定的 `sql.raw(...)` 拼接。
- `multitable_webhook_deliveries.payload` 从 `JSONColumnType<unknown>` 收窄到 `JSONColumnType<Record<string, unknown> | null>`，消除 Kysely 泛型约束错误。

### 2. 补仓库级 `.dockerignore`

新增文件：

- `.dockerignore`

目的：

- 排除 `**/node_modules`
- 排除 `output/`、`artifacts/`、`coverage/`
- 排除 `packages/core-backend/dist`、`packages/core-backend/dist-cache`、`apps/web/dist`

这样可以避免 Docker build context 把本地嵌套依赖和构建产物一起带进镜像，提升 monorepo `pnpm install` 的稳定性。

## 构建结果

在干净 worktree `/tmp/metasheet2-ghcr-publish` 上完成：

- `pnpm --filter @metasheet/core-backend build` 通过
- `docker build -f Dockerfile.backend ...` 通过
- `docker build -f Dockerfile.frontend ...` 通过

## GHCR 发布

发布了真正的新显式 tag：

- `ghcr.io/zensgit/metasheet2-backend:20260417-yjs-rollout-r2`
- `ghcr.io/zensgit/metasheet2-web:20260417-yjs-rollout-r2`

说明：

- 本次不再复用 `latest`
- 也不再把 `r1` 视为 Yjs rollout 基线
- `r2` 是基于修复后源码成功构建得到的发布版本
