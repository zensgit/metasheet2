# PLM Audit Attention And Followup Cleanup Design

Date: 2026-03-22
Branch: `codex/plm-workbench-collab-20260312`

## Goal

Close the remaining PLM Audit frontend attention/followup residue so that source highlights and collaboration notices behave like transient guidance instead of surviving unrelated route and context changes.

## Problem

The core `scene -> audit -> saved view/team view/default/logs -> return` flow was already closed, but three UI residues still remained around the audit collaboration surface:

1. Saved-view local followups and saved-view focus could survive `Apply saved view`, saved-view context quick actions, `Reset filters`, and delete flows.
2. Team-view collaboration followups could survive route pivots after the audit context no longer matched the followup contract, especially after default-promotion log routes cleared `teamViewId`.
3. Recommendation-card focus could survive recommendation-filter changes and unrelated route actions even after the focused card was no longer visible.

These problems did not require new APIs. They were state-contract cleanup issues inside the existing frontend model.

## Design

### 1. Treat saved-view attention as a dedicated state slice

`apps/web/src/views/plmAuditSavedViewAttention.ts` now owns the local saved-view attention contract:

- `shareFollowup`
- `focusedSavedViewId`

The reducer explicitly handles:

- `apply`
- `context-action`
- `reset-filters`
- `delete`

This keeps saved-view followup cleanup out of `PlmAuditView.vue` conditionals and makes the rules testable as a pure state transition.

### 2. Make collaboration followups route-compatible

`apps/web/src/views/plmAuditTeamViewCollaboration.ts` now exposes followup compatibility and provenance-pruning helpers.

The followup contract is:

- share followups remain valid only while the same `teamViewId` stays selected
- `set-default` followups remain valid only while the route still represents default-change audit logs

When `PlmAuditView.vue` observes a route pivot that no longer satisfies that contract, it clears the stale collaboration followup instead of leaving outdated notice copy on screen.

### 3. Prune deleted saved-view provenance from collaboration state

Saved-view promotion collaboration state can carry `sourceSavedViewId`.

When the originating saved view is deleted:

- collaboration drafts drop the deleted `sourceSavedViewId`
- collaboration followups drop the deleted `sourceSavedViewId`

This prevents later `focus-source` actions from carrying an already-deleted saved-view reference.

### 4. Consume stale recommendation focus ids

`apps/web/src/views/plmAuditTeamViewCatalog.ts` now owns one small catalog-level rule:

- if a focused recommendation card is no longer visible in the current recommendation list, consume that focus id

`PlmAuditView.vue` also clears source focus before explicit route pivots such as:

- `Apply team view`
- `Apply saved view`
- `Apply filters`
- `Reset filters`
- pagination changes
- saved-view context quick actions

This keeps recommendation focus aligned with the visible recommendation catalog instead of leaving stale highlight state behind.

## Files

- `apps/web/src/views/PlmAuditView.vue`
- `apps/web/src/views/plmAuditSavedViewAttention.ts`
- `apps/web/src/views/plmAuditTeamViewCollaboration.ts`
- `apps/web/src/views/plmAuditTeamViewCatalog.ts`
- `apps/web/tests/plmAuditSavedViewAttention.spec.ts`
- `apps/web/tests/plmAuditTeamViewCollaboration.spec.ts`
- `apps/web/tests/plmAuditTeamViewCatalog.spec.ts`

## Result

The audit page now treats focus/followup state as transient UI guidance:

- saved-view attention is cleared when saved-view navigation takes over
- collaboration followups disappear when the route no longer matches their contract
- deleted saved views no longer leak stale provenance into later followups
- recommendation focus cannot survive a catalog where the target card is no longer visible
