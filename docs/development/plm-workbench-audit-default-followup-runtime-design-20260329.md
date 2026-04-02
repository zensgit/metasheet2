# PLM Workbench Audit Default Followup Runtime Design

## Background

`audit team view set-default` followups are intentionally route-owned after success. Once the UI lands on the ownerless default-change audit route, the followup should remain available as long as that route still matches the original default-change context.

Before this change, apps/web still treated that followup as team-view-owned in three places:

- removed-view pruning dropped the followup as soon as the backing team view disappeared from the refreshed list
- followup notice rendering required resolving the original team view from the current list
- `view-logs` feedback still failed when the team view record was no longer present

That created an internal contract split: route guards said the followup should stay, but runtime cleanup deleted or hid it anyway.

## Design

Keep the existing route contract and align runtime behavior to it:

1. Preserve `set-default` followups during removed-view pruning.
2. Allow the default-change notice to render without a live team-view record.
3. Treat `view-logs` on a `set-default` followup as route-owned, so it stays actionable without a current team-view target.

The `share` followup path remains team-view-owned and keeps the stricter target-required behavior.

## Files

- `apps/web/src/views/plmAuditTeamViewCollaboration.ts`
- `apps/web/src/views/PlmAuditView.vue`
- `apps/web/tests/plmAuditTeamViewCollaboration.spec.ts`
- `apps/web/tests/plmAuditTeamViewOwnership.spec.ts`
