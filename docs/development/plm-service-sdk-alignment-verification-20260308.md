# PLM Service / SDK Alignment 验证记录

日期: 2026-03-08

## 范围

本轮验证对应以下增量：

- 更新 [PlmService.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/services/PlmService.ts)
- 更新 [apps/web/package.json](/Users/huazhou/Downloads/Github/metasheet2/apps/web/package.json)
- 更新 [pnpm-workspace.yaml](/Users/huazhou/Downloads/Github/metasheet2/pnpm-workspace.yaml)
- 更新 [client.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/openapi/dist-sdk/client.ts)
- 更新 [client.js](/Users/huazhou/Downloads/Github/metasheet2/packages/openapi/dist-sdk/client.js)
- 更新 [client.d.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/openapi/dist-sdk/client.d.ts)
- 更新 [tests/client.test.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/openapi/dist-sdk/tests/client.test.ts)
- 更新 [build.mjs](/Users/huazhou/Downloads/Github/metasheet2/packages/openapi/dist-sdk/scripts/build.mjs)

本轮目标：

- 前端 `PLM` 请求收口到 SDK helper
- `@metasheet/sdk` 成为当前 workspace 可依赖包
- `client.ts -> client.js / client.d.ts` 重建链打通

## 工程验证

### 1. Workspace / Install

命令：

- `pnpm install`

结果：

- 通过

关键点：

- `@metasheet/sdk@workspace:*` 现在能被 `apps/web` 解析
- 初次尝试时发现 `dist-sdk` 不在 workspace；本轮已通过 [pnpm-workspace.yaml](/Users/huazhou/Downloads/Github/metasheet2/pnpm-workspace.yaml) 修正

### 2. SDK Build

命令：

- `pnpm --dir packages/openapi/dist-sdk build`

结果：

- 通过

关键点：

- `client.js`
- `client.d.ts`

现已随 build 同步更新，不再停留在旧产物。

### 3. SDK Test

命令：

- `pnpm --filter @metasheet/sdk test`

结果：

- 通过
- `1 file / 6 tests`

重点校验：

- `compareBom` 现已透传 `includeChildFields`
- `PLM federation helper` 的 query/mutate 负载仍与之前保持兼容

### 4. Frontend Test

命令：

- `pnpm --filter @metasheet/web test`

结果：

- 通过
- `13 files / 48 tests`

重点校验：

- [plmService.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/plmService.spec.ts) 仍验证：
  - 产品搜索走 query endpoint
  - 产品详情 / BOM 走编码后的 GET route
  - `approvals` 默认分页与 `all` 状态过滤兼容
  - 上游错误消息与本地 fallback 行为保持稳定

### 5. Frontend Type Check

命令：

- `pnpm --filter @metasheet/web type-check`

结果：

- 通过

### 6. Frontend Lint

命令：

- `pnpm --filter @metasheet/web lint`
- `pnpm lint`

结果：

- 通过

### 7. Frontend Build

命令：

- `pnpm --filter @metasheet/web build`

结果：

- 通过

保留提示：

- [featureFlags.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/stores/featureFlags.ts) 仍有动态/静态混合导入 warning
- `apps/web` 仍有大 chunk warning

以上均为既有提示，本轮未新增构建阻断。

## 轻量联调前置检查

### 1. 上游健康

命令：

- `curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:7910/api/v1/health`

结果：

- 返回 `200`

判断：

- 上游 `Yuantus` 可达

### 2. Docker Compose 预检

命令：

- `docker compose -f docker/dev-postgres.yml ps`

结果：

- 未完成
- 仅输出 `docker/dev-postgres.yml` 的 `version` obsolete warning 后挂起
- 需要手动 `pkill` 清理 compose 进程

判断：

- 本轮仍不适合把 UI regression 失败归因到 `service -> sdk` 改造
- 阻塞点依然是本机 Docker / compose 环境

当前最近一次成功回归仍是：

- [verification-plm-ui-regression-20260308_130820.md](/Users/huazhou/Downloads/Github/metasheet2/docs/verification-plm-ui-regression-20260308_130820.md)

## 结论

本轮已经闭环：

- `apps/web` 已开始真实消费 SDK helper
- `@metasheet/sdk` 已成为 workspace 内可依赖包
- SDK 的 `client.ts -> client.js / client.d.ts` 构建链已补齐
- SDK、前端测试、类型检查、lint、构建均通过

所以这轮不是“又多一个抽象层”，而是把原来分叉的前端联邦调用和 SDK 契约真正收成了一条工程链。
