# PLM Workbench Pending Duplicate Allowance Design

Date: 2026-03-25

## Problem

上一轮在 [usePlmTeamViews.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/plm/usePlmTeamViews.ts) 里把 pending-apply selector drift 下的 generic 管理动作统一冻结了，但也把 `duplicateTeamView()` 一起冻结了。

这和 workbench 既有合同冲突：

- 团队成员可以复制任意可见 team view
- `复制副本` 属于“fork visible entry”能力，不要求当前 route 已经应用到该 target

因此会出现回归：

1. 当前 canonical/applied target 是 `A`
2. selector 临时切到 `B`
3. 用户还没 `Apply`
4. 点击 `复制副本`
5. 代码却要求“请先应用…”，导致不能直接 fork `B`

## Design

### 1. duplicate 继续跟 selector target 走

在 [usePlmTeamViews.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/plm/usePlmTeamViews.ts) 里：

- `duplicateTeamView()` 不再走 `blockPendingApplyManagementAction()`
- `canDuplicateTeamView` 也不再继承 pending-management 的冻结目标
- 改成直接基于当前 `selectedTeamView` 计算 `canDuplicatePlmCollaborativeEntry(...)`

这样 selector 指向哪个 visible target，`复制副本` 就复制哪个 target。

### 2. 只冻结真正的 management actions

pending-apply drift 下继续冻结的是：

- `share`
- `rename`
- `delete`
- `archive`
- `restore`
- `transfer`
- `set-default`
- `clear-default`

因为这些动作会修改原目标本身，必须等 canonical target 对齐后再做。

## Regression coverage

[usePlmTeamViews.spec.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/tests/usePlmTeamViews.spec.ts) 这轮补了两层断言：

- pending-apply drift 下，`canDuplicateTeamView` 仍然是 `true`
- selector 指向 `workbench-pending` 时，不点 `Apply` 也能直接 `duplicate`，并把 route / selection 切到新副本

## Files

- [usePlmTeamViews.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/plm/usePlmTeamViews.ts)
- [usePlmTeamViews.spec.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/tests/usePlmTeamViews.spec.ts)
- [plm-workbench-pending-apply-management-gating-design-20260325.md](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/docs/development/plm-workbench-pending-apply-management-gating-design-20260325.md)

## Non-goals

- 不放开 `share / rename / delete / set-default` 这类真正的 management action
- 不改变 selector-first 的 `Apply` 语义
- 不改变 duplicate 成功后切到新副本 id 的既有合同
