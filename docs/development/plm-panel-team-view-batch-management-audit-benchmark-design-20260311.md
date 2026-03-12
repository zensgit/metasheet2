# PLM Panel Team View Batch Management Audit 设计记录

日期: 2026-03-11

## 目标

为 `Documents / CAD / Approvals team view` 增加 owner-only 的批量管理能力，并把批量动作收进后端结构化审计。

本轮目标有四条：

1. `Documents / CAD / Approvals` 三类 panel team view 支持批量 `归档 / 恢复 / 删除`
2. 批量动作必须保持现有 deep link 语义：
   - 当前显式 `documentTeamView / cadTeamView / approvalsTeamView` 被归档或删除后，应退出 URL
   - 批量恢复后，如果恢复的是当前 identity，同一个 id 应重新写回 URL
3. 非法 id、只读 id、跨 owner id 不能把整批请求打挂，必须进入 `skippedIds`
4. live backend 必须输出可检索的结构化审计日志，便于后续批量治理和问题追踪

## 对标基线

当前 `/plm` 已有两类协作对象：

1. `team preset`
2. `panel / workbench team view`

其中 `team preset` 已先具备批量生命周期和审计闭环；`Documents / CAD / Approvals team view` 虽然已经支持逐条：

- `save / apply / share`
- `duplicate / rename`
- `default / clear default`
- `archive / restore`
- `owner transfer`

但还缺一个能支撑真实协作治理的批量面：

- owner 想一次性整理多个历史 panel view 时，必须逐条点
- archived/readonly 状态分散在单条动作里，管理成本高
- 后端没有统一的 team view batch audit 记录

## 方案

### 1. 后端统一批量路由

新增：

- [plm-workbench.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/src/routes/plm-workbench.ts)
  - `POST /api/plm-workbench/views/team/batch`

请求模型：

- `action`: `archive | restore | delete`
- `ids`: `string[]`

响应模型：

- `processedIds`
- `skippedIds`
- `items`
- `metadata.requestedTotal`
- `metadata.processedTotal`
- `metadata.skippedTotal`
- `metadata.processedKinds`

处理规则：

1. 非法 UUID 不参与查询，直接进入 `skippedIds`
2. 仅 owner 可处理
3. `archive` 仅处理当前未归档项
4. `restore` 仅处理当前已归档项
5. `delete` 处理当前 owner 的任意可删项

### 2. 审计模型

在 route 中新增：

- `logPlmTeamViewBatchAudit`

日志字段：

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

这次不单独上审计表，先走结构化日志，和现有 `PLM` 治理线保持一致。

### 3. 前端批量状态与动作

在 [usePlmTeamViews.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/usePlmTeamViews.ts) 中新增：

- `showTeamViewManager`
- `teamViewSelection`
- `selectedTeamViewEntries`
- `teamViewSelectionCount`
- `selectedBatchArchivableTeamViewIds`
- `selectedBatchRestorableTeamViewIds`
- `selectedBatchDeletableTeamViewIds`
- `selectAllTeamViews`
- `clearTeamViewSelection`
- `archiveTeamViewSelection`
- `restoreTeamViewSelection`
- `deleteTeamViewSelection`

目标是把批量生命周期保持在同一条 composable 里，不把 URL 清理逻辑散回页面组件。

### 4. 统一 block UI

在 [PlmTeamViewsBlock.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/components/plm/PlmTeamViewsBlock.vue) 增加统一批量管理入口：

- `批量管理`
- `全选可管理`
- `清空选择`
- `批量归档`
- `批量恢复`
- `批量删除`

`Documents / CAD / Approvals` 三个面板都只透传参数，不各自复制 UI。

### 5. URL 一致性约束

批量动作必须沿用现有 identity 规则：

1. 如果当前选中的是显式 `documentTeamView / cadTeamView / approvalsTeamView`
2. 且该 id 被 `archive / delete`
3. 则只清除对应 panel 的 team view identity
4. 当前 panel state 继续保留

恢复规则：

1. 批量恢复后，如果恢复项正好是当前显式 identity
2. 应再次 `applyView(saved)`
3. 并把同一个 team view id 回写到 URL

## 超越目标

这轮不是单纯把单条动作放进循环。

真正超过普通批量按钮的点有三条：

1. team view batch 和 team preset batch 语义对齐，后续协作治理不会分叉
2. URL 身份与批量生命周期完全一致，不会因为批量动作丢失显式 deep link
3. live backend 有了结构化 `plm-team-view-batch` 审计线，后续可以直接接审计与批量治理报表

## 非目标

本轮不做：

1. 跨 owner 的批量接管
2. archive 后自动批量 restore 当前全部 panel
3. 后台审计 UI
4. workbench team view 与 panel team view 的统一批量管理页

## 验证计划

代码级：

- [plm-workbench-routes.test.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/tests/unit/plm-workbench-routes.test.ts)
- [plmWorkbenchClient.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/plmWorkbenchClient.spec.ts)
- [usePlmTeamViews.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/usePlmTeamViews.spec.ts)
- `pnpm --filter @metasheet/core-backend build`
- `pnpm --filter @metasheet/web test`
- `pnpm --filter @metasheet/web type-check`
- `pnpm --filter @metasheet/web lint`
- `pnpm --filter @metasheet/web build`
- `pnpm lint`

live/browser：

1. 创建 documents/cad/approvals 三类 team view
2. Documents 批量归档，确认 `documentTeamView` 退出 URL
3. 重新应用同一 documents team view，确认 id 回写 URL
4. Approvals 批量删除，确认 `approvalsTeamView` 退出 URL，`approvalsFilter / approvalComment` 保留
5. 记录 backend batch audit 日志

cleanup：

清理本轮临时 team view，确认 live 列表恢复。
