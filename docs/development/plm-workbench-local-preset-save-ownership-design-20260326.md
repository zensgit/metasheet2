# PLM Workbench Local Preset Save Ownership Design

## Date
- 2026-03-26

## Problem
- `PlmProductView.vue` 里的 BOM / Where-Used team preset wrappers 之前会在 mutation 执行前就调用：
  - `clearBomLocalFilterPresetIdentity()`
  - `clearWhereUsedLocalFilterPresetIdentity()`
- 这使得“保存为团队预设”一旦失败，就会提前消费当前本地 preset owner。
- 对 `promote local preset -> team/default team` 这类 wrapper 来说，成功后才消费本地 owner 是正确语义；但 save wrapper 之前和这条合同不一致。

## Design
- 提取共享 helper `runPlmLocalPresetOwnershipAction(...)`：
  - 只有 mutation 成功后才清本地 owner
  - 如果 mutation 抛错，不消费本地 owner
  - 对 promotion 类 action 允许通过 `shouldClear(result)` 仅在返回 surviving target 时清理
- BOM / Where-Used 的以下 wrapper 统一走这条 helper：
  - `save*TeamPreset`
  - `promote*FilterPresetToTeam`
  - `promote*FilterPresetToTeamDefault`

## Intended Result
- `save team preset` 失败时，本地 preset owner 保持不变，页面仍能 round-trip 回原 preset。
- local preset -> team/default 提升链的 owner consumption 语义统一到“只在 mutation 真正产生活跃 target 后才清理”。

## Touched Files
- `apps/web/src/views/plm/plmLocalPresetOwnership.ts`
- `apps/web/src/views/PlmProductView.vue`
- `apps/web/tests/plmLocalPresetOwnership.spec.ts`
