# Core Backend Migration CLI Flags Verification - 2026-04-27

## Scope

This note verifies that `packages/core-backend/src/db/migrate.ts` now honors the CLI flags exposed by `packages/core-backend/package.json`.

## Static Review

- `db:list` maps to `tsx src/db/migrate.ts --list`.
- `db:rollback` maps to `tsx src/db/migrate.ts --rollback`.
- `db:reset` maps to `tsx src/db/migrate.ts --reset`.
- The script now dispatches by parsed command instead of always calling `migrateToLatest()`.
- `--reset` remains blocked unless `ALLOW_DB_RESET=true`.

## Local Verification Plan

Run from the PR worktree:

```bash
pnpm --filter @metasheet/core-backend exec tsx src/db/migrate.ts --help
pnpm --filter @metasheet/core-backend exec tsx src/db/migrate.ts --list
pnpm --filter @metasheet/core-backend exec tsx src/db/migrate.ts --reset
```

Expected behavior:

- `--help` prints usage and exits 0.
- `--list` prints applied/pending counts without applying migrations.
- `--reset` exits non-zero without `ALLOW_DB_RESET=true`.

## Results

Local smoke passed against a throwaway Postgres instance started from `/opt/homebrew/bin/initdb` on a temporary port.

```text
help_first_line=Usage: tsx src/db/migrate.ts [flag]
list_counts=Applied: 0 | Pending: 154
reset_guard=Refusing to --reset without ALLOW_DB_RESET=true.
```

Interpretation:

- `--help` exits before a mutating migrator command.
- `--list` reads the migration provider and database state without applying pending migrations.
- `--reset` is blocked before constructing the migrator unless `ALLOW_DB_RESET=true`.
- The temporary Postgres cluster was stopped and deleted after the smoke run.

## CI Expectations

The existing migration replay job should remain green because the default no-argument migration path is unchanged.
