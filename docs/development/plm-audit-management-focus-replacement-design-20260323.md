# PLM Audit Management Focus Replacement Design

Date: 2026-03-23

## Goal

Keep `/plm/audit` to one active visual attention source by replacing stale lifecycle-management focus when a draft is dismissed or when recommendation focus takes over after promotion.

## Problem

Two closely related gaps still remained after the recent followup and route-pivot cleanup slices:

1. `runAuditTeamViewCollaborationAction('dismiss')` removed the collaboration draft but left `focusedAuditTeamViewId` behind
2. the saved-view promotion path could refocus a recommendation card after a handoff while still leaving the old lifecycle-management focus active

That created the same UI smell in two places: the page could show a new active source of attention while the previous lifecycle-management row stayed highlighted underneath it.

## Design

### 1. Give draft dismissal its own management-focus cleanup

`apps/web/src/views/plmAuditSavedViewAttention.ts` now exposes `buildPlmAuditDismissedCollaborationDraftAttentionState(...)`.

This helper clears only:

- `focusedAuditTeamViewId`

and preserves any unrelated source focus state.

`apps/web/src/views/PlmAuditView.vue` now uses that helper only for the explicit draft `dismiss` action. Other draft-clear paths keep their existing semantics.

### 2. Reuse the source-focus helper for recommendation refocus

`focusRecommendedAuditTeamView(...)` no longer manually mutates only the recommendation/saved-view focus refs.

It now reuses `applyPlmAuditSourceFocusState(...)`, which already enforces the project rule that source focus replaces prior lifecycle-management focus instead of stacking on top of it.

## Files

- `apps/web/src/views/plmAuditSavedViewAttention.ts`
- `apps/web/src/views/PlmAuditView.vue`
- `apps/web/tests/plmAuditSavedViewAttention.spec.ts`
- `docs/development/plm-audit-management-focus-replacement-design-20260323.md`
- `docs/development/plm-audit-management-focus-replacement-verification-20260323.md`

## Expected Outcome

- dismissing a collaboration draft no longer leaves a stale lifecycle row highlighted
- recommendation refocus after promotion replaces the old management focus instead of stacking with it
- the page keeps one visual-attention rule: a new active source replaces the previous lifecycle-management anchor unless the new handoff explicitly owns that slot
