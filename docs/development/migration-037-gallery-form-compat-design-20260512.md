# Migration 037 Gallery/Form Compatibility Fix

## Purpose

Fix the on-prem upgrade failure reported in #651:

```text
037_add_gallery_form_support failed because form_responses.form_id does not exist
```

The failure appears when a database has already received the timestamp-based
view/form migrations, then later receives the legacy numeric SQL migration
`037_add_gallery_form_support.sql` through the packaged migration provider.

## Root Cause

`037_add_gallery_form_support.sql` used table-level guards:

```sql
CREATE TABLE IF NOT EXISTS form_responses (...)
```

That is not enough for mixed migration histories. If `form_responses` already
exists with the timestamp migration shape:

```text
form_responses(view_id, data, submitted_by, submitted_at, status, ...)
```

then `CREATE TABLE IF NOT EXISTS` is a no-op. The migration then immediately
ran:

```sql
CREATE INDEX IF NOT EXISTS idx_form_responses_form_id ON form_responses(form_id);
```

That column only exists in the older 037 table shape, so PostgreSQL correctly
failed the migration.

The same class of issue also existed later in the migration for:

- `view_configs` optional indexes and demo seed rows
- `view_states.updated_at` trigger creation
- `view_states.state_data` comments
- `form_responses.response_data` comments

Those would be the next upgrade traps after `form_id` was fixed.

## Design

The migration remains forward-only and idempotent. It does not rewrite existing
timestamp-based tables into the older 037 shape.

Instead, 037 now uses column-aware guards before every optional index, trigger,
and column comment:

- If the old 037-created table exists, the matching indexes/comments/triggers
  are still created.
- If the newer timestamp-created table already exists, incompatible 037-only
  references are skipped.
- Existing `view_id/data` form response schema stays intact.

This is intentionally narrower than adding compatibility columns such as
`form_id` and `response_data`. The current runtime code uses the timestamp-based
view/form schema, and adding unused alias columns would make the production
schema harder to reason about.

## Files Changed

- `packages/core-backend/migrations/037_add_gallery_form_support.sql`
  - Guard `view_configs` indexes by column existence.
  - Guard `view_configs` demo seed rows by the full legacy 037 seed column
    shape.
  - Guard `view_states` index and `updated_at` trigger by column existence.
  - Guard `form_responses` indexes by column existence, especially `form_id`.
  - Guard optional column comments by column existence.
- `packages/core-backend/tests/unit/gallery-form-sql-migration.test.ts`
  - Static regression tests for the compatibility guards.

## Deployment Impact

This fix changes only the migration script and a unit test. It has no runtime
API, frontend, or K3 WISE business logic impact.

For an on-prem host currently stuck before applying 037:

1. Deploy a package containing this fix.
2. Re-run the normal on-prem migration step.
3. The old timestamp-shaped `form_responses(view_id, data, ...)` table should
   no longer block 037.

## Non-goals

- Do not merge the numeric and timestamp migration systems in this PR.
- Do not add a new migration ledger.
- Do not rewrite `form_responses` data.
- Do not change K3 WISE template behavior.
