# PLM Audit Source Action Followup Cleanup Design

Date: 2026-03-23

## Goal

Keep source-driven collaboration outcomes (`share` / `set-default`) aligned with the same transient-attention cleanup contract already used by team-view handoffs.

## Problem

The recent cleanup slices already ensured that explicit handoffs into team-view collaboration controls clear stale local attention. But source-driven collaboration outcomes could still bypass that rule.

The remaining gap looked like this:

1. the audit page still held stale saved-view/source attention from an earlier local flow
2. the user triggered a source-aware collaboration action such as:
   - recommended card `share`
   - recommended card `set-default`
   - source-aware followup actions from scene or saved-view promotion provenance
3. the page created the new collaboration followup, but the older saved-view/source attention could remain visible underneath it

That left the page with mixed transient guidance even though the user had already committed to a new collaboration outcome.

## Design

### 1. Reuse the existing handoff cleanup helper

`apps/web/src/views/PlmAuditView.vue` already exposes `applyAuditTeamViewHandoffAttention()`.

This helper clears:

- source focus
- local saved-view followup/highlight

while preserving the management-focus slot used by the team-view outcome that comes next.

### 2. Apply cleanup before sourceful collaboration outcomes

When `shareAuditTeamViewEntry(...)` or `setAuditTeamViewDefaultEntry(...)` receives a non-null `source`, the page now applies the shared handoff cleanup before installing the new collaboration followup.

This keeps recommendation, scene-context, and saved-view-promotion sourced outcomes aligned with the same transient-attention rule.

### 3. Leave generic actions unchanged

Generic actions with no provenance (`source == null`) still behave as before.

This slice only tightens the flows that explicitly promise a source-aware followup.

## Files

- `apps/web/src/views/PlmAuditView.vue`
- `docs/development/plm-audit-source-action-followup-cleanup-design-20260323.md`
- `docs/development/plm-audit-source-action-followup-cleanup-verification-20260323.md`

## Expected Outcome

- source-aware collaboration followups no longer coexist with stale saved-view/source attention
- recommendation secondary actions now obey the same cleanup rule as explicit team-view handoffs
- generic share/default actions without provenance remain unchanged
