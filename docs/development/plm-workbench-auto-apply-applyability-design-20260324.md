# PLM Workbench Auto-Apply Applyability Design

Date: 2026-03-24

## Problem

[usePlmTeamViews.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/plm/usePlmTeamViews.ts) 的 `maybeAutoApplyDefault(...)` 之前没有和显式 `applyTeamView()` 对齐 `canApply` 合同。

具体有两条 bypass：

- `requestedViewId` 分支只检查 `id` 和 `!isArchived`
- `default` 分支只检查 `isDefault`

这意味着 refresh、deep link、默认自动应用三条路径都可能把一个 `permissions.canApply === false` 的 team view 自动写成当前 active view，并直接应用它的 state。显式 `Apply` 已经修过这类问题，但自动应用仍然绕过了同一层权限语义。

这轮我并行用了 `Claude Code` 做只读校验，它也独立确认了这条 bypass。

## Design

### 1. 让自动应用复用显式 apply 的同一 helper

[usePlmTeamViews.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/plm/usePlmTeamViews.ts) 已经导入了：

- `canApplyPlmCollaborativeEntry(...)`

这轮不新增第二套判定，直接让 `maybeAutoApplyDefault(...)` 复用这条 helper。

### 2. requested auto-apply 只接受真正可应用的候选

`requestedViewId` 分支现在只有在下面条件同时满足时才会 auto-apply：

- `entry.id === requestedViewId`
- `!entry.isArchived`
- `canApplyPlmCollaborativeEntry(entry)`

如果 requested view 仍存在但已不可 apply，就不再把它写成当前 active view，而是走现有 fallback 逻辑。

### 3. default auto-apply 也接入相同 gating

默认视图分支现在同样要求：

- `entry.isDefault`
- `!entry.isArchived`
- `canApplyPlmCollaborativeEntry(entry)`

这样默认自动应用不再绕过 permissions contract。

### 4. 回归覆盖两条自动路径

[usePlmTeamViews.spec.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/tests/usePlmTeamViews.spec.ts) 这轮新增两类断言：

- requested team view 不可 apply 时，会回退到可 apply 的 default
- default team view 不可 apply 时，不会自动应用

## Files

- [usePlmTeamViews.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/plm/usePlmTeamViews.ts)
- [usePlmTeamViews.spec.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/tests/usePlmTeamViews.spec.ts)

## Non-goals

- 不改变显式 `Apply` 的 handler 语义
- 不改变 default team view 的排序规则
- 不改后端权限或返回结构
