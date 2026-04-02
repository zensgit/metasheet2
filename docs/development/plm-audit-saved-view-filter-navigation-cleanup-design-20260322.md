# PLM Audit Saved-View Filter Navigation Cleanup Design

Date: 2026-03-22
Branch: `codex/plm-workbench-collab-20260312`

## Goal

Keep saved-view local followups transient when explicit filter or pagination navigation takes over the audit page.

## Problem

The earlier 2026-03-22 saved-view cleanup slice already cleared local saved-view followups when:

- `Apply saved view`
- saved-view scene-context quick actions
- successful promotion handoff
- `Reset filters`
- delete flows

One route-navigation gap remained:

1. a shared-link local save or scene quick-save created a saved-view followup
2. the user then applied new filters or paged through audit logs
3. the old saved-view followup could still stay visible even though the page had already pivoted into a new filter-navigation context

That left saved-view local guidance alive in flows where the rest of the transient attention model already treats explicit navigation as a takeover.

## Design

### 1. Extend the saved-view attention reducer with a filter-navigation action

`apps/web/src/views/plmAuditSavedViewAttention.ts` should treat explicit filter navigation the same way it already treats other saved-view takeovers:

- clear `shareFollowup`
- clear `focusedSavedViewId`

The cleanup stays inside the reducer contract instead of scattering ad hoc `ref` resets in `PlmAuditView.vue`.

### 2. Use the reducer from both filter apply and pagination actions

`apps/web/src/views/PlmAuditView.vue` should trigger that reducer action when:

- `Apply filters` resets the log route to page `1`
- pagination moves between audit log pages

This keeps explicit log-navigation behavior aligned with the existing `reset-filters` cleanup path.

## Files

- `apps/web/src/views/PlmAuditView.vue`
- `apps/web/src/views/plmAuditSavedViewAttention.ts`
- `apps/web/tests/plmAuditSavedViewAttention.spec.ts`

## Expected Outcome

- saved-view local followups disappear once explicit filter navigation takes over
- saved-view focus does not linger under a new filter/pagination context
- existing apply/context-action/promotion/reset/delete cleanup behavior remains unchanged

## Non-Goals

- no backend or OpenAPI changes
- no route key or storage key changes
- no browser-level regression harness changes
