# PLM Workbench Team Preset Batch Restore Owner Verification

## Focus

Verify that batch restore no longer hijacks the canonical requested preset when restoring a pending local selector target.

## Added Coverage

In `/apps/web/tests/usePlmTeamFilterPresets.spec.ts`:

- keeps `requestedPresetId = A`
- restores pending selector target `B`
- confirms `B` is restored in the list
- confirms route owner and applied state remain anchored to `A`

## Commands

```bash
pnpm --filter @metasheet/web exec vitest run tests/usePlmTeamFilterPresets.spec.ts
pnpm --filter @metasheet/web type-check
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web && pnpm exec vitest run tests/plm*.spec.ts tests/usePlm*.spec.ts
```

## Result

- `tests/usePlmTeamFilterPresets.spec.ts`: `27` tests passed
- `pnpm --filter @metasheet/web type-check`: passed
- `pnpm exec vitest run tests/plm*.spec.ts tests/usePlm*.spec.ts`: `53` files / `390` tests passed
