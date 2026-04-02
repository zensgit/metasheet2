# PLM Workbench Team Preset Single Target Takeover Verification

## Focus

Verify that single-target preset takeovers clear stale `teamPresetSelection`.

## Added Coverage

In `/apps/web/tests/usePlmTeamFilterPresets.spec.ts`:

- `Apply`, `Save`, and `Duplicate` each clear stale batch selection
- `promoteFilterPresetToTeam()` and `promoteFilterPresetToTeamDefault()` also clear stale batch selection

## Commands

```bash
pnpm --filter @metasheet/web exec vitest run tests/usePlmTeamFilterPresets.spec.ts
pnpm --filter @metasheet/web type-check
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web && pnpm exec vitest run tests/plm*.spec.ts tests/usePlm*.spec.ts
```

## Result

- `tests/usePlmTeamFilterPresets.spec.ts`: `26` tests passed
- `pnpm --filter @metasheet/web type-check`: passed
- `pnpm exec vitest run tests/plm*.spec.ts tests/usePlm*.spec.ts`: `53` files / `389` tests passed
