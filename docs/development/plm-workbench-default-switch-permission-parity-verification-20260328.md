# PLM Workbench Default Switch Permission Parity Verification

Date: 2026-03-28

## What Changed

Both collaborative default-switch helpers now demote the previous default item completely, not just its `isDefault` flag:

- `apps/web/src/views/plm/usePlmTeamViews.ts`
- `apps/web/src/views/plm/usePlmTeamFilterPresets.ts`

The previous default item now immediately reflects:

- `isDefault: false`
- `permissions.canSetDefault: true` when still manageable and active
- `permissions.canClearDefault: false`

## Verification

### Focused default-switch regressions

Command:

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web && pnpm exec vitest run tests/usePlmTeamViews.spec.ts tests/usePlmTeamFilterPresets.spec.ts
```

Result:

- `2` files passed
- `84` tests passed

### Frontend type-check

Command:

```bash
pnpm --filter @metasheet/web type-check
```

Result: passed

### PLM frontend regression suite

Command:

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web && pnpm exec vitest run tests/plm*.spec.ts tests/usePlm*.spec.ts
```

Result:

- `62` files passed
- `493` tests passed

## Regression Covered

- switching a team view default immediately fixes the previous default item's granular flags
- switching a team preset default does the same
- no refresh is required for the previous default item to become actionable as a non-default again
