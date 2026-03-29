# PLM Workbench Audit Default Action Draft Cleanup Design

## Problem

`audit team view set-default` succeeds by pivoting the route into an ownerless default-action log state, but its success path did not clear completed form drafts. That left stale `name / ownerUserId` drafts attached to the next canonical audit team-view target even though other completed lifecycle mutations already clear them.

This is intentionally stricter than generic log-route takeover behavior. Generic log-route takeover may preserve ownerless create-mode drafts; successful default actions should not.

## Design

Introduce a dedicated cleanup contract:

- `resolvePlmAuditDefaultActionTeamViewFormDraftState(...)`

This always returns the completed lifecycle cleanup state, even when the current draft is ownerless create-mode input. `PlmAuditView.vue` now uses that contract on the successful `setAuditTeamViewDefaultEntry(...)` path.

## Scope

- `apps/web/src/views/plmAuditTeamViewOwnership.ts`
- `apps/web/src/views/PlmAuditView.vue`
- `apps/web/tests/plmAuditTeamViewOwnership.spec.ts`
