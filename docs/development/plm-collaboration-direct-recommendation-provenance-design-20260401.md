# PLM Collaboration Direct Recommendation Provenance Design

## Problem

`PlmAuditView.vue` preserved `sourceRecommendationFilter` only when a recommendation card first opened the collaboration draft. Direct recommendation secondary actions like `share` and `set-default`, plus later follow-up actions, rebuilt collaboration outcomes by reading the current draft instead of carrying provenance explicitly.

That created a drift:

- recommendation card -> open management draft -> action: preserves filter
- recommendation card -> direct secondary action: loses filter when no draft exists

When provenance was dropped, the later `focus-source` follow-up returned to the generic recommendation lane instead of the original filtered lane.

## Design

Keep the provenance contract explicit instead of implicit:

1. Add a small helper in `plmAuditTeamViewCollaboration.ts` that resolves recommendation provenance only for `source === 'recommendation'`.
2. Thread `sourceRecommendationFilter` as an explicit optional parameter through:
   - `shareAuditTeamViewEntry(...)`
   - `setAuditTeamViewDefaultEntry(...)`
3. Update all recommendation-origin call-sites to pass the real provenance source:
   - direct recommendation secondary actions use `auditTeamViewRecommendationFilter.value`
   - draft actions use `draft.sourceRecommendationFilter`
   - follow-up `set-default` uses `followup.sourceRecommendationFilter`
4. Leave non-recommendation flows unchanged by returning `undefined` for saved-view and scene-context sources.

## Why This Scope

This keeps the write set narrow and avoids touching unrelated collaboration runtime logic. The issue is not how follow-ups are rendered; it is that provenance was not propagated into the already-correct helper contract.

## Files

- `apps/web/src/views/PlmAuditView.vue`
- `apps/web/src/views/plmAuditTeamViewCollaboration.ts`
- `apps/web/tests/plmAuditTeamViewCollaboration.spec.ts`
