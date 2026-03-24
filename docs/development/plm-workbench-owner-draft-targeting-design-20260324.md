# PLM Workbench Owner Draft Targeting Design

Date: 2026-03-24

## Problem

[usePlmTeamViews.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/plm/usePlmTeamViews.ts) 里的 `teamViewOwnerUserId` 代表 transfer-owner draft，但之前它只会在以下情况下清空：

- 当前 view 失去 manageability
- refresh / delete / archive / batch archive 清掉当前选择
- transfer 成功

这导致两类残留：

- `duplicate` / `apply` 切到另一条 team view 时，旧 owner draft 会跟着迁移
- `saveTeamView()` 从 create-mode 保存新 view 时， stray owner draft 也会被带到新保存的 view 上

结果是 transfer-owner 的草稿会脱离原始 target，成为典型的 stale management draft。

## Design

### 1. `applyView(...)` 只要切到新 id，就清 owner draft

在 [usePlmTeamViews.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/plm/usePlmTeamViews.ts) 里，`applyView(view)` 现在在真正改 `teamViewKey` 之前先判断：

- 当前 `teamViewKey` 非空
- 且当前 id 与 `view.id` 不同

满足时清空：

- `teamViewOwnerUserId.value = ''`

这样 `apply existing view`、`duplicate`、`restore to another id` 一类“切换目标 view”的路径都统一收口。

### 2. `saveTeamView()` 成功后也清 owner draft

`saveTeamView()` 是从 create-mode 生成新 team view 的路径。即使之前没有显式选中 team view， stray owner draft 也不应该被带进新保存的管理目标。

因此保存成功后，除了已有的 `teamViewName.value = ''`，现在也同步清掉：

- `teamViewOwnerUserId.value = ''`

### 3. 不改变 rename / transfer 成功后同 id 的草稿语义

这轮不额外清：

- rename 后的 name draft
- transfer 成功以外的同 id owner draft

核心合同只有一条：

- owner draft 不能跨 team view target 迁移

## Regression coverage

[usePlmTeamViews.spec.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/tests/usePlmTeamViews.spec.ts) 这轮锁住：

- `saveTeamView()` 成功后会清掉 stray owner draft
- `duplicateTeamView()` 切到新 id 后会清掉旧 owner draft

## Files

- [usePlmTeamViews.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/plm/usePlmTeamViews.ts)
- [usePlmTeamViews.spec.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/tests/usePlmTeamViews.spec.ts)

## Non-goals

- 不改变 transfer-owner 的权限 gating
- 不修改 `PlmTeamViewsBlock.vue` 的 owner 输入显隐
- 不改变同 id view 上的 rename/save draft 行为
