# PLM Audit Transfer Owner Input Lock Verification

## Scope

Verify that the transfer-owner input is disabled whenever the canonical management target is not actionable.

## Focused Checks

### Canonical target lock helper

`apps/web/tests/plmAuditTeamViewControlTarget.spec.ts`

- disables the transfer-owner input when canonical management target drift locks actions
- disables the transfer-owner input when transfer permission is unavailable
- disables the transfer-owner input while loading
- keeps the input enabled only when the canonical target is actionable

## Commands

```bash
pnpm --filter @metasheet/web type-check
cd apps/web && pnpm exec vitest run tests/plmAuditTeamViewControlTarget.spec.ts
cd apps/web && pnpm exec vitest run tests/plm*.spec.ts tests/usePlm*.spec.ts
```

## Result

- `type-check`: passed
- focused Vitest: `1` file / `6` tests passed
- full PLM/frontend Vitest: `46` files / `290` tests passed
