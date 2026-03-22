# PLM Audit Local Team-View Pivot Cleanup Verification

Date: 2026-03-22
Branch: `codex/plm-workbench-collab-20260312`

## Scope

Verify that local `Apply` and `Duplicate` team-view pivots now reuse the saved-view `apply` cleanup before they install the next local route state.

## Focused Checks

```bash
pnpm --filter @metasheet/web type-check
cd apps/web && pnpm exec vitest run \
  tests/plmAuditSavedViewAttention.spec.ts \
  tests/plmAuditTeamViewShareEntry.spec.ts \
  tests/plmAuditTeamViewCollaboration.spec.ts
```

Focused behavior:

- saved-view `apply` cleanup contract still holds
- shared-entry route cleanup still holds
- collaboration followup cleanup still holds alongside the local pivot cleanup

## Full PLM Frontend Regression

```bash
cd apps/web && pnpm exec vitest run tests/plm*.spec.ts tests/usePlm*.spec.ts
```

## Result

- `pnpm --filter @metasheet/web type-check`
  - passed
- `cd apps/web && pnpm exec vitest run tests/plmAuditSavedViewAttention.spec.ts tests/plmAuditTeamViewShareEntry.spec.ts tests/plmAuditTeamViewCollaboration.spec.ts`
  - `3` files, `39` tests passed
- `cd apps/web && pnpm exec vitest run tests/plm*.spec.ts tests/usePlm*.spec.ts`
  - `43` files, `243` tests passed

## Notes

- This slice is frontend-only.
- No browser-level regression was rerun because the change is limited to local pivot cleanup plus the PLM frontend regression suite.
