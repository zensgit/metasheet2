# PLM Workbench Audit Saved-View Promotion Owner Draft Design

## Background

`saved-view -> audit team view` promotion has two post-success modes:

- non-default promotion keeps a collaboration draft handoff
- default promotion pivots into a follow-up flow without a collaboration draft

Recent audit lifecycle fixes already aligned `save`, `duplicate`, and `rename` to clear completed form drafts, including stale transfer-owner input.

## Problem

Default saved-view promotion still allowed the previous `auditTeamViewOwnerUserId` draft to survive. The new team view had already become the canonical owner, but the follow-up handoff path used `teamViewOwnerUserId: null`, so the stale owner draft was never cleared.

## Decision

Introduce a small promotion helper contract in `plmAuditSavedViewPromotion.ts`:

- `shouldClearPlmAuditSavedViewPromotionFormDrafts(...)`

This returns `true` only for default-promotion follow-up mode. `PlmAuditView.vue` uses it to clear completed team-view form drafts right after the saved team view becomes canonical and before the follow-up handoff is applied.

## Expected Outcome

- default saved-view promotion clears stale rename/owner drafts
- non-default saved-view promotion still preserves the collaboration handoff draft

This keeps promotion semantics aligned with the rest of the audit team-view lifecycle.
