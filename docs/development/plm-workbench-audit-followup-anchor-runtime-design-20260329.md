# PLM Workbench Audit Followup Anchor Runtime Design

## Problem

`scene-context` audit collaboration followups already had a pure helper that retargeted `sourceAnchorId` from the disappearing scene banner to the persistent team-view controls anchor. But `PlmAuditView` only used that helper transiently while rendering the notice or running the followup action. The persisted `auditTeamViewCollaborationFollowup` ref stayed stale.

That left a runtime split:

- UI/actions operated on a temporary normalized followup
- the stored followup state still pointed at the dead scene anchor

## Design

- Add `resolvePlmAuditTeamViewCollaborationRuntimeFollowup(...)` in `plmAuditTeamViewCollaboration.ts`
  - returns `{ followup, changed }`
  - delegates anchor normalization to the existing sync helper
- In `PlmAuditView.vue`, add a single state-normalizer:
  - normalize the persisted followup against `sceneContextAvailable`
  - write the normalized followup back when `changed === true`
- Use that normalized runtime followup in:
  - followup notice rendering
  - followup action execution
  - a watcher keyed by `auditSceneContext` visibility and the followup ref

## Why This Shape

- It preserves the existing followup semantics and only fixes persistence.
- It keeps the runtime contract unit-testable without introducing a component-only hidden rule.
- It prevents stale anchors from surviving refreshes, route cleanup, and later focus-source actions.
