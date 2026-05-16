# Data Factory Issue 651 C1 Record Create Repair - Development Notes

Date: 2026-05-16

## Context

Run29 confirmed the Data Factory and K3 setup frontend package was updated: Gate A/B, C2, and C4 passed, and C3 started showing the effective `default:integration-core` scope. C1 still failed on the physical on-prem box:

```json
{
  "ok": false,
  "error": {
    "code": "INTERNAL_ERROR",
    "message": "Failed to create meta record"
  }
}
```

The observed path is the real staging multitable route:

1. Data Factory staging card creates or resolves open links.
2. Operator opens the generated `/multitable/<sheetId>/<viewId>?baseId=...` route.
3. `+ New Record` calls `POST /api/multitable/records`.
4. Empty record creation should stop at field validation and show a required-field toast.

## Root-Cause Model

The code path already converts `RecordValidationFailedError` into HTTP 422. If the physical box still returns generic 500, the likely failure is earlier/later than that exact error type:

- older on-prem staging fields may exist without `property.validation`, so empty creates do not stop at required-field validation;
- then record creation reaches schema dependencies such as `meta_record_revisions`;
- if upgraded databases have a schema gap or a missing record-history table, that failure is currently classified as a generic 500 because `getDbNotReadyMessage()` did not recognize `meta_record_revisions`.

## Changes

### 1. On-Prem Repair Migration

Added `zzzz20260516113000_repair_onprem_multitable_record_create.ts`.

It is intentionally idempotent and additive:

- `ALTER TABLE meta_records ADD COLUMN IF NOT EXISTS created_by`;
- `ALTER TABLE meta_records ADD COLUMN IF NOT EXISTS modified_by`;
- `CREATE TABLE IF NOT EXISTS meta_record_revisions`;
- recreates the related revision indexes with `IF NOT EXISTS`;
- backfills `property.validation=[{ "type": "required" }]` onto existing `plugin-integration-core` staging fields by object and field name.

This makes the deployed database self-heal during migration instead of relying on operators to reinstall staging tables manually.

### 2. DB-Not-Ready Classification

`getDbNotReadyMessage()` now recognizes:

- `meta_record_revisions`;
- `meta_record_subscriptions`;
- `meta_record_subscription_notifications`;
- `plugin_multitable_object_registry`.

If a future upgraded box still has a missing multitable dependency, the API returns `503 DB_NOT_READY` instead of a misleading `500 INTERNAL_ERROR`.

### 3. Tests

Added a migration structure unit test and extended direct record-create integration coverage:

- required-field create still returns the multitable 422 envelope;
- missing `meta_record_revisions` now maps to `503 DB_NOT_READY`.

## Deployment Impact

This is backend, migration, and package-verifier only. It does not touch
integration-core runtime code, frontend routes, or K3 WebAPI behavior.

`scripts/ops/multitable-onprem-package-verify.sh` now requires the built package
to include `zzzz20260516113000_repair_onprem_multitable_record_create.js` and
checks that the packaged migration contains both the record-history repair and
the integration staging validation repair. That turns a stale on-prem package
into a Gate A failure before it reaches the physical box.

Expected on-prem effect after deploying a rebuilt package:

- migrations run the repair automatically;
- old staging fields gain required validation;
- `+ New Record` on Standard Materials should return field-level validation instead of inserting a blank row or falling through to record-history schema errors;
- if the DB has a deeper missing multitable dependency, the response becomes `DB_NOT_READY` and points to migrations instead of hiding behind the generic create-record failure.
