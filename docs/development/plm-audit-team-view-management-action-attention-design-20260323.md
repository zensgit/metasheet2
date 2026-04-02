# PLM Audit Team View Management Action Attention Design

Date: 2026-03-23

## Goal

Keep `/plm/audit` on one active management context when generic team-view management actions take over from an older source-driven attention path.

## Problem

Earlier cleanup already covered:

- local saved-view creation
- team-view promotion handoffs
- recommendation refocus
- generic `Save to team`

But several in-place team-view management actions in `apps/web/src/views/PlmAuditView.vue` still directly installed `focusedAuditTeamViewId` without first consuming old transient source attention.

That left one visible leak:

1. a recommendation card or saved-view source highlight could remain active after `Rename`, `Transfer owner`, `Clear default`, `Archive`, `Restore`, `Delete`, or batch lifecycle actions had already pivoted the page into a new management-owned outcome

## Design

### 1. Generalize the managed-team-view attention helper

`apps/web/src/views/plmAuditSavedViewAttention.ts` now exposes `buildPlmAuditManagedTeamViewAttentionState(...)`.

The helper preserves the lifecycle-management slot and clears:

- `focusedRecommendedAuditTeamViewId`
- `focusedSavedViewId`
- local saved-view followup state

`buildPlmAuditPersistedTeamViewAttentionState(...)` now delegates to that generic helper so the existing `Save to team` contract stays intact.

### 2. Reuse the helper across generic management actions

`apps/web/src/views/PlmAuditView.vue` now applies the managed-team-view cleanup before installing management-owned outcomes for:

- `Rename`
- `Transfer owner`
- `Clear default`
- single-view `Archive / Restore / Delete`
- batch lifecycle actions

This keeps the existing management highlight behavior, but prevents source attention from surviving alongside it.

## Files

- `apps/web/src/views/plmAuditSavedViewAttention.ts`
- `apps/web/src/views/PlmAuditView.vue`
- `apps/web/tests/plmAuditSavedViewAttention.spec.ts`
- `docs/development/plm-audit-team-view-management-action-attention-design-20260323.md`
- `docs/development/plm-audit-team-view-management-action-attention-verification-20260323.md`

## Expected Outcome

- `recommendation -> Rename/Transfer owner` no longer leaves the old recommendation card highlighted
- `recommendation/source focus -> Clear default / Archive / Restore / Delete` no longer stacks source attention on top of the management-owned result
- batch lifecycle pivots keep one management anchor instead of inheriting stale source/local attention
