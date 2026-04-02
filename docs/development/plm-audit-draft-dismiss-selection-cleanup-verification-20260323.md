# PLM Audit Draft Dismiss Selection Cleanup Verification

## Scope

Verify that dismissing a collaboration draft clears only the draft-owned single-row batch selection and does not wipe user-managed multi-select state.

## Focused Checks

### Draft-dismiss selection reducer

`apps/web/tests/plmAuditTeamViewCollaboration.spec.ts`

- clears the auto-installed single-row selection for the dismissed draft target
- preserves multi-select state that no longer looks draft-owned
- preserves unrelated single-row selections

## Commands

```bash
pnpm --filter @metasheet/web type-check
cd apps/web && pnpm exec vitest run tests/plmAuditTeamViewCollaboration.spec.ts
cd apps/web && pnpm exec vitest run tests/plm*.spec.ts tests/usePlm*.spec.ts
```

## Result

- `type-check`: passed
- focused Vitest: `1` file / `37` tests passed
- full PLM/frontend Vitest: `46` files / `294` tests passed
