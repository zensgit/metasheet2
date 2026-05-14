# Data Factory staging source adapter - verification - 2026-05-14

## Scope

This verification covers the Data Factory staging-source slice:

- plugin adapter registration for `metasheet:staging`;
- read-only multitable source behavior;
- workbench action that turns an installed staging table into the active dry-run source;
- existing K3 WISE template preview and offline PoC regression.

It does not claim live K3 WISE connectivity or Submit / Audit validation. Customer GATE is still required before live K3 writes.

## Checks

### Backend plugin tests

Command:

```bash
pnpm -F plugin-integration-core test
```

Expected coverage:

- plugin runtime status includes `metasheet:staging`;
- adapter discovery metadata exposes the staging source as non-advanced;
- staging source adapter lists configured objects;
- schema is derived from staging field details;
- reads call `context.api.multitable.records.queryRecords()` with `sheetId`, `filters`, `limit`, and offset cursor;
- row metadata is attached to returned records;
- unknown objects are rejected;
- upsert is rejected as unsupported.

Result: PASS.

Observed output:

```text
✓ plugin-runtime-smoke: all assertions passed
✓ metasheet-staging-source-adapter: read-only multitable source tests passed
http-routes: REST auth/list/upsert/run/dry-run/staging/replay tests passed
✓ migration-sql: 057/058/059 integration migration structure passed
```

### Frontend workbench tests

Command:

```bash
pnpm --filter @metasheet/web exec vitest run tests/integrationWorkbench.spec.ts tests/IntegrationWorkbenchView.spec.ts tests/IntegrationK3WiseSetupView.spec.ts --watch=false
```

Expected coverage:

- `upsertWorkbenchExternalSystem()` posts the staging-source system payload to `/api/integration/external-systems`;
- Data Factory shows the `metasheet:staging` adapter in inventory;
- installed staging tables still expose `打开多维表`;
- `作为 Dry-run 来源` creates `metasheet_staging_<project>` and selects it as the source;
- source object becomes `standard_materials`;
- saved pipeline payload uses the staging source system and object;
- dry-run, export, Save-only guard, and secret redaction regressions stay green.

Result: PASS.

Observed output:

```text
Test Files  3 passed (3)
Tests  8 passed (8)
```

### Frontend build

Command:

```bash
pnpm --filter @metasheet/web build
```

Result: PASS.

Observed output:

```text
✓ 2389 modules transformed.
✓ built in 6.21s
```

Note: Vite reported the existing large-chunk warning. The build exited `0`.

### K3 offline PoC regression

Command:

```bash
pnpm verify:integration-k3wise:poc
```

Expected coverage:

- the offline K3 WISE mock chain still passes;
- existing K3 Material / BOM template preview path is unchanged.

Result: PASS.

Observed output:

```text
✓ K3 WISE PoC mock chain verified end-to-end (PASS)
```

### Diff hygiene

Command:

```bash
git diff --check
```

Result: PASS (`rc=0`).

## Manual review checklist

- No migration added.
- No secret-bearing values added to fixtures or docs.
- `metasheet:staging` is source-only and cannot write.
- SQL channel remains advanced.
- K3 Submit / Audit remains opt-in and outside this slice.
- Existing `/integrations/workbench` route is unchanged.
