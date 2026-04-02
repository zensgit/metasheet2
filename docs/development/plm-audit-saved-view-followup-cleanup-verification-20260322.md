# PLM Audit Saved-View Followup Cleanup Verification

Date: 2026-03-22
Branch: `codex/plm-workbench-collab-20260312`

## Scope

Verify that saved-view local followups and saved-view focus are cleared once a successful saved-view promotion handoff replaces them.

## Focused Checks

```bash
pnpm --filter @metasheet/web type-check
cd apps/web && pnpm exec vitest run tests/plmAuditSavedViewAttention.spec.ts
```

Focused behavior:

- saved-view local followup still clears on `apply`
- saved-view local followup still clears on saved-view context actions
- saved-view local followup now clears on successful promotion handoff
- saved-view local followup still clears on `reset-filters`
- delete still only removes the matching saved-view attention target

## Full PLM Frontend Regression

```bash
cd apps/web && pnpm exec vitest run tests/plm*.spec.ts tests/usePlm*.spec.ts
```

Expected result:

- all PLM audit/frontend state-contract tests stay green after the saved-view followup cleanup change

## Result

- `pnpm --filter @metasheet/web type-check`
  - passed
- `cd apps/web && pnpm exec vitest run tests/plmAuditSavedViewAttention.spec.ts`
  - `1` file, `4` tests passed
- `cd apps/web && pnpm exec vitest run tests/plm*.spec.ts tests/usePlm*.spec.ts`
  - `43` files, `237` tests passed

## Notes

- This slice is frontend-only.
- No browser-level regression was rerun because the fix is a reducer-backed attention cleanup plus integrated PLM frontend regression.
