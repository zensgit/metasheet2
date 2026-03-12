# PLM Collaborative Audit Page 设计记录

日期: 2026-03-11

## 目标

把 `PLM team preset` 与 `PLM team view` 已存在的批量治理线，收成一个真正可查询、可验证、可回归的工作台审计页，而不是继续停留在零散日志和独立 artifact。

本轮目标有五条：

1. 批量 `归档 / 恢复 / 删除` 必须统一落到可查询的 `operation_audit_logs`
2. `team preset` 与 `team view` 要沿用同一资源模型，不能分成两套审计页
3. `/plm/audit` 需要直接展示最近窗口内的动作汇总与明细
4. 前端筛选必须支持 `action / resourceType / kind / actor / from / to`
5. live/browser smoke 要能证明页面不是空壳，而是能读到本轮真实批量动作

## 对标基线

在这一轮之前，`PLM` 协作对象虽然已经具备：

- 单对象生命周期
- 批量归档/恢复/删除
- 结构化 `logger.info` 输出
- setup / cleanup artifact

但还缺一层面向产品和验收的统一审计视图：

1. 后端批量治理没有稳定查询入口
2. live 验证要靠读多个 JSON artifact，信息分散
3. `preset` 与 `team view` 的批量行为没有统一 summary
4. 前端缺一个“直接解释最近发生了什么”的工作台页

## 方案

### 1. 审计落库统一到 `operation_audit_logs`

本轮不复用 [audit.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/src/audit/audit.ts) 的抽象写法，因为那条链写的是 `audit_logs`，而本轮查询页目标是现有运维可读的 `operation_audit_logs`。

因此批量治理在 [plm-workbench.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/src/routes/plm-workbench.ts) 中直接写入：

- `resource_type`
  - `plm-team-preset-batch`
  - `plm-team-view-batch`
- `action`
  - `archive`
  - `restore`
  - `delete`
- `meta`
  - `tenantId`
  - `ownerUserId`
  - `requestedIds`
  - `processedIds`
  - `skippedIds`
  - `processedKinds`
  - `requestedTotal`
  - `processedTotal`
  - `skippedTotal`

### 2. 后端提供 audit list + summary 双接口

在 [plm-workbench.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/src/routes/plm-workbench.ts) 新增：

- `GET /api/plm-workbench/audit-logs`
- `GET /api/plm-workbench/audit-logs/summary`

其中：

- `list` 负责明细表
- `summary` 负责顶部汇总卡片与 action/resource bucket

这样页面初始化只需要两次请求，不必在浏览器侧自己聚合全量日志。

### 3. 前端 audit page 单独挂到 `/plm/audit`

新增 [PlmAuditView.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/PlmAuditView.vue)，并在：

- [main.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/main.ts)
- [App.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/App.vue)

把它接成正式工作台入口，而不是调试页。

页面信息分三层：

1. 顶部 summary cards
2. action/resource bucket pills
3. 明细表 + meta 展开

### 4. 复用已有 PLM client 体系

在 [plmWorkbenchClient.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/services/plm/plmWorkbenchClient.ts) 新增：

- `listPlmCollaborativeAuditLogs`
- `getPlmCollaborativeAuditSummary`

并把后端 `meta` 正规化成前端可直接展示的 typed model，避免 `PlmAuditView` 直接处理原始 `Record<string, unknown>`。

### 5. 超越目标

这轮不只是“多了一个审计页”，而是把 `PLM` 协作治理从可操作推进到可解释：

1. `team preset` 与 `team view` 的批量治理已经收进同一审计域
2. 真实批量动作可被 summary 直接统计，而不只是埋在 JSON 里
3. `/plm/audit` 已成为 `PLM workbench` 的稳定导航页
4. live smoke 能证明页面读到的是本轮真实动作，而不是 mock 数据

## 非目标

本轮不做：

1. 单对象级别的细粒度历史 diff
2. 跨 `PLM` 全对象统一审计中心
3. CSV 导出
4. 自定义 dashboard 组件
5. 非批量协作操作的审计回放

## 验证计划

代码级：

- [plm-workbench-routes.test.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/tests/unit/plm-workbench-routes.test.ts)
- [plm-workbench-audit-routes.test.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/tests/unit/plm-workbench-audit-routes.test.ts)
- [plmWorkbenchClient.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/plmWorkbenchClient.spec.ts)
- `pnpm --filter @metasheet/core-backend exec vitest run tests/unit/plm-workbench-routes.test.ts tests/unit/plm-workbench-audit-routes.test.ts`
- `pnpm --filter @metasheet/core-backend build`
- `pnpm --filter @metasheet/web exec vitest run tests/plmWorkbenchClient.spec.ts --watch=false`
- `pnpm --filter @metasheet/web test`
- `pnpm --filter @metasheet/web type-check`
- `pnpm --filter @metasheet/web lint`
- `pnpm --filter @metasheet/web build`
- `pnpm lint`

live/browser：

1. 创建临时 `BOM team preset`
2. 创建临时 `documents team view`
3. 分别触发 `archive / restore / delete`
4. 打开 `/plm/audit`
5. 确认页面显示 6 条动作、2 个资源桶、3 个动作桶
6. 清理临时数据并确认列表回到空集
