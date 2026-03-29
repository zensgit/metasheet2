# PLM Workbench Audit Lifecycle Log Draft Cleanup Design

## Problem

Several successful audit team-view lifecycle mutations pivot the page into ownerless log routes:

- clear default
- delete
- archive
- restore
- batch archive / restore / delete

Those paths were still using the passive log-route takeover cleanup contract, which preserves ownerless create-mode drafts. That is correct for route hydration, but wrong for explicit successful mutations. After the mutation succeeds, stale create/owner drafts should not remain attached to the next canonical management target.

## Design

Introduce a dedicated lifecycle-log cleanup contract:

- `resolvePlmAuditLifecycleLogActionFormDraftState(...)`

This always resolves to completed lifecycle cleanup. `PlmAuditView.vue` now uses it only for explicit successful lifecycle actions that intentionally route into ownerless audit logs. Passive log-route takeover continues to use the existing, more permissive contract.

## Scope

- `apps/web/src/views/plmAuditTeamViewOwnership.ts`
- `apps/web/src/views/PlmAuditView.vue`
- `apps/web/tests/plmAuditTeamViewOwnership.spec.ts`
