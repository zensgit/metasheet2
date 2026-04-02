# PLM Audit Cleared Draft Selection Cleanup Verification

## Scope

Verify that collaboration draft cleanup clears only the draft-owned single-row selection no matter which code path clears the draft.

## Focused Checks

### Draft-clear selection reducer

`apps/web/tests/plmAuditTeamViewCollaboration.spec.ts`

- clears the auto-installed single-row selection for the cleared draft target
- preserves user-managed multi-select state
- preserves unrelated single-row selection

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
