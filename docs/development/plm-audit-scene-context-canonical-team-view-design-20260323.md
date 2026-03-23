# PLM Audit Scene Context Canonical Team View Design

## Context

`PLM Audit` 里的 scene-context 动作已经收口到 scene metadata 和 canonical route，但本地下拉里的 `Team views` selector 仍然可能在未 `Apply` 的情况下漂移。前一轮已经把 filter navigation、shared-entry cleanup 和 generic management controls 从这种 selector drift 中隔离出来；这轮剩下的是 scene-context 自己的动作：

- `Clear context`
- `Show owner activity`
- `Restore scene filter`
- `Save scene view`
- `Save scene to team / Save scene as default`
- source=`scene-context` 的本地 saved-view followup

这些动作如果继续直接读 `readCurrentRouteState()`，就会把未提交的 `teamViewId` 草稿混入 canonical scene route 或 scene save snapshot。

## Goal

让 scene-context 相关动作继续保留当前筛选/场景语义，但 `teamViewId` 一律回到 canonical route owner；未 `Apply` 的 team-view selector 只能留在本地表单层，不能变成 scene 操作的持久化结果。

## Design

### 1. Scene route actions use canonical team-view ownership

`clear / owner / scene` 三个 scene-context route action 改为基于 `readCanonicalTeamViewRouteState()` 构建下一跳 state：

- 当前输入框里的 scene/filter draft 仍然生效
- `teamViewId` 由 canonical route 决定，而不是由本地下拉决定

这样用户在切换 Team views 下拉但不点 `Apply` 时，点击 scene banner 的动作只会改变 scene 上下文，不会顺手把 selector 漂移写回 URL。

### 2. Scene save actions ignore selector drift

`Save scene view` 和 `Save scene to team/default` 在归一化 scene query 前，先回到 canonical team-view ownership，再生成 scene snapshot。

结果是：

- scene save 继续保存 canonical scene query / owner query
- 但不会把未提交的 `teamViewId` 草稿一起保存进 saved view

### 3. Scene-context local saves keep current filters but not local team-view drift

`resolvePlmAuditSavedViewLocalSaveState()` 对 source=`scene-context` 的行为改为：

- 保留当前筛选草稿
- 仅把 `teamViewId` 回退到 canonical route owner

也就是 scene-context 的 generic local save 仍然允许“保存当前筛选后的 scene audit”，但不会把未 `Apply` 的 selector 漂移当成已提交状态。

## Files

- `/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/PlmAuditView.vue`
- `/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/plmAuditSavedViewShareFollowup.ts`
- `/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/tests/plmAuditSavedViewShareFollowup.spec.ts`

## Non-Goals

- 不改变 scene save 的 query 归一化规则。
- 不把 generic `Save current view` 变成强制 canonical route save。
- 不改 team-view persistence contract 或 collaboration provenance 文案。
