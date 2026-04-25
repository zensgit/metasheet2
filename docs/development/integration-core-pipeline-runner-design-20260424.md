# Integration Core Pipeline Runner Design - 2026-04-24

## Context

M1-PR1 adds external-system registration. M1-PR2 adds adapter contracts, the HTTP
adapter, and pipeline definition/run metadata registries. The next slice is the
first backend execution loop for:

`source adapter -> transform -> validate -> target adapter -> run log / dead letter / watermark`

This remains a plugin-local implementation. It does not expose user-provided JS
transforms.

## Modules

New runner modules:

- `lib/transform-engine.cjs`
- `lib/validator.cjs`
- `lib/idempotency.cjs`
- `lib/watermark.cjs`
- `lib/dead-letter.cjs`
- `lib/run-log.cjs`
- `lib/pipeline-runner.cjs`

## Transform Engine

Supported built-in transforms:

- `trim`
- `upper`
- `lower`
- `toNumber`
- `toDate`
- `defaultValue`
- `concat`
- `dictMap`

Transforms can be a string, one object, or an array of steps. User JavaScript is
not supported. `targetField` paths reject unsafe segments (`__proto__`,
`constructor`, and `prototype`) before writing nested output objects.

`transformRecord(sourceRecord, fieldMappings)` returns:

```js
{
  ok,
  value,
  errors
}
```

Transform failures are per-record data outcomes and become dead letters; they do
not crash the whole run.

## Validator

Supported validation rules:

- `required`
- `pattern`
- `enum`
- `min`
- `max`

`validateRecord(record, fieldMappings)` returns structured errors instead of
throwing.

## Idempotency

`computeRecordIdempotencyKey()` produces:

```text
idem_<sha256>
```

The key is based on:

- source system
- source object
- source id
- revision
- target system

The runner writes `_integration_idempotency_key` into each target record and
uses it as the target adapter upsert key field.

If idempotency calculation fails for one source record, the run records a
single `IDEMPOTENCY_FAILED` dead letter and continues processing other records.

## Watermark

Watermark support is intentionally minimal:

- `updated_at`
- `monotonic_id`

The runner reads the current watermark before incremental runs and only advances
it when the run has no failed rows. Failed or partial batches leave the previous
watermark unchanged.

Watermark advancement uses `advanceWatermark()` so a later completion cannot
move the stored watermark backwards in the normal store path.

## Dead Letters

`dead-letter.cjs` writes failed records into `integration_dead_letters`.

Current failure sources:

- transform failure
- validation failure
- idempotency failure
- target write failure
- unmatched target write error
- aggregate target write failure

Dead letters store sanitized and size-capped source payload, transformed
payload when available, error code/message, run id, pipeline id, and idempotency
key when known.

Target adapter write failures create dead letters even when the adapter returns
a failed count without item-level error details.

## Run Log

`run-log.cjs` wraps the pipeline registry run ledger:

- create running run row
- finish succeeded/partial/failed run
- record row counters and duration

## Runner Flow

`createPipelineRunner(...).runPipeline(input)`:

1. Load pipeline with field mappings.
2. Load source and target external systems.
3. Create source and target adapters through the adapter registry.
4. Create a running run log.
5. Read source records page by page.
6. Transform each record.
7. Validate transformed records.
8. Write valid records to the target adapter using `_integration_idempotency_key`.
9. Normalize target adapter result accounting and write failed records to dead letter.
10. Advance watermark only if there were no failed rows.
11. Finish run as `succeeded`, `partial`, or `failed`.

Dry runs cap `sampleLimit` across the whole run, not just per source page, and
never write target rows, dead letters, or watermarks. Dry-run still reads the
source adapter and still creates/finishes a run log.

Target adapter results are normalized before run accounting:

- `effectiveFailed = max(writeResult.failed, writeResult.errors.length)`.
- itemized errors must match by `index`, `idempotencyKey`, `key`, or
  `record._integration_idempotency_key`.
- unmatched itemized errors become adapter-level dead letters and are not bound
  to the first clean record.
- aggregate failures without itemized errors create a single aggregate
  dead-letter containing the failed count.

Preview and dead-letter payloads pass through integration payload redaction so
credential-like keys and raw payload blobs are not returned or stored verbatim.
Dead-letter payloads that exceed the storage cap are marked
`payloadTruncated: true` and are rejected by replay with `PAYLOAD_TRUNCATED`.

## Credential Handoff

The runner calls `externalSystemRegistry.getExternalSystemForAdapter()` when it
is available. That internal method hydrates decrypted credentials for adapter
construction while public registry reads still return only safe credential
metadata.

## Runtime Exposure

The `integration-core` communication namespace exposes:

```js
runPipeline(input)
```

`getStatus()` includes:

```json
{
  "runner": true
}
```

## Deferred

- Per-adapter retry/backoff/rate-limit policy.
- Live K3 WISE/Yuantus/Postgres customer adapters.
- Live Postgres E2E for the whole runner.
- encrypted replay-payload storage for sensitive or oversized dead letters.
- cross-plugin communication caller identity and tenant/scope authorization.
