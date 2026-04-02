# PLM Audit Shared-Entry Refresh Selection Cleanup Design

## Problem

`refreshAuditTeamViews()` 在 `requestedSharedEntry + resolution.kind === 'apply-view'` 时会安装新的 shared-entry owner，但之前不会同步清掉旧的 batch selection。结果是页面已经进入单卡 shared-entry notice，上方仍可能保留 “已选 N 项” 和 batch lifecycle controls。

## Design

- 把 shared-entry refresh takeover 视为单一 canonical owner 切换。
- 在安装 shared-entry owner 前，统一清空 `auditTeamViewSelection`。
- 清理只影响 transient batch selection，不改变 shared-entry notice、自身 target、或后续 canonical route apply。
- 将这条语义落成纯 helper `resolvePlmAuditSharedEntryTakeoverSelection(...)`，由 `PlmAuditView.vue` 的 refresh shared-entry 分支显式消费。

## Expected Outcome

- shared-entry notice 不再和旧的 batch lifecycle selection 并存。
- marker-only `auditEntry=share` query change 触发的 refresh takeover 也会获得同样 cleanup。
- 用户如果后续需要多选，只能在 shared-entry takeover 完成后重新主动选择。
