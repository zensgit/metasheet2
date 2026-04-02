# PLM Workbench Audit Return Path Collaborative Snapshot Verification

## Focused Validation

Commands:

```bash
pnpm --filter @metasheet/web exec vitest run tests/plmWorkbenchViewState.spec.ts tests/plmTeamFilterPresetStateMatch.spec.ts tests/plmLocalFilterPresetRouteIdentity.spec.ts
```

Expected:

- audit return paths drop local preset ids
- route-owner projection ignores preset metadata drift
- local preset route identity still behaves as before

## Type Validation

Command:

```bash
pnpm --filter @metasheet/web type-check
```

## Regression Validation

Command:

```bash
cd apps/web
pnpm exec vitest run tests/plm*.spec.ts tests/usePlm*.spec.ts
```

Expected:

- PLM workbench, audit, and preset suites remain green after both route-state changes
