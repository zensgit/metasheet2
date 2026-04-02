# PLM Workbench Pending Applyability Design

Date: 2026-03-25

## Problem

上一轮把 pending-apply selector drift 下的 generic management action 冻结到了 canonical target，但同时也把 `canApplyTeamView` 绑定到了同一套 management target。

结果是：

1. 当前 canonical/applied target 是 `A`
2. selector 临时切到 `B`
3. `share / rename / delete` 确实应该先冻结
4. 但 `Apply` 按钮也会一起变灰

这会把页面带进一个自锁状态：

- 用户必须先 `Apply`
- 但 `Apply` 自己已经不可点

## Design

### 1. applyability 继续跟 selector target 走

在 [usePlmTeamViews.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/plm/usePlmTeamViews.ts) 里：

- `canApplyTeamView` 不再复用 pending-management 的 target
- 直接改为：
  - `computed(() => canApplyPlmCollaborativeEntry(selectedTeamView.value))`

这样 selector 指向哪个 target，`Apply` 就判断哪个 target 是否可应用。

### 2. management gating 继续只影响真正管理动作

pending-apply drift 期间继续冻结的是：

- `share`
- `rename`
- `delete`
- `archive`
- `restore`
- `transfer`
- `set-default`
- `clear-default`

但不再影响：

- `Apply`
- `Duplicate`

这两条都仍然跟 selector target 保持一致。

## Regression coverage

[usePlmTeamViews.spec.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/tests/usePlmTeamViews.spec.ts) 这轮补了两条 focused 断言：

- pending selector drift 下，`canApplyTeamView` 仍然是 `true`
- `applyTeamView()` 仍能应用 `workbench-pending`，同时 generic management 继续被冻结

## Files

- [usePlmTeamViews.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/plm/usePlmTeamViews.ts)
- [usePlmTeamViews.spec.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/tests/usePlmTeamViews.spec.ts)
- [plm-workbench-pending-apply-management-gating-design-20260325.md](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/docs/development/plm-workbench-pending-apply-management-gating-design-20260325.md)

## Non-goals

- 不放开真正的 generic management action
- 不改变 selector-first 的 `Apply` 合同
- 不改变 duplicate 成功后切到新副本的语义
