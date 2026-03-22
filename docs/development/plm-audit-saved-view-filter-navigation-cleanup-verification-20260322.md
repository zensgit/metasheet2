# PLM Audit Saved-View Filter Navigation Cleanup Verification

Date: 2026-03-22
Branch: `codex/plm-workbench-collab-20260312`

## Scope

Verify that explicit filter apply and pagination navigation clear saved-view local followups and saved-view focus through the shared attention reducer.

## Focused Checks

```bash
pnpm --filter @metasheet/web type-check
cd apps/web && pnpm exec vitest run tests/plmAuditSavedViewAttention.spec.ts
```

Focused behavior:

- saved-view local followup still clears on `apply`
- saved-view local followup still clears on saved-view context actions
- saved-view local followup still clears on promotion handoff
- saved-view local followup now clears on explicit filter navigation
- saved-view local followup still clears on `reset-filters`
- delete still only removes the matching saved-view attention target

## Full PLM Frontend Regression

```bash
cd apps/web && pnpm exec vitest run tests/plm*.spec.ts tests/usePlm*.spec.ts
```

## Result

- `pnpm --filter @metasheet/web type-check`
  - passed
- `cd apps/web && pnpm exec vitest run tests/plmAuditSavedViewAttention.spec.ts`
  - `1` file, `5` tests passed
- `cd apps/web && pnpm exec vitest run tests/plm*.spec.ts tests/usePlm*.spec.ts`
  - `43` files, `239` tests passed

## Notes

- This slice is frontend-only.
- No browser-level regression was rerun because the change is limited to reducer-backed saved-view attention cleanup plus integrated PLM frontend regression.
