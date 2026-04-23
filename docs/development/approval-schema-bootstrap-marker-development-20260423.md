# Approval Schema Bootstrap Marker Development - 2026-04-23

## Scope

This change hardens the approval integration-test schema bootstrap so multiple approval API test files can run in the same Vitest invocation against one shared local Postgres database.

The previous helper already used `pg_advisory_xact_lock`, but the lock only serialized bootstrap callers. It did not prevent this sequence:

1. Worker A acquires the lock, runs the full DDL bootstrap, commits, and starts its HTTP server.
2. Worker B then acquires the lock and repeats the same DDL.
3. Worker B's `ALTER TABLE` / index statements can conflict with worker A's live API queries, producing a Postgres deadlock.

## Change

`ensureApprovalSchemaReady()` now combines two guards:

- `pg_advisory_xact_lock(hashtext('approval-schema-bootstrap'))` serializes concurrent bootstrap entry.
- `approval_test_schema_bootstrap_state` stores a DB-persisted bootstrap version marker.

Under the advisory lock, the helper now:

1. Creates the marker table if missing.
2. Reads `key='approval-schema-bootstrap'`.
3. If the stored version is `20260423-once-per-db`, commits and returns without running DDL.
4. Otherwise runs the full approval schema DDL.
5. Upserts the marker version at the end of the same transaction.

This makes the first worker perform the full bootstrap and makes later workers skip repeat DDL after the schema has already been materialized.

## Files

- `packages/core-backend/tests/helpers/approval-schema-bootstrap.ts`

## Design Notes

- The marker is DB-scoped rather than process memory, because Vitest file workers run independently.
- The marker is versioned so future helper changes can intentionally force one new bootstrap pass by bumping `APPROVAL_SCHEMA_BOOTSTRAP_VERSION`.
- The marker table is test-only and lives alongside the approval test schema in local/integration databases.
- The marker is written only after all DDL succeeds, so a failed bootstrap does not poison later retries.

## Non-Goals

- No production migration.
- No runtime service code change.
- No attempt to suppress unrelated degraded-mode startup logs for absent BPMN/EventBus/Automation tables in the local test database.

