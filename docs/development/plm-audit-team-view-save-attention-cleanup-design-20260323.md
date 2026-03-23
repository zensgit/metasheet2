# PLM Audit Team View Save Attention Cleanup Design

Date: 2026-03-23

## Goal

Keep `/plm/audit` to one active source-driven attention path when a generic `Save to team` action persists a new audit team view.

## Problem

The generic team-view persistence path in `apps/web/src/views/PlmAuditView.vue` saved a new team view and switched the canonical route to its `teamViewId`, but it did not clear transient source attention first.

That left one visible residue:

1. a recommendation card or saved-view source highlight could remain active after the new persisted team view became the selected durable context

`auditTeamViewKey` watchers already cleared `shared-entry`, collaboration drafts, and collaboration followups when the new view id replaced the previous one. The missing cleanup was only the source-attention layer.

## Design

### 1. Add a dedicated persisted-team-view attention helper

`apps/web/src/views/plmAuditSavedViewAttention.ts` now exposes `buildPlmAuditPersistedTeamViewAttentionState(...)`.

The helper keeps the same lifecycle-management slot intact and clears:

- `focusedRecommendedAuditTeamViewId`
- `focusedSavedViewId`
- local saved-view followup state

This matches the semantics of generic team-view persistence: a durable team-view selection is taking over, so transient source attention must be consumed first.

### 2. Apply the helper inside generic team-view persistence

`persistAuditTeamView(...)` in `apps/web/src/views/PlmAuditView.vue` now applies that helper before switching route state to the newly saved team view.

The sequence becomes:

1. persist the new team view
2. clear transient source attention and local saved-view followup
3. select the newly persisted team view and sync the canonical route

This keeps the existing watcher-based cleanup for share-entry/draft/followup, while closing the last source-attention gap.

## Files

- `apps/web/src/views/plmAuditSavedViewAttention.ts`
- `apps/web/src/views/PlmAuditView.vue`
- `apps/web/tests/plmAuditSavedViewAttention.spec.ts`
- `docs/development/plm-audit-team-view-save-attention-cleanup-design-20260323.md`
- `docs/development/plm-audit-team-view-save-attention-cleanup-verification-20260323.md`

## Expected Outcome

- `recommendation -> Save to team` no longer leaves the old recommendation card highlighted
- `saved-view followup -> Save to team` no longer leaves the old local saved-view notice/focus active
- generic team-view persistence now lands on one durable management focus instead of stacking a new selection on top of stale source attention
