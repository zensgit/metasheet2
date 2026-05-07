# Integration Watermark Value Guard Development

## Context

`integration_watermarks` stores the last successful incremental cursor for a
pipeline. `watermark.cjs` already has `parseWatermarkValue()` to validate the two
supported watermark types:

- `updated_at`: valid timestamp
- `monotonic_id`: numeric value

Before this change, `setWatermark()` only checked that `value` was non-empty and
then persisted it. `advanceWatermark()` also only parsed values when comparing
against an existing same-type watermark. That allowed invalid cursor values to
be stored and fail later during the next incremental comparison.

## Change

`setWatermark()` and `advanceWatermark()` now call
`parseWatermarkValue(normalized.type, value)` before any insert or update. Bad
timestamp and non-numeric monotonic values fail immediately with `WatermarkError`
and are not persisted.

## Scope

Changed files:

- `plugins/plugin-integration-core/lib/watermark.cjs`
- `plugins/plugin-integration-core/__tests__/runner-support.test.cjs`

No pipeline runner, run-log, external-system registry, REST route, adapter,
workflow, database migration, or frontend code is changed.
