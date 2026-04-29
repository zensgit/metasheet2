# K3 WISE Save-Only Target Options Design

## Context

The M2 live PoC preflight packet generates K3 WISE pipelines with an explicit
Save-only target policy:

```json
{
  "options": {
    "target": {
      "autoSubmit": false,
      "autoAudit": false
    }
  }
}
```

The K3 WISE WebAPI adapter already honors per-request `options.autoSubmit` and
`options.autoAudit`, and those request options intentionally override the
external-system config. However, the pipeline runner only sent object, records,
and key fields into `targetAdapter.upsert()`. That meant a correctly generated
Save-only pipeline could still fall back to the external-system config at write
time.

## Change

`plugins/plugin-integration-core/lib/pipeline-runner.cjs` now resolves
`pipeline.options.target` and passes a shallow copy as `input.options` to the
target adapter:

- Plain object target options are forwarded.
- Missing, null, scalar, or array target options collapse to `{}`.
- The runner does not interpret vendor-specific option keys.
- K3 WISE keeps adapter ownership of boolean coercion and request-vs-config
  precedence.

This preserves the existing adapter contract while closing the runtime gap
between preflight-generated pipeline config and K3 WISE target writes.

## Safety

- No external-system config schema change.
- No database migration.
- No new route or API surface.
- The options object is shallow-copied before adapter handoff.
- Default behavior remains `{}` for pipelines without target runtime options.

## Non-Goals

- Does not enable auto-submit or auto-audit.
- Does not add vendor-specific option validation to the generic runner.
- Does not call customer K3 WISE, PLM, SQL Server, or middleware.
