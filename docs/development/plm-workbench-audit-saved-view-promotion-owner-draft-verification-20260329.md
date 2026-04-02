# PLM Workbench Audit Saved-View Promotion Owner Draft Verification

## Scope

Verify that default saved-view promotion clears completed team-view form drafts, while non-default promotion remains on the collaboration handoff path.

## Checks

1. Added `shouldClearPlmAuditSavedViewPromotionFormDrafts(...)` in `plmAuditSavedViewPromotion.ts`.
2. Wired `PlmAuditView.vue` to clear completed team-view form drafts only when promotion enters default follow-up mode.
3. Extended `plmAuditSavedViewPromotion.spec.ts` to lock both sides of the contract:
   - default promotion => clear drafts
   - non-default promotion => preserve handoff flow
4. Ran focused promotion tests.
5. Ran web type-check.
6. Ran the PLM web regression suite.

## Result

All checks passed. Default saved-view promotion no longer leaks stale owner drafts into the new canonical audit team-view target.
