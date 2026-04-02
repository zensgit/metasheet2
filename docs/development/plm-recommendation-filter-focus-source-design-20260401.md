# PLM Recommendation Filter Lost on focus-source — Design

**Date:** 2026-04-01
**Area:** audit followup/runtime state

## Bug

**Flow:**
1. User views recommendations with filter `recent-default`
2. Clicks a recommendation card → `focusAuditTeamViewManagement` fires
3. From the collaboration controls, triggers share → followup appears
4. Clicks `focus-source` in the followup

**Expected:** UI returns to the recommendation group filtered to
`recent-default` and focuses the correct card.

**Actual:** The recommendation filter resets to `''` (all), because
`focusAuditTeamViewManagement` did not pass
`sourceRecommendationFilter` to the handoff builder.

## Root cause

`focusAuditTeamViewManagement` (PlmAuditView.vue ~line 2809) called
`buildPlmAuditTeamViewCollaborationHandoff` with `source: 'recommendation'`
but omitted `sourceRecommendationFilter`. The builder defaulted it to `''`
via `resolvePlmAuditTeamViewCollaborationSourceRecommendationFilter`.

All other recommendation entry points (`shareAuditTeamViewEntry`,
`setAuditTeamViewDefaultEntry`, `runRecommendedAuditTeamViewSecondaryAction`)
correctly passed `auditTeamViewRecommendationFilter.value`.

## Fix

Pass `sourceRecommendationFilter: auditTeamViewRecommendationFilter.value`
in the handoff options.

## Files changed

| File | Change |
|------|--------|
| `apps/web/src/views/PlmAuditView.vue` | Pass `sourceRecommendationFilter` in `focusAuditTeamViewManagement` |
| `apps/web/tests/plmAuditTeamViewCollaboration.spec.ts` | +2 tests: filter round-trip, omission defaults |
