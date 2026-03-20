# PLM Audit Shared-Link Team Promotion Verification

## Scope

Verify that shared audit team-view links can flow from:

1. shared entry
2. local saved view
3. immediate promotion into audit team views

## Checks

- Shared-link local save now creates a saved-view follow-up notice.
- The follow-up notice offers:
  - `Save to team`
  - `Save as default team view`
  - `Done`
- The focused saved-view card is highlighted while the follow-up is active.
- Promoting through the follow-up reuses the existing saved-view promotion chain.
- Follow-up state clears when:
  - dismissed
  - the saved view is deleted
  - the saved view is promoted to a team view

## Commands

```bash
pnpm --filter @metasheet/web exec vitest run --watch=false tests/plmAuditTeamViewShareEntry.spec.ts tests/plmAuditSavedViewShareFollowup.spec.ts tests/plmAuditSavedViewPromotion.spec.ts
pnpm --filter @metasheet/web test
pnpm --filter @metasheet/web type-check
pnpm --filter @metasheet/web lint
pnpm --filter @metasheet/web build
```

## Result

- Passed.
- Focused tests:
  - `tests/plmAuditTeamViewShareEntry.spec.ts`
  - `tests/plmAuditSavedViewShareFollowup.spec.ts`
  - `tests/plmAuditSavedViewPromotion.spec.ts`
- Full frontend gates:
  - `50 files / 249 tests`
  - `type-check` passed
  - `lint` passed
  - `build` passed
