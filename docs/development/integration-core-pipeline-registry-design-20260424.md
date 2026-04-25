# Integration Core Pipeline Registry Design - 2026-04-24

## Context

After M1-PR1 registers external PLM/ERP/DB systems, the next non-runner step is
to persist pipeline definitions and their field mappings. This lets later slices
wire adapter reads/writes into stable pipeline metadata without inventing the
definition shape inside the runner.

This slice stores definition state only. It does not execute adapters, transform
records, advance watermarks, or write dead letters.

## Decision

Add `plugins/plugin-integration-core/lib/pipelines.cjs`.

The registry manages:

- `integration_pipelines`
- `integration_field_mappings`
- `integration_runs`

It also reads `integration_external_systems` to validate that source and target
systems exist in the same tenant/workspace and have compatible roles.

## Communication API

`index.cjs` creates the pipeline registry during activation:

```js
pipelineRegistry = createPipelineRegistry({ db })
```

The `integration-core` namespace exposes:

```js
upsertPipeline(input)
getPipeline(input)
listPipelines(input)
createPipelineRun(input)
updatePipelineRun(input)
listPipelineRuns(input)
```

`getStatus()` includes:

```json
{
  "pipelines": true
}
```

## Pipeline Rules

Pipeline inputs require:

- `tenantId`
- `name`
- `sourceSystemId`
- `sourceObject`
- `targetSystemId`
- `targetObject`

Defaults:

- `mode`: `incremental`
- `status`: `draft`
- `idempotencyKeyFields`: `[]`
- `options`: `{}`

Role enforcement:

- source system role must be `source` or `bidirectional`
- target system role must be `target` or `bidirectional`

`workspaceId === ''` is normalized to `null`, matching migration 057's
`COALESCE(workspace_id, '')` uniqueness convention.

## Field Mappings

`fieldMappings` is optional:

- omitted means preserve existing mappings.
- an explicit empty array clears mappings.
- a non-empty array replaces mappings transactionally.

Mappings validate:

- `sourceField`
- `targetField`
- non-negative `sortOrder`
- JSON-compatible `transform`, `validation`, and `defaultValue`

## Run Ledger

The run ledger is metadata-only in this slice:

- `createPipelineRun()` creates a pending/running/etc. row after checking the
  pipeline exists and is not disabled.
- `updatePipelineRun()` updates counters, status, timestamps, error summary,
  and details.
- terminal statuses set `finished_at` when the caller did not provide one.

The ledger does not call adapters and does not process rows.

## Trade-Offs

- Pipeline definition writes validate external systems before insert/update.
- Field mapping replacement requires `db.transaction()` so partial mapping
  updates do not leave a mixed definition.
- Run counters are validated as non-negative integers here, before runner code
  exists.

## Deferred

- Actual `runPipeline()` implementation.
- Transform/validation execution.
- Idempotency calculation.
- Watermark advancement.
- Dead-letter creation and replay.
- REST routes and UI.
