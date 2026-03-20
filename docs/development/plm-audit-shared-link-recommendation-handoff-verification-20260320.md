# PLM Audit Shared-Link Recommendation Handoff Verification

## Scope

Verify that shared-link-driven team-view promotion now hands off into the audit recommendation/default entry system.

## Checks

- Recommendation helpers can resolve the correct bucket for:
  - current default
  - recent default
  - recent update
- Shared-link local-save follow-up still offers immediate team promotion.
- When the saved view is promoted from that follow-up:
  - the team view is still created through the existing promotion flow
  - the recommendation filter switches to the correct bucket
  - the promoted team view can be highlighted in recommendations
- Other saved-view promotion entry points still keep their original collaboration-control behavior.

## Commands

```bash
pnpm --filter @metasheet/web exec vitest run --watch=false tests/plmAuditTeamViewCatalog.spec.ts tests/plmAuditSavedViewShareFollowup.spec.ts tests/plmAuditSavedViewPromotion.spec.ts
pnpm --filter @metasheet/web test
pnpm --filter @metasheet/web type-check
pnpm --filter @metasheet/web lint
pnpm --filter @metasheet/web build
```

## Result

- Passed.
- Focused tests:
  - `tests/plmAuditTeamViewCatalog.spec.ts`
  - `tests/plmAuditSavedViewShareFollowup.spec.ts`
  - `tests/plmAuditSavedViewPromotion.spec.ts`
- Full frontend gates:
  - `50 files / 250 tests`
  - `type-check` passed
  - `lint` passed
  - `build` passed
