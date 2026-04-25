# Integration Core Runner Result/Payload Hardening Verification - 2026-04-24

## Scope

Verify runner result normalization and payload redaction:

- adapter `errors[]` count as failures even when `failed = 0`.
- unmatched target errors do not attach to the first source record.
- aggregate target failures without itemized errors create aggregate dead
  letters.
- dry-run preview and dead-letter payloads redact sensitive keys.
- oversized dead-letter payloads are capped and cannot be replayed silently.

## Commands Run

```bash
pnpm -F plugin-integration-core test:external-systems
pnpm -F plugin-integration-core test:payload-redaction
pnpm -F plugin-integration-core test:pipeline-runner
pnpm -F plugin-integration-core test:runtime
```

```bash
node -c plugins/plugin-integration-core/lib/payload-redaction.cjs
node -c plugins/plugin-integration-core/lib/pipeline-runner.cjs
node -c plugins/plugin-integration-core/lib/external-systems.cjs
pnpm -F plugin-integration-core test
node --import tsx scripts/validate-plugin-manifests.ts
git diff --check -- plugins/plugin-integration-core docs/development/integration-core-*
```

## Results

- targeted external-system, payload-redaction, pipeline-runner, and runtime
  tests pass.
- changed modules pass Node syntax checks.
- full `plugin-integration-core` package test passes.
- plugin manifest validation passes: 13 valid, 0 invalid, 10 existing unrelated
  warnings.
- `git diff --check` passes.

## Covered Behaviors

`pipeline-runner.test.cjs` covers:

- dry-run preview redacts `password`, `Authorization`, `token`, and
  `rawPayload`.
- dry-run still performs source reads but does not write target, dead letters,
  or watermarks.
- `failed > 0 && errors.length === 0` creates one
  `TARGET_WRITE_AGGREGATE_FAILED` dead letter with failed count.
- `failed = 0 && errors.length > 0` still marks the run `partial`, creates a
  dead letter, and does not advance watermark.
- unmatched target errors create `TARGET_WRITE_UNMATCHED_ERROR` and preserve a
  minimal adapter error payload instead of binding to the first clean record.
- replay of a truncated dead-letter payload fails with
  `PAYLOAD_TRUNCATED` before any target write.

`payload-redaction.test.cjs` covers:

- sensitive key matching for `Authorization`, `x-api-key`, `password`, `token`,
  `cookie`, and `rawPayload`.
- non-secret config names such as `apiKeyHeader` and `tokenPath` are not
  treated as sensitive payload keys.
- recursion, cycle handling, and long-string truncation.
- JSON byte-size capping produces a `payloadTruncated` envelope.

`runner-support.test.cjs` covers:

- dead-letter store final redaction for payloads written directly to the store.
- oversized dead-letter payloads are compacted before persistence.

`plugin-runtime-smoke.test.cjs` covers:

- communication `upsertExternalSystem()` rejects nested secret config through
  the registry path.
- follow-up communication write caller and tenant authorization is covered by
  `integration-core-communication-guard-verification-20260425.md`.

## Not Covered

- live Postgres dead-letter JSON byte-size enforcement.
- live K3 WISE/Yuantus payload samples.
- tenant-configurable redaction policy.
- encrypted replay-payload storage for sensitive or oversized source records.
