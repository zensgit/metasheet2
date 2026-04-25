# Integration Core Pipeline Runner Verification - 2026-04-24

## Scope

Verify the stacked M1 runner slice for `plugin-integration-core`:

- built-in transform execution.
- structured validation errors.
- idempotency key generation.
- watermark get/set and max derivation.
- dead-letter creation/list/replayed status.
- run-log wrapper behavior.
- runner E2E for cleanse, idempotency, and incremental processing.

This PR4 detached extraction is based on the validated PR3 tree and includes
the adapter contract, pipeline registry, runner, and runner support modules.
REST control-plane, K3 WISE, PLM, and ERP feedback slices remain excluded.

## Commands Run

```bash
pnpm -F plugin-integration-core test
node --import tsx scripts/validate-plugin-manifests.ts
git diff --check
```

## Results

- `plugin-integration-core` package tests: passed.
- New `transform-validator.test.cjs`: passed.
- New `runner-support.test.cjs`: passed.
- New `pipeline-runner.test.cjs`: passed.
- Plugin manifest validation through `node --import tsx`: passed, 13/13 valid,
  0 errors.
- `git diff --check`: passed.

`pnpm validate:plugins` remains blocked in this sandbox by the known `tsx` IPC
`listen EPERM` restriction. The equivalent direct `node --import tsx` command
was used instead.

## Covered Behaviors

`transform-validator.test.cjs` covers:

- `trim`, `upper`, `toNumber`, `defaultValue`, `dictMap`, and `concat`.
- transform pipeline arrays.
- default value application.
- transform failure returns `TRANSFORM_FAILED`.
- unsafe output paths cannot pollute `Object.prototype`.
- validation `required`, `pattern`, `enum`, `min`, and `max`.

`runner-support.test.cjs` covers:

- stable idempotency key generation.
- deriving max `updated_at` watermark.
- inserting and updating watermarks.
- `advanceWatermark()` does not move monotonic watermarks backwards.
- creating/listing/marking dead letters replayed.
- run-log start/finish wrapper behavior.

`pipeline-runner.test.cjs` covers:

- source record cleansing before target write.
- invalid source record goes to dead letter.
- partial run does not advance watermark.
- idempotency failure creates one dead letter instead of failing the whole run.
- target failed count without item errors creates one aggregate dead letter and
  does not bind the failure to the first source record.
- adapter `errors[]` count as failures even when `failed` is incorrectly
  reported as `0`.
- unmatched target errors become `TARGET_WRITE_UNMATCHED_ERROR` dead letters
  instead of attaching to the first clean record.
- dry-run preview payloads redact `password`, `token`, `Authorization`, and
  `rawPayload`.
- truncated dead-letter payload replay fails with `PAYLOAD_TRUNCATED` before
  target write.
- dry-run `sampleLimit` caps total sampled rows across pages.
- adapter creation receives internally hydrated credentials.
- idempotent target writes skip duplicates on repeated full run.
- successful incremental run advances watermark.
- second incremental run reads only records above stored watermark.

Runtime smoke tests cover:

- `getStatus().runner === true`.
- communication namespace exposes `runPipeline()`.

## Not Covered

- Live Postgres runner execution.
- Live external HTTP/PLM/ERP systems.
- live K3 WISE customer endpoint behavior.
- SQL Server middle-table or read-only reconciliation channel.
