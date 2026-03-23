# PLM Audit Refresh Form Residue Verification

## Scope

Verify that refresh-driven team-view removals clear stale management form drafts only when the removed team view was the current selection.

## Focused Checks

### Refresh trim helper

`apps/web/tests/plmAuditTeamViewOwnership.spec.ts`

- clears stale `selectedTeamViewId`, focus, and management form drafts when the backing team view disappears
- preserves create-form drafts when no selected team view was removed

## Commands

```bash
pnpm --filter @metasheet/web type-check
cd apps/web && pnpm exec vitest run tests/plmAuditTeamViewOwnership.spec.ts
cd apps/web && pnpm exec vitest run tests/plm*.spec.ts tests/usePlm*.spec.ts
```

## Result

- `type-check`: passed
- focused Vitest: `1` file / `4` tests passed
- full PLM/frontend Vitest: `46` files / `285` tests passed
