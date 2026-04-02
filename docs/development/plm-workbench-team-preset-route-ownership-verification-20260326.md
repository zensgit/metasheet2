# PLM Workbench Team Preset Route Ownership Verification

## Coverage

Added focused unit coverage for the new preset snapshot matcher in:

- `/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/tests/plmTeamFilterPresetStateMatch.spec.ts`

This verifies:

- equal `field/value/group` snapshots match
- local filter drift is detected
- only explicit preset state keys participate in route-owner comparisons

## Commands

```bash
pnpm --filter @metasheet/web exec vitest run tests/plmTeamFilterPresetStateMatch.spec.ts tests/plmWorkbenchViewState.spec.ts
pnpm --filter @metasheet/web type-check
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web && pnpm exec vitest run tests/plm*.spec.ts tests/usePlm*.spec.ts
```

## Expected Result

- focused matcher/workbench route suites pass
- type-check passes
- full PLM frontend suite passes
