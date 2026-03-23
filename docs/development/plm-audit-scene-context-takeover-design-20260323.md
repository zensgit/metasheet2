# PLM Audit Scene-Context Takeover Design

## Background

`PLM Audit` 里的 scene banner / scene token 动作会把页面重新切到 scene-owned route：

- `Clear context`
- `Show owner activity`
- `Restore scene filter`

前两轮已经把：

- `Apply saved view`
- saved-view context quick action

都接到了统一的 takeover cleanup。

## Problem

在本次修改前，scene-context 动作仍保留独立编排：

- 直接构造新的 scene route
- 直接 `syncRouteState(...)`

它不会先清 collaboration draft / followup。

这会在下面这类路径里留下真实残留：

1. recommendation 先创建 collaboration draft
2. draft 自动装出单行 selection
3. 用户通过 scene banner 切到 owner activity / scene query / clear context
4. 如果这次 route pivot 不改 canonical `teamViewId`，watcher 不会帮忙清 draft

结果页面会进入新的 scene route，但旧 collaboration draft 和它自动装出来的单行 selection 还留着。

## Decision

把 scene-context route pivots 也并入现有的 collaboration takeover 合同：

- 清 draft
- 清 followup
- 只消费 draft 自动装出来的单行 selection
- 不误清用户后续改过的多选

不新增第三套独立清理语义，而是复用已经稳定的 saved-view takeover contract。

## Implementation

Files:

- `apps/web/src/views/PlmAuditView.vue`
- `apps/web/tests/plmAuditTeamViewCollaboration.spec.ts`

Key changes:

- 页面层新增 `applyCollaborationTakeoverCleanup()`
- scene banner 的 `clear / owner / restore scene` 三个动作在 route sync 前统一调用这套 cleanup
- `applySavedViewTakeover(...)` 也改为复用同一页内 helper，避免再次分叉
- focused regression 补一条 route-takeover 场景，锁住“draft-owned single selection 会被 takeover 清掉”

## Expected Behavior

- scene-context route pivots 不再留下旧 collaboration draft
- draft 自动装出的单行 selection 会和 draft 一起被回收
- saved-view takeover 和 scene-context takeover 现在共享同一套 collaboration cleanup 合同
