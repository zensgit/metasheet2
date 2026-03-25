# PLM Workbench Team View Apply Takeover Design

Date: 2026-03-25

## Problem

这轮复核命中了两条同源问题，都是 `Apply` takeover 没把页面状态完整收口：

1. pending selector drift 下，当前 canonical/applied target 是只读视角 `A`，selector 临时切到可应用的 `B` 时：
   - `Apply` 和 `Duplicate` 应该继续跟着 `B`
   - 但 generic management controls 仍然应该保持隐藏
   - 否则 readonly 语义会被一个尚未应用的 selector 暂态重新暴露出来
2. 旧 batch selection 在 `applyTeamView()` 成功后不会清掉：
   - 用户先选中 `A/B`
   - 再切 selector 到 `C` 并点击 `Apply`
   - route/state 已经切到 `C`，批量按钮却还在操作 `A/B`

这两条都会让“应用一个新团队视角”之后的页面语义出现混合状态。

## Design

### 1. management visibility 跟 canonical target 走

在 [usePlmTeamViews.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/plm/usePlmTeamViews.ts) 里，把：

- `selectedManagementTarget`
- `visibleManagementTarget`

拆开处理：

- `selectedManagementTarget`
  - pending-apply drift 下仍然返回 `null`
  - 继续冻结真正的 generic management action
- `visibleManagementTarget`
  - pending-apply drift 下回落到 canonical/requested target
  - `showManagementActions` 改为按这个 target 的 manageability 计算

结果是：

- `Apply` / `Duplicate` 继续跟 selector target 走
- readonly canonical target 的 management controls 不会因为 selector drift 被重新显示出来

### 2. successful apply 必须消费旧 batch selection

在 `applyTeamView()` 里，真正 `applyView(view)` 之前先清：

- `teamViewSelection`

这样所有走 `applyTeamView()` 的入口都会统一收口，包括：

- Team views block 里的 `Apply`
- workbench 推荐场景通过 `applyWorkbenchTeamView()` 进入的应用路径

不需要在 scene catalog 或 page layer 另外补 cleanup。

## Regression coverage

[usePlmTeamViews.spec.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/tests/usePlmTeamViews.spec.ts) 这轮补了两条 focused 断言：

- pending selector drift 下，readonly canonical target 仍然隐藏 management controls，同时 `Apply` / `Duplicate` 保持可用
- `applyTeamView()` 成功后会清掉旧 batch selection，并继续正确同步 `requestedViewId` 和应用 state

## Files

- [usePlmTeamViews.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/plm/usePlmTeamViews.ts)
- [usePlmTeamViews.spec.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/tests/usePlmTeamViews.spec.ts)

## Non-goals

- 不放开 pending-apply drift 下真正的 generic management action
- 不改变 selector-first 的 `Apply` / `Duplicate` 合同
- 不改推荐场景卡片或 Team views block 的页面结构
