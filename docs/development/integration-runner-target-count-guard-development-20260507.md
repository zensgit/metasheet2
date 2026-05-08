# Integration Runner Target Count Guard - Development - 2026-05-07

## Context

The pipeline runner consumes target adapter `upsert()` results and turns
`written`, `skipped`, and `failed` into run metrics, dead-letter accounting,
and watermark decisions.

Adapter contract helpers can validate these counters, but the runner must not
assume every custom adapter used the helper. A malformed adapter result such as
`written: Infinity` or `skipped: -1` could otherwise pollute metrics or create a
false success path.

## Change

- Added `normalizeTargetWriteCount()` in
  `plugins/plugin-integration-core/lib/pipeline-runner.cjs`.
- `normalizeTargetWriteResult()` now accepts only finite non-negative integer
  counters.
- Invalid counters are normalized to `0` and recorded in `invalidCounts`.
- Any invalid counter marks the write result inconsistent.
- If the malformed result would otherwise look fully accounted, the runner adds
  one safe aggregate failure so the run becomes `partial` and the watermark does
  not advance.
- Aggregate dead-letter payloads now include `invalidCounts` for diagnosis.

## Behavioral Contract

- Valid integer counters keep existing behavior.
- Numeric strings such as `"1"` remain accepted.
- Negative, fractional, `Infinity`, `NaN`, and non-numeric counters are not
  added to metrics.
- A malformed target result cannot advance the incremental watermark as a clean
  success.
