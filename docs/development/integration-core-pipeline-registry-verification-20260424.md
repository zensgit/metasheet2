# Integration Core Pipeline Registry Verification - 2026-04-24

## Scope

Verify the pipeline definition registry and run ledger for
`plugin-integration-core`.

This slice does not execute the pipeline runner. It only verifies persisted
pipeline definitions, field mappings, endpoint role checks, and run metadata.

## Commands Run

```bash
node plugins/plugin-integration-core/__tests__/pipelines.test.cjs
pnpm -F plugin-integration-core test
node --import tsx scripts/validate-plugin-manifests.ts
```

## Results

- `pipelines.test.cjs`: passed.
- `plugin-integration-core` package tests: passed, including 10 plugin-local
  smoke/unit checks.
- Plugin manifest validation through `node --import tsx`: passed, 13/13 valid,
  0 errors.

`pnpm validate:plugins` was also attempted in this sandbox and failed before
running validation due the known `tsx` IPC `listen EPERM` restriction.

## Covered Behaviors

- `upsertPipeline()` creates a pipeline in the correct tenant/workspace.
- empty `workspaceId` normalizes to `null`.
- source and target external systems must exist in the same tenant/workspace.
- source role must be `source | bidirectional`.
- target role must be `target | bidirectional`.
- field mappings are written transactionally.
- `getPipeline()` returns mappings by default.
- output shape never includes credentials or ciphertext.
- update without `fieldMappings` preserves existing mappings.
- explicit `fieldMappings: []` clears mappings.
- `listPipelines()` scopes by tenant/workspace and filters by status.
- invalid mappings throw `PipelineValidationError`.
- missing pipelines throw `PipelineNotFoundError`.
- `createPipelineRun()` creates run metadata without executing adapters.
- terminal `updatePipelineRun()` sets `finishedAt`.
- negative run counters are rejected.
- disabled pipelines cannot create new runs.

## Not Covered

- Actual row extraction from source adapters.
- Transform and validation execution.
- Target adapter writes.
- Dead-letter writes or replay.
- Watermark updates.
- Live Postgres execution of these service methods.
