# PLM BOM / Where-Used State Modules 验证记录

日期: 2026-03-08

## 范围

本轮验证对应以下增量：

- 更新 [PlmProductView.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/PlmProductView.vue)
- 更新 [usePlmBomState.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/usePlmBomState.ts)
- 更新 [usePlmWhereUsedState.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/usePlmWhereUsedState.ts)
- 更新 [plmPanelModels.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/plmPanelModels.ts)
- 新增 [usePlmBomState.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/usePlmBomState.spec.ts)
- 新增 [usePlmWhereUsedState.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/usePlmWhereUsedState.spec.ts)

本轮目标：

- 让 `BOM / Where-Used` 真正切换到 state module
- 保持 `path filter / path export / tree visibility / selection reset` 行为不回退
- 维持 `query sync / localStorage` 与父页的边界

## 包级验证

### 1. 测试

命令：

- `pnpm --filter @metasheet/web test`

结果：

- 通过
- `13 files / 48 tests`

本轮新增覆盖：

- [usePlmBomState.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/usePlmBomState.spec.ts)
- [usePlmWhereUsedState.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/usePlmWhereUsedState.spec.ts)

关键校验：

- `BOM` 的 `path` 字段过滤仍然工作
- `BOM` 表格路径导出仍返回真实路径 ID
- `Where-Used` 选中项能正确收敛为父件 ID
- `Where-Used` payload 替换后会重置 collapsed/selection

### 2. Type Check

命令：

- `pnpm --filter @metasheet/web type-check`

结果：

- 通过

重点校验：

- 父页已成功接入 [usePlmBomState.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/usePlmBomState.ts)
- 父页已成功接入 [usePlmWhereUsedState.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/usePlmWhereUsedState.ts)
- `WhereUsedEntry.relationship.source_id / related_id / parent_id` 的类型已被 [plmPanelModels.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/plmPanelModels.ts) 正式承认

### 3. Lint

命令：

- `pnpm --filter @metasheet/web lint`
- `pnpm lint`

结果：

- 通过

### 4. Build

命令：

- `pnpm --filter @metasheet/web build`

结果：

- 通过

保留提示：

- [featureFlags.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/stores/featureFlags.ts) 仍有动态/静态混合导入 warning
- `apps/web` 仍有大 chunk warning

以上均为既有提示，本轮未新增构建阻断。

## 真实 UI 回归

### 1. 上游可达性

命令：

- `curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:7910/api/v1/health`

结果：

- 返回 `200`

判断：

- 上游 `Yuantus` 仍然可达

### 2. Docker 预检

命令：

- `docker compose -f docker/dev-postgres.yml ps`

结果：

- 未完成
- 命令停在 compose 启动阶段，仅输出 `docker/dev-postgres.yml` 的 `version` obsolete warning
- 需要手动 `pkill` 终止挂起的 compose 进程

判断：

- 本轮新的真实 UI regression 阻塞点仍然是本机 Docker / compose 环境
- 阻塞发生在 regression 脚本真正启动前，不是 `BOM / Where-Used state module` 代码回归

### 3. 当前可引用的最近成功回归

- [verification-plm-ui-regression-20260308_130820.md](/Users/huazhou/Downloads/Github/metasheet2/docs/verification-plm-ui-regression-20260308_130820.md)

## 结论

本轮已经完成并验证：

- `BOM / Where-Used` 父页状态下沉
- `BOM path` 过滤与路径导出语义保留
- `Where-Used` 选择与 payload 重置语义保留
- 包级测试、类型检查、lint、构建、根级 lint 全绿

本轮没有拿到新的真实 UI regression 报告，但已经明确证明：

- 上游 `PLM` 可达
- 环境阻塞点仍在 Docker compose
- 不能把这类阻塞错误归因到本轮前端 state-module 改造
