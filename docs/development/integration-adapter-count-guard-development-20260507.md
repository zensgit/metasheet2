# Integration Adapter Count Guard Development

## Context

`createUpsertResult()` is the common target-adapter result normalizer used by
the integration runner. It previously converted `written`, `skipped`, and
`failed` with `Number(value) || 0`.

That accepted invalid counters such as:

- negative counts
- fractional counts
- `Infinity`
- `NaN`, which was silently collapsed to `0`

Those values can flow into run metrics and ledger summaries, making the pipeline
result untrustworthy.

## Change

Added a local `normalizeResultCount()` helper for upsert counters:

- missing, `null`, or empty values remain compatible and normalize to `0`;
- numeric strings such as `"2"` remain accepted;
- values must be non-negative finite integers;
- invalid values throw `AdapterContractError`.

## Scope

Changed files:

- `plugins/plugin-integration-core/lib/contracts.cjs`
- `plugins/plugin-integration-core/__tests__/adapter-contracts.test.cjs`

No pipeline runner, adapters, REST routes, run-log, external-system registry,
workflow, database migration, or frontend code is changed.
