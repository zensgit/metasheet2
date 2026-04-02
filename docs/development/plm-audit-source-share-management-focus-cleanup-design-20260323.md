# PLM Audit Source Share Management Focus Cleanup Design

Date: 2026-03-23

## Goal

Ensure source-aware `share` followups do not keep an unrelated lifecycle-management focus alive after the page has already pivoted away from team-view management.

## Problem

The recent source-action cleanup reused `applyAuditTeamViewHandoffAttention()` for both sourceful `share` and `set-default`.

That was only partially correct:

- `set-default` immediately installs a new `focusedAuditTeamViewId`, so preserving the management-focus slot is expected
- `share` does not install a new management target; it only creates a followup notice with provenance

This left one remaining residue:

1. the user still had a stale `focusedAuditTeamViewId`
2. they triggered a source-aware `share`
3. the page cleared source focus and saved-view followup, but the old lifecycle row could stay highlighted

That violated the existing rule that management focus belongs only to the lifecycle-management context.

## Design

### 1. Split sourceful share cleanup from team-view handoff cleanup

`apps/web/src/views/plmAuditSavedViewAttention.ts` now exposes `buildPlmAuditSourceShareFollowupAttentionState(...)`.

Unlike the team-view handoff helper, this variant clears:

- `focusedAuditTeamViewId`
- `focusedRecommendedAuditTeamViewId`
- `focusedSavedViewId`
- local saved-view followup state

### 2. Use the stricter cleanup only for source-aware share

`apps/web/src/views/PlmAuditView.vue` now routes sourceful `shareAuditTeamViewEntry(...)` through the new helper before installing the collaboration followup.

This keeps:

- source-aware `share` aligned with the followup-only UX it actually creates
- source-aware `set-default` on the existing team-handoff cleanup, because that path still owns a live management target

### 3. Keep the contract reducer-first

The cleanup stays in the attention helper layer instead of reintroducing ad-hoc ref mutation inside `PlmAuditView.vue`.

That preserves the broader 2026-03-22/23 direction: transient attention semantics should be expressed as reusable reducer-style helpers, not page-local conditionals.

## Files

- `apps/web/src/views/plmAuditSavedViewAttention.ts`
- `apps/web/src/views/PlmAuditView.vue`
- `apps/web/tests/plmAuditSavedViewAttention.spec.ts`

## Expected Outcome

- source-aware `share` followups no longer coexist with stale lifecycle-management focus
- source-aware `set-default` still preserves the management-focus slot it immediately reuses
- the page keeps one consistent rule: followup-only actions clear all prior attention unless they install a new active management target
