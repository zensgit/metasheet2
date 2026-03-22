# PLM Audit Team-View Share-Entry Consumption Design

Date: 2026-03-22
Branch: `codex/plm-workbench-collab-20260312`

## Goal

Make `auditEntry=share` behave like a consumable frontend-only entry marker instead of a sticky query artifact.

## Problem

The shared-link entry slice introduced `auditEntry=share` as a lightweight route marker so `/plm/audit` can explain that the page came from a shared audit team-view link.

Two cleanup gaps still remained:

1. explicit share-entry cleanup paths like `Dismiss`, `Save as local view`, `Apply filters`, `Reset filters`, and pagination could clear the local notice but leave `auditEntry=share` in the URL when the modeled audit route state did not otherwise change
2. when another internal route sync later dropped `auditEntry=share`, the existing share-entry notice could survive for the same `teamViewId` because cleanup only watched filter-navigation and team-view selection changes

That left the transient share-entry notice drifting away from the canonical route.

## Design

### 1. Keep `auditEntry=share` outside `PlmAuditRouteState`

This marker remains a frontend-only entry signal rather than part of the stable audit state contract.

The route-state helpers should continue to model stable audit filters, team-view selection, and scene recovery metadata only.

### 2. Add reducer-backed cleanup for query-marker loss

`apps/web/src/views/plmAuditTeamViewShareEntry.ts` should accept a route-query cleanup action.

When the current query no longer carries `auditEntry=share`, the shared-entry notice should clear even if the selected team view has not changed.

### 3. Explicit cleanup paths must consume the transient query marker

`apps/web/src/views/PlmAuditView.vue` should keep a small helper that re-syncs the current modeled audit state while explicitly consuming the shared-entry marker.

This helper should be used by cleanup paths that intentionally move past the shared-link entry:

- dismissing the shared-entry notice
- saving the shared entry as a local view
- apply-filters navigation
- reset-filters navigation
- page navigation

### 4. Do not consume the marker during initial shared-link resolution

The explicit shared-link entry path still needs the marker long enough to raise the notice in the first place.

Because of that, shared-entry consumption should stay opt-in on explicit cleanup paths instead of becoming a global `syncRouteState()` behavior.

## Files

- `apps/web/src/views/plmAuditTeamViewShareEntry.ts`
- `apps/web/src/views/PlmAuditView.vue`
- `apps/web/tests/plmAuditTeamViewShareEntry.spec.ts`

## Expected Outcome

- shared-entry notice clears when the share marker disappears from the route
- explicit shared-entry cleanup paths also remove `auditEntry=share` from the URL even when the stable audit state does not change
- same-team shared-entry notice no longer survives after the route has already moved past the entry marker

## Non-Goals

- no backend or OpenAPI changes
- no route-key renames
- no browser-level interaction harness changes
