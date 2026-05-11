# On-Prem Plugin Infrastructure Migration Compatibility Design

## Context

Windows/on-prem deployment failed while applying `008_plugin_infrastructure.sql`.
The upgraded package now ships the legacy SQL migration folder, so databases that
previously ran the newer TypeScript migration
`20250924180000_create_plugin_management_tables.ts` can encounter `008` for the
first time.

That existing TypeScript schema is not identical to the legacy SQL schema:

- `plugin_configs` exists but lacks `config_key`, `scope`, `value`,
  `encrypted`, and `updated_at`.
- `plugin_registry.capabilities` and `plugin_registry.permissions` may be
  `jsonb`, while `008` creates views using `array_length(...)` as if they were
  `text[]`.
- `plugin_security_audit` exists with `event_type` / `resource` columns, while
  `008` later indexes `operation` / `result`.
- `plugin_cache` may lack `updated_at`, while `008` installs an update trigger
  that writes that column.

The visible deployment failure was the first item: the partial indexes in `008`
referenced `scope` after `CREATE TABLE IF NOT EXISTS plugin_configs` skipped the
already-existing table.

## Change

`packages/core-backend/migrations/008_plugin_infrastructure.sql` now contains
compatibility guards immediately after the relevant `CREATE TABLE IF NOT EXISTS`
statements:

1. Normalize `plugin_registry.capabilities` and `permissions` from `jsonb` to
   `text[]` when an older table already exists.
2. Add the scoped config columns that `008` expects to `plugin_configs` when the
   older table already exists.
3. Backfill `plugin_configs.value` from the old `config` JSON column when that
   column exists.
4. Add `idx_plugin_configs_scoped_identity`, matching the expression conflict
   target used by `PluginConfigManager`.
5. Add missing `plugin_security_audit` columns before `008` creates indexes on
   them, preserving old `event_type` and `resource` values into the new columns.
6. Add `plugin_cache.updated_at` before installing the update trigger.

## Non-Goals

- No new feature behavior is introduced.
- No integration-core API contract changes are made.
- No destructive cleanup is performed on old compatibility columns such as
  `plugin_configs.config` or `plugin_security_audit.event_type`; old data stays
  readable for any legacy route still expecting those columns.
- This does not mark the customer K3 live GATE as complete. It only unblocks
  package migration on an already-upgraded on-prem database.

## Deployment Impact

The change is migration-only plus a unit regression test. Existing on-prem
deployments should be able to re-run the deploy package; PostgreSQL
`ADD COLUMN IF NOT EXISTS` and guarded conversion blocks keep the migration
idempotent.

If a previous deploy failed while applying `008`, the same deploy flow should be
safe to retry after installing a package containing this fix.
