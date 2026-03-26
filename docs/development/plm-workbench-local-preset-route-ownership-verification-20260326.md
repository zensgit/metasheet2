# PLM Workbench Local Preset Route Ownership Verification

## Coverage

Focused coverage lives in:

- `/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/tests/plmLocalFilterPresetRouteIdentity.spec.ts`

This verifies:

- matching local preset state keeps the route owner
- stale route owners clear both query and selector when they still point at the same preset
- stale route owners clear only the query when the selector already points at a different pending target

## Commands

```bash
pnpm --filter @metasheet/web exec vitest run tests/plmLocalFilterPresetRouteIdentity.spec.ts tests/usePlmTeamViews.spec.ts
pnpm --filter @metasheet/web type-check
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web && pnpm exec vitest run tests/plm*.spec.ts tests/usePlm*.spec.ts
```

## Expected Result

- focused local-preset and team-view suites pass
- type-check passes
- full PLM frontend suite passes
