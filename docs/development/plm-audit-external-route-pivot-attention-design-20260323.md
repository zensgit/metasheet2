# PLM Audit External Route Pivot Attention Design

Date: 2026-03-23

## Goal

Make browser back/forward and other external `/plm/audit` route pivots clear transient attention the same way local filter and pagination actions already do.

## Problem

Local route pivots such as:

- `Apply filters`
- `Reset filters`
- pagination

already clear transient attention before syncing the next route.

But the main `route.query` watcher only cleared saved-view attention and incompatible collaboration followups. It did not mirror the same management/recommendation focus cleanup when the route change came from outside the page, such as browser back/forward or another external route push.

That left one remaining residue:

1. the page installed transient recommendation or management focus
2. the user changed `/plm/audit` through browser history or another external route pivot
3. the canonical audit route changed, but the old transient focus could remain because the watcher never ran the route-pivot attention cleanup

## Design

### 1. Add a shared route-pivot attention helper

`apps/web/src/views/plmAuditSavedViewAttention.ts` now exposes `buildPlmAuditRoutePivotAttentionState(...)`.

This helper clears:

- `focusedAuditTeamViewId`
- `focusedRecommendedAuditTeamViewId`
- `focusedSavedViewId`
- local saved-view followup/highlight

That matches the cleanup already used by local filter/pagination pivots.

### 2. Distinguish local route syncs from external route pivots

`apps/web/src/views/PlmAuditView.vue` now tracks whether the next route update came from `syncRouteState(...)`.

- local syncs already own their attention semantics, so the watcher must not clear them again
- browser/external pivots do not go through `syncRouteState(...)`, so the watcher now applies the shared route-pivot attention cleanup before resolving the new route

### 3. Reuse the same helper for local pivots

`Apply filters`, `Reset filters`, and pagination now reuse the same route-pivot helper instead of manually splitting `clearAuditAttentionFocus()` and saved-view-attention cleanup.

## Files

- `apps/web/src/views/plmAuditSavedViewAttention.ts`
- `apps/web/src/views/PlmAuditView.vue`
- `apps/web/tests/plmAuditSavedViewAttention.spec.ts`
- `docs/development/plm-audit-external-route-pivot-attention-design-20260323.md`
- `docs/development/plm-audit-external-route-pivot-attention-verification-20260323.md`

## Expected Outcome

- browser back/forward and external route pivots no longer leave stale recommendation or management focus behind
- local route syncs keep their current semantics and are not double-cleared by the watcher
- route-pivot cleanup stays reducer-driven and shared across local and external route transitions
