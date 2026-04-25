# Integration Core ERP Feedback Verification - 2026-04-24

## Scope

Verify M2-T04 ERP feedback writeback support:

- normalize target adapter success results into staging feedback fields.
- normalize target adapter errors into failed feedback fields.
- support partial batches.
- support field-map override from camelCase to customer-specific names.
- write through an injected staging writer.
- write through plugin-scoped multitable APIs when available.
- integrate feedback writeback after pipeline target upsert.
- expose feedback initialization in plugin runtime status.

## Commands Run

```bash
node -c plugins/plugin-integration-core/lib/erp-feedback.cjs
node -c plugins/plugin-integration-core/lib/pipeline-runner.cjs
node -c plugins/plugin-integration-core/index.cjs
node -c plugins/plugin-integration-core/__tests__/erp-feedback.test.cjs
node -c plugins/plugin-integration-core/__tests__/pipeline-runner.test.cjs
node -c plugins/plugin-integration-core/lib/adapters/k3-wise-webapi-adapter.cjs
pnpm -F plugin-integration-core test:erp-feedback
pnpm -F plugin-integration-core test:pipeline-runner
```

```bash
pnpm -F plugin-integration-core test
node --import tsx scripts/validate-plugin-manifests.ts
git diff --check
```

## Results

- New ERP feedback module passes syntax check.
- Pipeline runner and plugin entry pass syntax check after integration.
- New `erp-feedback.test.cjs` passes.
- Updated `pipeline-runner.test.cjs` passes.
- `plugin-integration-core` package tests pass, including runtime smoke,
  adapter, K3, feedback, runner, REST, staging, and migration checks.
- Plugin manifest validation passes: 13/13 valid, 0 errors. Existing warnings
  are unrelated plugin metadata/wildcard warnings outside this slice.
- `git diff --check` passes.

## Covered Behaviors

`erp-feedback.test.cjs` covers:

- successful ERP results produce `erpSyncStatus = synced`.
- `externalId/materialId/id` style identifiers normalize to `erpExternalId`.
- `billNo/number/FBillNo` style numbers normalize to `erpBillNo`.
- failed ERP results produce `erpSyncStatus = failed`.
- target errors match clean records by `key`, `idempotencyKey`, explicit
  `index`, or `record._integration_idempotency_key`.
- unmatched target errors are not written to staging.
- aggregate `failed > 0` without itemized errors is not written to the first
  clean record; the runner records an aggregate dead letter instead.
- `pipeline.options.erpFeedback.fieldMap` can switch output fields to
  snake_case.
- `enabled: false` skips writeback.
- missing project/object/key target skips writeback.
- injected staging writer receives normalized updates.
- multitable writer resolves object sheet and field ids, then patches existing
  records or creates minimal records.

`pipeline-runner.test.cjs` covers:

- feedback writeback runs after target upsert.
- feedback receives the current run id, pipeline, clean records, and write
  result.
- compact feedback summary is stored in run details.

Runtime smoke coverage:

- plugin status includes `erpFeedback: true`.

## Not Covered

- live K3 WISE response payloads.
- live multitable database writes.
- frontend display of ERP feedback fields.
- customer-specific staging object selection.
- bulk patch performance.

These remain part of the customer PoC and UI hardening slices.
