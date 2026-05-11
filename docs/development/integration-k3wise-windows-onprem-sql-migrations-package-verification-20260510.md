# Verification: Core SQL Migrations Are Bundled in the Windows On-Prem Package

**Date**: 2026-05-10
**Design**:
`docs/development/integration-k3wise-windows-onprem-sql-migrations-package-design-20260510.md`

---

## 1. Root-Cause Check

The customer deployment symptom was consistent with a packaging miss:

- Backend code queries `users.must_change_password`.
- SQL migration `056_add_users_must_change_password.sql` exists in the repo.
- The generated package previously shipped `packages/core-backend/dist/src/db/migrate.js`.
- The generated package did not ship `packages/core-backend/migrations/*.sql`.

The migration provider reads packaged SQL migrations from
`packages/core-backend/migrations`, so bundling that directory closes the gap at
the package layer.

## 2. Expected Package Contents

The verifier now fails unless these files exist inside the package:

```
packages/core-backend/migrations/056_add_users_must_change_password.sql
packages/core-backend/migrations/057_create_integration_core_tables.sql
packages/core-backend/migrations/058_integration_runs_running_unique.sql
packages/core-backend/migrations/059_integration_runs_history_index.sql
```

`056` is the login unblocker. `057` through `059` are included because the K3
WISE package also ships integration operator tooling whose database contract is
backed by those SQL migrations.

## 3. Local Validation Commands

Executed before PR:

```
$ bash -n scripts/ops/multitable-onprem-package-build.sh
# exit 0

$ bash -n scripts/ops/multitable-onprem-package-verify.sh
# exit 0

$ git diff --check origin/main...HEAD
# exit 0

$ PACKAGE_TAG=sqlmig-local-20260510 scripts/ops/multitable-onprem-package-build.sh
# exit 0, zip and tgz generated under output/releases/multitable-onprem/

$ scripts/ops/multitable-onprem-package-verify.sh \
    output/releases/multitable-onprem/metasheet-multitable-onprem-v2.5.0-sqlmig-local-20260510.zip
metasheet-multitable-onprem-v2.5.0-sqlmig-local-20260510.zip: OK
[multitable-onprem-package-verify] Package verify OK
```

The generated zip contains the required SQL migrations:

```
$ unzip -l output/releases/multitable-onprem/metasheet-multitable-onprem-v2.5.0-sqlmig-local-20260510.zip \
    | rg 'packages/core-backend/migrations/(056|057|058|059)_'
... packages/core-backend/migrations/056_add_users_must_change_password.sql
... packages/core-backend/migrations/057_create_integration_core_tables.sql
... packages/core-backend/migrations/058_integration_runs_running_unique.sql
... packages/core-backend/migrations/059_integration_runs_history_index.sql
```

K3 WISE operator regressions:

```
$ pnpm verify:integration-k3wise:onprem-preflight
# 14/14 pass

$ pnpm verify:integration-k3wise:poc
# 37 tests pass + mock chain PASS
```

## 4. Deployment Expectation

For a fresh Windows/on-prem install, the operator should no longer need to run:

```
ALTER TABLE users ADD COLUMN must_change_password BOOLEAN NOT NULL DEFAULT FALSE;
```

The packaged migration command should apply the existing SQL migration instead.
If a database was already manually patched, the migration remains safe because
`056_add_users_must_change_password.sql` uses `ADD COLUMN IF NOT EXISTS`.

## 5. Codex Review Verification - 2026-05-11

Executed during PR #1457 review after PR #1456 had advanced `origin/main`:

```
$ bash -n scripts/ops/multitable-onprem-package-build.sh
# exit 0

$ bash -n scripts/ops/multitable-onprem-package-verify.sh
# exit 0

$ for f in \
    packages/core-backend/migrations/056_add_users_must_change_password.sql \
    packages/core-backend/migrations/057_create_integration_core_tables.sql \
    packages/core-backend/migrations/058_integration_runs_running_unique.sql \
    packages/core-backend/migrations/059_integration_runs_history_index.sql; do test -f "$f"; done
required SQL migrations present

$ OUTPUT_DIR=/tmp/ms2-onprem-sqlmig-package \
    PACKAGE_TAG=sqlmig-review-20260511 \
    scripts/ops/multitable-onprem-package-build.sh
# exit 0, zip and tgz generated under /tmp/ms2-onprem-sqlmig-package

$ scripts/ops/multitable-onprem-package-verify.sh \
    /tmp/ms2-onprem-sqlmig-package/metasheet-multitable-onprem-v2.5.0-sqlmig-review-20260511.zip
metasheet-multitable-onprem-v2.5.0-sqlmig-review-20260511.zip: OK
[multitable-onprem-package-verify] Package verify OK

$ unzip -l /tmp/ms2-onprem-sqlmig-package/metasheet-multitable-onprem-v2.5.0-sqlmig-review-20260511.zip \
    | rg 'packages/core-backend/migrations/(056|057|058|059)_'
... packages/core-backend/migrations/056_add_users_must_change_password.sql
... packages/core-backend/migrations/057_create_integration_core_tables.sql
... packages/core-backend/migrations/058_integration_runs_running_unique.sql
... packages/core-backend/migrations/059_integration_runs_history_index.sql
```

The review found and fixed one markdown whitespace issue in the design file
before re-running `git diff --check`.
