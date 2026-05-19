# Data Factory staging field alias verification - 2026-05-19

## Local verification

### Focused adapter regression

Command:

```bash
node plugins/plugin-integration-core/__tests__/metasheet-staging-source-adapter.test.cjs
```

Result:

```text
PASS - metasheet-staging-source-adapter: read-only multitable source tests passed
```

Covered cases:

- Existing logical staging rows still read as before.
- Provisioned physical rows such as `fld_code` are exposed as logical `code`.
- Physical keys remain present for manually patched pipelines.
- Existing logical keys are not overwritten by physical aliases.
- `config.objects.<objectId>.fieldIdMap` works without a provisioning API.

### Plugin integration-core regression

Command:

```bash
pnpm -F plugin-integration-core test
```

Result:

```text
PASS - 23 plugin-integration-core test files completed
```

Notes:

- The isolated worktree reused the already-installed root/core-backend `node_modules`
  symlinks only for the local verification run; those symlinks were removed afterward.
- The PoC route harness needed a test-only `deleteExternalSystem` stub so the full suite
  matches the current `registerIntegrationRoutes()` service contract.

### K3 WISE offline PoC regression

Command:

```bash
pnpm verify:integration-k3wise:poc
```

Result:

```text
PASS - K3 WISE PoC mock chain verified end-to-end
```

## Expected bridge-machine retest

After deploying a package that contains this change, repeat the #1526 bridge smoke path:

1. Open Data Factory Workbench.
2. Use `Standard Materials` as the MetaSheet staging source.
3. Use K3 WISE `material` as the target template.
4. Keep the default logical mapping:
   - `code -> FNumber`
   - `name -> FName`
   - `uom -> FBaseUnitID`
5. Keep idempotency field `code`.
6. Save the pipeline.
7. Run dry-run only.

Expected:

- No `IDEMPOTENCY_FAILED` caused by missing `code`.
- `rowsRead` reflects the staging sample row count.
- `rowsCleaned` advances for valid rows.
- `rowsWritten` remains `0` during dry-run.
- Preview still redacts secrets.

## Non-goals

This verification does not claim:

- SQL Server source is available. `SQLSERVER_EXECUTOR_MISSING` remains separate.
- K3 WebAPI read/list runtime is available.
- Relationship mapping runtime is available.
- Any real K3 write path has been executed.
