# Data Factory DF-N2-1 provenance contracts design - 2026-05-26

## Purpose

This slice is the first unlocked Data Factory Stage 2 step: **DF-N2-1 contracts only**.

It freezes the provenance event shape that later DF-N2 runtime work may append and query. It does not create a storage path, route, migration, runner hook, replay policy, UI timeline, K3 read/list expansion, or any K3 write behavior.

## Scope

Changed contract surfaces:

- `plugins/plugin-integration-core/lib/provenance-contracts.cjs`
  - `PROVENANCE_EVENT_TYPES`
  - `ProvenanceContractValidationError`
  - `normalizeProvenanceEvent(input)`
  - `normalizeProvenanceEvents(input)`
- `packages/openapi/src/base.yml`
  - `ProvenanceEventType`
  - `ProvenanceEvent`
- generated OpenAPI dist files from the source schema
- focused plugin tests and package test wiring

The contract uses the 11 event types from the gated DF-N2 plan:

- `source_read`
- `row_imported`
- `row_edited`
- `mapping_applied`
- `validation_failed`
- `dry_run_previewed`
- `target_write_attempted`
- `target_write_succeeded`
- `target_write_failed`
- `row_retried`
- `row_exported`

`row_skipped` remains a NiFi-benchmark follow-up candidate, not an accepted DF-N2-1 event type.

## Contract

The normalized event shape is:

```json
{
  "runId": "run_...",
  "rowId": "row_...",
  "eventType": "source_read",
  "at": "2026-05-26T15:00:00.000Z",
  "attrs": {}
}
```

Rules:

- `runId`, `rowId`, `eventType`, and `at` are required non-empty strings.
- `eventType` must be one of `PROVENANCE_EVENT_TYPES`; invalid values reject rather than silently default.
- `at` accepts an ISO-like date string or `Date` and normalizes to ISO.
- `attrs` must be a plain object and is sanitized before returning.
- unsafe prototype keys are dropped by the shared integration payload sanitizer.
- token/password/session/header/raw-payload keys are redacted by the existing sanitizer.
- this slice extends the sanitizer to key-redact connection-string shaped fields such as `connectionString`, `databaseUrl`, and `jdbcUrl`, because provenance evidence must never expose connection strings.

## OpenAPI Boundary

This PR adds schema components only. It intentionally adds no OpenAPI path.

The future DF-N2-2 runtime PR is responsible for any by-`rowId` GET route, RBAC read permission, storage, and wire-vs-fixture route tests. Adding only the component here lets downstream contracts agree on event shape without implying that provenance is queryable today.

## Explicit Non-Goals

- no `integration_run_log` / `integration_exceptions` JSONB migration
- no `integration_provenance_by_row` view
- no pipeline runner append calls
- no by-`rowId` read route
- no frontend lineage timeline
- no retry/back-pressure changes
- no K3 Save / Submit / Audit / BOM / multi-record work
- no generic K3 read/list expansion

## Follow-Up Gate

DF-N2-2 remains gated behind a separate opt-in. It should start only after this contract PR is merged and should use this module as the contract source for runtime event validation/redaction.
