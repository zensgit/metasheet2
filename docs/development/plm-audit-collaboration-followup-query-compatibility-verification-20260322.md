# PLM Audit Collaboration Followup Query Compatibility Verification

Date: 2026-03-22
Branch: `codex/plm-workbench-collab-20260312`

## Scope

Verify that `set-default` collaboration followups clear once the audit query is no longer anchored to the original team view id.

## Focused Checks

Commands:

```bash
pnpm --filter @metasheet/web exec vitest run tests/plmAuditTeamViewCollaboration.spec.ts
pnpm --filter @metasheet/web type-check
```

Checks:

- share followups still depend on selected `teamViewId`
- default followups now also depend on `q === followup.teamViewId`
- the helper rejects default followups once the query pivots to another team view id

## Results

- `pnpm --filter @metasheet/web exec vitest run tests/plmAuditTeamViewCollaboration.spec.ts`
  - passed, `1 file / 25 tests`
- `pnpm --filter @metasheet/web type-check`
  - passed
- `cd apps/web && pnpm exec vitest run tests/plm*.spec.ts tests/usePlm*.spec.ts`
  - passed, `43 files / 236 tests`

## Notes

- This slice is frontend-only.
- No browser-level regression was rerun because the fix is inside the collaboration followup compatibility helper and integrated PLM frontend suite.
