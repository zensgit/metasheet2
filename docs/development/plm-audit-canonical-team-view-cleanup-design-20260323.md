# PLM Audit Canonical Team View Cleanup Design

Date: 2026-03-23

## Background

`PLM Audit` 页面里的 `team view` 下拉框既承担当前可见选择，也会被本地 `applyRouteState(...)` 预写入。此前页面直接监听 `auditTeamViewKey`，一旦本地下拉值变化，就立即清掉：

- `shared-entry` notice
- `collaboration draft`
- `collaboration followup`

这会把“只是浏览 selector，还没真正切换 canonical route”的场景和“路由真的已经切换”的场景混在一起。

## Problem

在 `?teamViewId=A&auditEntry=share` 的分享链接场景里，用户如果只是把下拉框临时改到 `B`，还没有点击 `Apply`，canonical route 仍然是 `A`，但原来的实现已经把 `shared-entry` / `followup` / `draft` 本地状态销毁了。再切回 `A` 时，这些 transient UI 也不会恢复。

同类问题也会出现在 collaboration flow 上：followup 的真实兼容性本来应当由 canonical route 决定，而不是由未提交的本地下拉值决定。

## Decision

把这类 transient cleanup 从 `auditTeamViewKey` watcher 挪到 canonical route watcher：

1. 本地下拉变化不再直接清理 `shared-entry`、`collaboration draft`、`collaboration followup`。
2. route watcher 同时区分两类变化：
   - `routeChanged`: 当前本地 modeled state 和新 route 是否不同
   - `canonicalRouteChanged`: 前一个实际 URL 和新 URL 是否不同
3. `shared-entry` 和 `collaboration draft` 的销毁条件改为“canonical route 的 `teamViewId` 已经不再指向它们”。
4. `collaboration followup` 的兼容性判断继续走既有 helper，但触发时机改为 `canonicalRouteChanged`，避免本地 `applyRouteState(...)` 预写之后把真实 route 变化吞掉。

## Implementation

涉及文件：

- `apps/web/src/views/PlmAuditView.vue`
- `apps/web/src/views/plmAuditTeamViewShareEntry.ts`
- `apps/web/src/views/plmAuditTeamViewCollaboration.ts`

新增/调整的 helper：

- `shouldKeepPlmAuditTeamViewShareEntry(...)`
- `shouldKeepPlmAuditTeamViewCollaborationDraft(...)`

页面侧改动：

- 删除基于 `auditTeamViewKey` 的 eager cleanup watcher
- 在 route watcher 中基于前后 canonical route 做 cleanup
- 保留 marker-only `auditEntry=share` 过渡的专门处理

## Expected Outcome

- 仅浏览 `team view` selector，不会销毁 share-entry / draft / followup
- 只有 canonical route 真的切换后，这些 transient UI 才会被回收
- 本地 `applyRouteState(...)` 预写入和真实 URL 同步不再互相打架
