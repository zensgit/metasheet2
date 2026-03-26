# PLM Workbench Team Preset Refresh Owner Trim Verification

## Coverage

Focused coverage lives in:

- `/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/tests/usePlmTeamFilterPresets.spec.ts`

This verifies:

- a whitespace-padded explicit `requestedPresetId` still applies the requested preset
- the explicit preset still wins over the default preset on refresh
- broader preset refresh, takeover, and lifecycle contracts continue to pass

## Commands

```bash
pnpm --filter @metasheet/web exec vitest run tests/usePlmTeamFilterPresets.spec.ts tests/plmWorkbenchViewState.spec.ts tests/plmWorkbenchClient.spec.ts tests/usePlmTeamViews.spec.ts
pnpm --filter @metasheet/web type-check
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web && pnpm exec vitest run tests/plm*.spec.ts tests/usePlm*.spec.ts
```

## Expected Result

- focused preset/workbench suites pass
- type-check passes
- full PLM frontend suite passes
