# Integration Runner Missing Pipeline Guard Design

## Context

`plugin-integration-core` usually gets pipeline definitions from
`lib/pipelines.cjs`, whose `getPipeline()` throws `PipelineNotFoundError` when a
pipeline is missing. The runner, however, is intentionally dependency-injected
and can be used with alternate registries in tests, route harnesses, or future
plugin/runtime adapters.

Before this change, if an injected registry returned `null` for a deleted or
missing pipeline, `pipeline-runner.cjs` immediately read `pipeline.status` and
raised a raw `TypeError`. That produced an implementation-shaped failure instead
of a structured integration error.

## Change

Add a small `assertPipelineLoaded()` guard in `lib/pipeline-runner.cjs` after
`pipelineRegistry.getPipeline()` returns.

If the registry returns `null`, `undefined`, an array, or another non-object, the
runner now throws:

```text
PipelineRunnerError: pipeline not found
```

with details:

```json
{
  "pipelineId": "<requested id>",
  "tenantId": "<tenant id>",
  "workspaceId": "<workspace id or null>"
}
```

## Safety

The guard runs before source/target system loading, adapter construction,
run-row creation, dead-letter creation, target writes, watermark updates, or ERP
feedback writeback.

This keeps a stale UI action, deleted pipeline button click, or alternate
registry implementation from creating partial operational state.

## Scope

This PR does not change the DB-backed pipeline registry behavior. Registries
that already throw `PipelineNotFoundError` keep doing so. The new guard only
covers the defensive case where a registry returns an empty value instead of
throwing.
