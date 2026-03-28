# PLM Workbench Rename Actionability Parity Design

## Context

上一轮已经把 `transfer` handler 的判断顺序拉齐成“先判 target 是否允许，再判输入是否完整”。继续对照后发现，`rename` 在 `team views` 和 `team presets` 上仍保留同型分叉：

- UI 上 rename 按钮已经 disabled
- 直接调用 handler 时却可能先报 `请输入...名称`
- 真实阻塞原因其实是 target 只读、已归档，或显式 `permissions.canRename = false`

## Problem

当前 `rename` 还在用“名称输入是否为空”驱动第一层分支，导致 denied target 上会把权限问题误报成表单问题。

这会产生两类坏结果：

- 只读 target：应该先报 `仅创建者可重命名...`
- granular denial target：应该先报 `当前...不可重命名。`

但现有实现会先落到 `请输入...名称。`

## Design

把 `rename` 统一成两层判断：

1. `canRenameTarget*`
   - 基于 target 自身是否允许 rename
   - 不依赖名称输入
   - archived / readonly / explicit denial 都在这层返回真实原因
2. `canRename*`
   - 在 target 已允许的前提下，再叠加 `nameRef.trim()` 的提交就绪条件

为避免重复逻辑，在 `usePlmCollaborativePermissions.ts` 提取 `canRenamePlmCollaborativeEntry(...)`，由：

- `usePlmTeamViews.ts`
- `usePlmTeamFilterPresets.ts`

共同复用。

## Scope

- `apps/web/src/views/plm/usePlmCollaborativePermissions.ts`
- `apps/web/src/views/plm/usePlmTeamViews.ts`
- `apps/web/src/views/plm/usePlmTeamFilterPresets.ts`
- `apps/web/tests/usePlmTeamViews.spec.ts`
- `apps/web/tests/usePlmTeamFilterPresets.spec.ts`

## Expected Outcome

`rename` handler 将和 `transfer` 一样先返回真实 actionability denial，不再在 denied target 上误报名称输入缺失，前端 handler 语义与按钮 disabled 状态保持一致。
