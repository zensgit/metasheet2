# Core Backend Migration CLI Flags Design - 2026-04-27

## Context

`packages/core-backend/package.json` exposes four database scripts:

- `migrate` / `db:migrate`
- `db:list`
- `db:rollback`
- `db:reset`

Before this change, `src/db/migrate.ts` ignored command-line arguments and always executed `migrateToLatest()`. That made the package scripts misleading: operators could run `db:list`, `db:rollback`, or `db:reset` and still mutate the database by applying pending migrations.

## Goals

- Preserve the default no-argument behavior: migrate to latest.
- Make `--list` read-only and useful before production migrations.
- Make `--rollback` perform exactly one migration step down.
- Make `--reset` explicit and gated because it is destructive.
- Keep the CLI small enough to remain suitable for local development, CI smoke checks, and operator runbooks.

## Command Contract

| Command | Behavior |
| --- | --- |
| no flag / `--latest` | Run `migrateToLatest()` |
| `--list` | Print applied count and pending migration names |
| `--rollback` | Run one `migrateDown()` step |
| `--reset` | Run `migrateTo(NO_MIGRATIONS)` only when `ALLOW_DB_RESET=true` |
| `--help` / `-h` | Print usage and exit without touching the database |

If multiple known flags are passed, the first recognized flag wins. Unknown flags are ignored so existing wrappers that pass extra process arguments do not break the default path.

## Safety Choices

- `--reset` checks `ALLOW_DB_RESET=true` before constructing the migrator.
- `--list` reports pending migrations in provider load order and does not call a mutating migrator method.
- Error handling is centralized through `exitOnError()` so rollback/reset/latest all report failed migration names before exiting non-zero.
- `allowUnorderedMigrations` remains enabled because deployed environments can already contain later migrations from previous PR ordering.

## Files

- `packages/core-backend/src/db/migrate.ts`
- `packages/core-backend/package.json`

## Non-Goals

- This does not add multi-step rollback, dry-run SQL rendering, or interactive prompts.
- This does not change migration provider ordering or migration table naming.
- This does not replace CI migration replay; it only makes the operator-facing CLI honor the existing scripts.
