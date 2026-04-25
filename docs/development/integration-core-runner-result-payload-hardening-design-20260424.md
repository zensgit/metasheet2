# Integration Core Runner Result/Payload Hardening Design - 2026-04-24

## Context

The adapter runner composition exposed two runtime risks:

- adapters can return inconsistent `createUpsertResult()` shapes, such as
  `failed = 0` with non-empty `errors[]`.
- integration payloads can carry credentials or raw vendor blobs into dry-run
  preview, dead-letter storage, and admin payload reads.

## Target Result Normalization

`pipeline-runner.cjs` now normalizes target write results before updating run
metrics:

```text
effectiveFailed = max(writeResult.failed, writeResult.errors.length)
```

That means itemized adapter errors always make the run `partial`, block
watermark advancement, and create dead letters even if the adapter forgot to
increment `failed`.

Itemized target errors are matched to clean records by:

- explicit `index`
- `idempotencyKey`
- `key`
- `record._integration_idempotency_key`
- target record business keys such as `FNumber` or `code`

If no match exists, the runner creates a minimal adapter-level dead letter with
`TARGET_WRITE_UNMATCHED_ERROR`. It no longer falls back to `cleanRecords[0]`.

If the adapter reports `failed > 0` but provides no itemized errors, the runner
creates one aggregate dead letter with `TARGET_WRITE_AGGREGATE_FAILED` and the
failed count. It does not bind the aggregate failure to a random source row.

## Payload Redaction

Added `plugins/plugin-integration-core/lib/payload-redaction.cjs`.

The redactor recursively replaces sensitive keys with `[redacted]`, caps very
large strings, and handles cycles/depth limits. Sensitive keys include:

```text
password
token
apiKey
accessToken
refreshToken
authorization
cookie
privateKey
sessionId
credentials
rawPayload
```

Applied to:

- dry-run preview source/transformed records.
- transform/validation/idempotency dead-letter payloads.
- target write dead-letter payloads.

Non-admin dead-letter list responses still omit payloads entirely.

Dead-letter store also performs final redaction and enforces a 32KB JSON payload
cap. Oversized payloads are stored as:

```js
{
  payloadTruncated: true,
  originalBytes,
  preview
}
```

Replay rejects truncated payload envelopes with `PAYLOAD_TRUNCATED` instead of
silently replaying a diagnostic preview as if it were the original source
record.

## Deferred

- live customer payload redaction review for K3 WISE/Yuantus-specific fields.
- configurable redaction allow/deny policy per tenant.
- split `diagnosticPayload` and encrypted `replayPayload` storage for cases
  that require replaying sensitive or large source records.
- stricter adapter contract validation that rejects inconsistent upsert results
  instead of tolerating them.
- REST admin payload response behavior.
- ERP feedback writeback.
- cross-plugin communication caller identity and tenant/scope authorization was
  closed by
  `integration-core-communication-guard-design-20260425.md` for write APIs.
