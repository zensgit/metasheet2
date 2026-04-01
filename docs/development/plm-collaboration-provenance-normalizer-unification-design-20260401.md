# PLM Collaboration Provenance Normalizer Unification

## Problem

`plmAuditTeamViewCollaboration.ts` now exposes
`resolvePlmAuditTeamViewCollaborationSourceRecommendationFilter(...)` as the
canonical rule for recommendation provenance.

But two core builders still reimplemented the same normalization inline:

- `buildPlmAuditTeamViewCollaborationDraft(...)`
- `buildPlmAuditTeamViewCollaborationFollowup(...)`

That meant the view layer and the helper layer could drift again even though
they were supposed to share one provenance contract.

## Design

Replace the duplicated inline rule with the canonical helper in both builders.

The shared rule is:

- recommendation source + explicit filter => preserve that filter
- recommendation source + missing filter => normalize to `''`
- non-recommendation source => normalize to `undefined`

This keeps the provenance contract single-sourced across:

- direct recommendation actions in `PlmAuditView.vue`
- draft creation
- followup creation

## Scope

Only the collaboration helper and its focused spec change.
No route, attention, or share-entry behavior changes.

## Files

- `apps/web/src/views/plmAuditTeamViewCollaboration.ts`
- `apps/web/tests/plmAuditTeamViewCollaboration.spec.ts`
