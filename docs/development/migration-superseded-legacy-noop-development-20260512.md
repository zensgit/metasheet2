# Superseded Legacy SQL No-op Migration Provider Development

## Summary

142 deployment of the DingTalk closeout image reached healthy containers, but
the GitHub deploy job failed during `db:migrate` with Kysely reporting a
corrupted migration history. The deployed database already contained legacy SQL
migration records `032_create_approval_records` through
`055_create_attendance_import_tokens`, while the latest migration provider hid
those names by default.

This change keeps superseded legacy SQL migrations visible to Kysely as no-op
history markers. That preserves the intended fresh-install behavior: the old SQL
bodies are not replayed. It also makes upgraded databases with existing
`kysely_migration` rows valid again.

## Root Cause

Kysely treats an executed migration row as corrupted if the current provider no
longer returns that migration name. The prior skip-list implementation filtered
`032` through `055` out of the provider response. That is safe only for fresh
databases that never recorded those names; it is unsafe for upgraded production
databases that already executed them historically.

## Implementation

- Added `createNoopMigration()` in the core backend migration provider.
- Split default superseded legacy handling from explicit operator exclusions.
- Replaced loaded superseded legacy SQL migrations with no-op migrations instead
  of filtering them out.
- Preserved `MIGRATION_INCLUDE_SUPERSEDED_LEGACY_SQL=true` and
  `includeSupersededLegacySqlMigrations: true` for compatibility audits that
  need the real legacy SQL body.
- Preserved `MIGRATION_EXCLUDE` / `excludedNames` as an explicit operator escape
  hatch that can still hide migrations.
- Updated migration-provider tests and existing migration design/verification
  docs to describe no-op markers instead of complete absence.

## Changed Files

- `packages/core-backend/src/db/migration-provider.ts`
- `packages/core-backend/tests/unit/migration-provider.test.ts`
- `docs/development/migration-legacy-sql-skip-design-20260512.md`
- `docs/development/migration-legacy-sql-skip-verification-20260512.md`
- `docs/development/migration-superseded-legacy-noop-development-20260512.md`
- `docs/development/migration-superseded-legacy-noop-verification-20260512.md`

## Deployment Impact

Fresh databases still avoid replaying the superseded `032` through `055` SQL
bodies. Upgraded databases that already have those names in `kysely_migration`
now pass Kysely migration history validation. No table drops, data backfills, or
manual database edits are introduced.

## Rollback

Rollback is the previous GHCR backend/web tag. If a deploy issue appears after
this patch, switch `metasheet-backend` and `metasheet-web` back to the previous
known-good image tag and verify `/api/health`, `/`, and `/api/auth/me` returns
`401` when unauthenticated.
