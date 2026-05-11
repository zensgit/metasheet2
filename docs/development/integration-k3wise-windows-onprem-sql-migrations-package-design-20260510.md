# Design: Package Core SQL Migrations in the Windows On-Prem Build

**Date**: 2026-05-10
**Scope**:
- `scripts/ops/multitable-onprem-package-build.sh`
- `scripts/ops/multitable-onprem-package-verify.sh`

---

## 1. Problem

A Windows K3 WISE on-prem deployment reached the login screen but the backend
failed while querying the `users` table because the database did not have the
`must_change_password` column.

The field is not a new runtime-only assumption. It already has a SQL migration:

```
packages/core-backend/migrations/056_add_users_must_change_password.sql
```

The deploy package included the compiled migration runner:

```
packages/core-backend/dist/src/db/migrate.js
```

but it did not include the source SQL migration directory:

```
packages/core-backend/migrations/
```

That means the packaged runner could start, but it could not see numeric SQL
migrations such as `056_add_users_must_change_password.sql`.

## 2. Runtime Contract

`packages/core-backend/src/db/migration-provider.ts` loads SQL migrations from
several candidate folders. In a packaged runtime, `__dirname` resolves under:

```
packages/core-backend/dist/src/db
```

The provider's SQL folder candidates include:

```
../../../migrations
```

which maps to:

```
packages/core-backend/migrations
```

Therefore the durable fix is to ship that directory in the on-prem package.
Changing auth code or adding a one-off bootstrap `ALTER TABLE` would only hide
the packaging bug and would not protect the next SQL migration.

## 3. Change

The package build manifest now includes:

```
packages/core-backend/migrations
```

The package verifier now requires the critical SQL migrations currently needed
by Windows/K3 WISE on-prem deployments:

```
packages/core-backend/migrations/056_add_users_must_change_password.sql
packages/core-backend/migrations/057_create_integration_core_tables.sql
packages/core-backend/migrations/058_integration_runs_running_unique.sql
packages/core-backend/migrations/059_integration_runs_history_index.sql
```

The verifier checks specific files rather than only the directory so a future
package cannot pass while silently omitting the migrations that unblock login
and the integration-core schema.

## 4. Non-Goals

- No runtime behavior change.
- No database schema change beyond allowing existing migrations to ship.
- No manual bootstrap SQL.
- No K3 WISE adapter or pipeline behavior change.

## 5. Deployment Impact

The next generated Windows/on-prem package includes the SQL migration directory.
Existing deployments that already hand-added `users.must_change_password` do not
need to undo anything. New deployments should no longer require that manual
column patch, provided the package deploy runs the existing migration command.
