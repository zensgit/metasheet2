# PLM Audit Removed Team View Ownership Cleanup Design

## Context

`PLM Audit` 里已经把 canonical owner 收口到 route、followup 和 shared-entry 三套来源，但删除 team view 时还残留一个缺口：

- notice 会因为找不到 view 而消失
- 但 collaboration followup / draft / shared-entry 的内部 ownership state 仍可能保留着被删 view 的 id

这在 generic `Delete` 路径上最明显。当前页面如果正停在 followup/log route，上下文仍归属于 team view `A`，用户从 Team views controls 直接删除 `A` 后：

- followup notice 会消失
- 但 followup ownership 还在
- 之后只要本地下拉切到 `B`，generic controls 会继续被一个已经不存在的 canonical owner 锁住

## Goal

team view 一旦被删除，就同时清掉所有指向这个 view 的 transient ownership：

- collaboration draft
- collaboration followup
- shared-entry owner

## Design

### 1. Pure pruning helpers

新增纯 helper，把“removed team view ids -> transient ownership cleanup”变成可测试逻辑：

- collaboration draft: 删除目标 view 时返回 `null`
- collaboration followup: 删除目标 view 时返回 `null`
- shared-entry: 删除目标 view 时返回 `null`

### 2. Centralized removal path

`removeAuditTeamViews()` 改成统一负责两件事：

- 从列表和 selection 里移除 deleted ids
- 同步裁掉同 id 的 draft / followup / shared-entry ownership

这样 generic delete 和 batch delete 都会走同一套 cleanup，不再依赖 route watcher 的副作用。

### 3. Generic delete no longer leaves invisible owners behind

`deleteAuditTeamView()` 改为复用 `removeAuditTeamViews([view.id])`，而不是只更新列表本身。这样在 route 没变化时，也不会留下一个 UI 上已经看不见、但仍在内部 ownership resolver 里的 deleted view id。

## Files

- `/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/PlmAuditView.vue`
- `/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/plmAuditTeamViewCollaboration.ts`
- `/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/plmAuditTeamViewShareEntry.ts`
- `/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/tests/plmAuditTeamViewCollaboration.spec.ts`
- `/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/tests/plmAuditTeamViewShareEntry.spec.ts`

## Non-Goals

- 不改变 delete 后是否切日志 route 的现有策略。
- 不调整 delete 权限逻辑。
- 不改变 saved-view source pruning 规则。
