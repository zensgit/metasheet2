# PLM Audit External Lifecycle Log-Route Draft Cleanup Design

## Problem

上一刀已经收掉了本地 lifecycle/default-log 按钮把页面切进 ownerless log route 时残留的 management-owned form drafts。

但浏览器回退、外部 deep link、以及其他非本地 `syncRouteState(...)` 触发的 route pivot 仍然走 `route.query` watcher。这个 watcher 只使用 `resolvePlmAuditCanonicalTeamViewFormDraftState(...)`，会在 `teamViewId -> ''` 时保留 `auditTeamViewName` 和 `auditTeamViewNameOwnerId`。结果是页面已经进入 ownerless lifecycle log route，旧的 rename/save-to-team 草稿还留在输入框里。

## Design

- 保持 canonical-owner watcher 的通用语义不变，继续允许普通 owner 变化保留 name draft。
- 在 `plmAuditTeamViewAudit.ts` 中新增纯 helper `isPlmAuditOwnerlessTeamViewLifecycleLogRoute(...)`，只识别这些 ownerless log routes：
  - `clear-default` + `plm-team-view-default`
  - `archive / restore / delete` + `plm-team-view-batch`
- 在 `PlmAuditView.vue` 的 `route.query` watcher 中：
  - 先根据 `previousRouteState` 和当前 followup 计算上一个 canonical management owner
  - 如果这次 canonical route 变化进入了 ownerless lifecycle log route，并且上一个 canonical owner 非空，则显式调用 `clearAuditLogRouteTakeoverTeamViewFormDrafts()`

## Expected Outcome

- 本地 lifecycle 按钮和外部 lifecycle log-route pivot 共享同一套 form-draft cleanup 合同。
- 普通 owner 变化、create-mode 草稿、以及 `set-default` followup 继续保持原语义。
- 这次变更只补 ownerless lifecycle log-route，不扩大到所有 ownerless routes。
