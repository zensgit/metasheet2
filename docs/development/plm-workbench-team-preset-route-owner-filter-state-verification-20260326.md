# PLM Workbench Team Preset Route Owner Filter State Verification

## Focused Validation

Command:

```bash
pnpm --filter @metasheet/web exec vitest run tests/plmTeamFilterPresetStateMatch.spec.ts tests/plmLocalFilterPresetRouteIdentity.spec.ts
```

Expected:

- route-owner projection drops `group`
- local preset route identity still keeps matching owners
- metadata-only drift no longer clears team preset route owners

## Type Validation

Command:

```bash
pnpm --filter @metasheet/web type-check
```

Expected:

- `PlmProductView.vue` and the new helper compile cleanly

## Regression Validation

Command:

```bash
cd apps/web
pnpm exec vitest run tests/plm*.spec.ts tests/usePlm*.spec.ts
```

Expected:

- existing PLM workbench and audit suites remain green after the route-owner projection change
