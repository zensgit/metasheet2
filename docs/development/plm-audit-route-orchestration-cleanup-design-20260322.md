# PLM Audit Route Orchestration Cleanup Design

Date: 2026-03-22
Branch: `codex/plm-workbench-collab-20260312`

## Goal

Tighten `/plm/audit` route orchestration so transient entry markers and selected team-view lifecycle actions both resolve into a single canonical outcome.

## Problem

Two orchestration gaps still remained after the earlier transient cleanup slices:

1. `auditEntry=share` can re-enter the same canonical audit team-view route while the page is already mounted
2. selected team-view delete/archive/batch actions can locally clear the selected id and sync an intermediate route before pushing the final audit-log route

These are different symptoms of the same problem: route orchestration still had a few paths where transient UI or route state did not collapse directly into the intended canonical outcome.

## Design

### 1. Treat marker-only transitions into `auditEntry=share` as takeover events

`auditEntry` intentionally stays outside `PlmAuditRouteState`.

Because of that, the main route watcher must not treat:

- previous query: no `auditEntry=share`
- next query: same canonical team-view state plus `auditEntry=share`

as a no-op.

Add a small helper in `apps/web/src/views/plmAuditTeamViewShareEntry.ts` that answers:

- route already ready
- no modeled-route delta
- explicit team view still present
- query marker changed from non-share to `share`

When that helper returns true, the watcher should re-run the shared-entry resolution path instead of returning early.

### 2. Clear selected team-view identity locally without syncing an intermediate route

Selected-view lifecycle actions already know their final destination:

- delete -> matching audit-log route
- archive -> matching audit-log route
- batch delete/archive -> matching batch audit-log route

So clearing the selected `teamViewId` should be a local state preparation step, not a separate route sync.

Add a helper in `apps/web/src/views/plmAuditTeamViewRouteState.ts` that clears the selected `teamViewId` from the current audit route state while preserving the rest of the audit filters.

`PlmAuditView.vue` can then:

- locally apply the cleared selection state
- sync once to the final audit-log route

### 3. Keep the final route canonical and single-step

This slice does not change the final audit-log builders.

It only makes sure the page gets there in one canonical route transition instead of:

- clearing selection first
- then pushing the final log route

## Files

- `apps/web/src/views/PlmAuditView.vue`
- `apps/web/src/views/plmAuditTeamViewShareEntry.ts`
- `apps/web/src/views/plmAuditTeamViewRouteState.ts`
- `apps/web/tests/plmAuditTeamViewShareEntry.spec.ts`
- `apps/web/tests/plmAuditTeamViewRouteState.spec.ts`

## Expected Outcome

- opening a shared audit link for the same selected team view can still re-trigger the shared-entry takeover notice
- selected-view delete/archive/batch flows no longer need an intermediate “selection cleared” route
- route watcher and lifecycle actions both converge directly on one canonical outcome

## Non-Goals

- no backend or OpenAPI changes
- no stable audit query-key changes
- no browser-level interaction harness changes
