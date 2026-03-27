# PLM Workbench Local Preset Single Restore Parity Verification

## Focused Validation

Command:

```bash
pnpm --filter @metasheet/web exec vitest run tests/usePlmTeamFilterPresets.spec.ts tests/plmLocalPresetOwnership.spec.ts
```

Result:

- passed (`2` files / `47` tests)

Focused coverage added:

- single restore remains allowed while a local preset still owns the current state
- single restore no longer reapplies the restored team preset under that drift
- local owner clear logic now distinguishes normal single restore from drift-preserving single restore

## Type Validation

Command:

```bash
pnpm --filter @metasheet/web type-check
```

Result:

- passed

## Frontend Regression Sweep

Command:

```bash
cd apps/web && pnpm exec vitest run tests/plm*.spec.ts tests/usePlm*.spec.ts
```

Result:

- passed

## Manual Behaviour Verified In Code

- `restoreTeamPreset()` now bypasses only the external-owner drift blocker
- restore permissions still stay blocked for true pending team-preset apply drift
- single restore wrappers in `PlmProductView.vue` keep local owners when drift existed before the action
