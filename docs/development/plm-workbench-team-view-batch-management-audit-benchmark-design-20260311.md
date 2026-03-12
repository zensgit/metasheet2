# PLM Workbench Team View Batch Management Audit 设计记录

日期: 2026-03-11

## 目标

把已经存在于 `PLM panel team view` 和 `team preset` 的批量治理能力，补到 `workbench team view` 主对象上，并保持同样的 URL identity 与审计语义。

本轮目标有四条：

1. `workbench team view` 支持 owner-only 的批量 `归档 / 恢复 / 删除`
2. 批量动作必须保持 `workbenchTeamView` 的 URL 一致性
3. 当前工作台状态在批量归档/删除后要保留，不能被批量动作顺手清空
4. live backend 继续沿用结构化 `plm-team-view-batch` 审计线，形成同类对象一致的治理证据

## 对标基线

当前 `/plm` 的协作对象已经分成三层：

1. `team preset`
2. `panel team view`
3. `workbench team view`

前两层已经具备：

- `duplicate / rename / share`
- `default / clear default`
- `archive / restore / delete`
- `owner transfer`
- `batch management + audit`

但 `workbench team view` 之前还缺最后一块：

- composable 已有通用批量能力
- backend 也已有通用 `team view batch` route
- 真正缺的是把这套能力接到 `PLM workbench` 头部主块上，并把 URL / live 行为补成闭环

## 方案

### 1. 复用既有批量路由，不再分叉

本轮不新开 route，继续复用：

- [plm-workbench.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/src/routes/plm-workbench.ts)
  - `POST /api/plm-workbench/views/team/batch`

这样 `workbench / documents / cad / approvals` 四类 `team view` 都走同一条批量协议：

- `action: archive | restore | delete`
- `ids: string[]`
- `processedIds / skippedIds / items`
- `metadata.requestedTotal / processedTotal / skippedTotal / processedKinds`

### 2. 把 workbench 批量能力接入 panel contract

在前端 workbench 头部 contract 中新增：

- `hasManageableWorkbenchTeamViews`
- `showWorkbenchTeamViewManager`
- `workbenchTeamViewSelection`
- `workbenchTeamViewSelectionCount`
- `selectedBatchArchivableWorkbenchTeamViewIds`
- `selectedBatchRestorableWorkbenchTeamViewIds`
- `selectedBatchDeletableWorkbenchTeamViewIds`
- `selectAllWorkbenchTeamViews`
- `clearWorkbenchTeamViewSelection`
- `archiveWorkbenchTeamViewSelection`
- `restoreWorkbenchTeamViewSelection`
- `deleteWorkbenchTeamViewSelection`

落点在：

- [plmPanelModels.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/plmPanelModels.ts)
- [usePlmProductPanel.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/usePlmProductPanel.ts)
- [PlmProductPanel.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/components/plm/PlmProductPanel.vue)
- [PlmProductView.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/PlmProductView.vue)

目标是让 `workbench` 也能复用 [PlmTeamViewsBlock.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/components/plm/PlmTeamViewsBlock.vue) 的批量 UI，而不是另写一套。

### 3. URL identity 规则

批量动作沿用单对象生命周期已经打通的规则：

1. 当前 URL 带显式 `workbenchTeamView=<id>`
2. 若该 id 在批量 `archive / delete` 中被处理
3. 只移除 `workbenchTeamView`
4. `documentRole / documentFilter / approvalsFilter / approvalComment / cadReviewState / cadReviewNote` 继续保留

恢复规则：

1. 若恢复集合中包含当前选中的 archived workbench view
2. 则重新 `apply`
3. 把同一个 `workbenchTeamView=<id>` 再写回 URL

### 4. 审计策略

本轮继续复用后端已有结构化审计：

- `audit = plm-team-view-batch`
- `action`
- `tenantId`
- `ownerUserId`
- `requestedIds`
- `processedIds`
- `skippedIds`
- `processedKinds`
- `processedTotal`
- `skippedTotal`

这样 `panel team view` 和 `workbench team view` 的批量治理线不会分叉。

## 超越目标

这轮不是单纯把 `workbench` 接一个“批量管理”按钮。

真正超过普通 UI 补丁的点有三条：

1. `workbench` 已和 `panel team view / team preset` 共享同一批量生命周期模型
2. `workbenchTeamView` 的深链接 identity 与批量归档/恢复/删除完全一致
3. live smoke 能同时证明：
   - 归档后 URL 退场
   - 恢复后同一 id 回写
   - 删除后 identity 清理但 workbench state 保留

## 非目标

本轮不做：

1. `workbench team view` 的批量 `duplicate / rename / transfer`
2. 跨 kind 的统一混合批量管理页
3. 审计单独落库
4. 多租户批量接管

## 验证计划

代码级：

- [plm-workbench-routes.test.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/tests/unit/plm-workbench-routes.test.ts)
- [usePlmTeamViews.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/usePlmTeamViews.spec.ts)
- [usePlmProductPanel.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/usePlmProductPanel.spec.ts)
- [plmWorkbenchClient.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/plmWorkbenchClient.spec.ts)
- `pnpm --filter @metasheet/core-backend exec vitest run tests/unit/plm-workbench-routes.test.ts`
- `pnpm --filter @metasheet/core-backend build`
- `pnpm --filter @metasheet/web test`
- `pnpm --filter @metasheet/web type-check`
- `pnpm --filter @metasheet/web lint`
- `pnpm --filter @metasheet/web build`
- `pnpm lint`

live/browser：

1. 创建 3 条 `workbench team view`
2. 通过显式 `workbenchTeamView` 打开 `/plm`
3. `batch archive` 后确认 `workbenchTeamView` 退出 URL
4. `batch restore` 后确认同一 `workbenchTeamView` id 回写 URL
5. `batch delete` 后确认 `workbenchTeamView` 再次退出 URL，但当前 workbench state 保留

cleanup：

清理本轮临时 `Batch Workbench A/B/C` 数据，确认列表回到 `0`。
