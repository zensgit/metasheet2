# On-Prem Migration Gap Guard Verification - 2026-05-14

## Scope

This verification covers the regression guard for superseded legacy SQL
migrations in Windows/on-prem packages.

The guard is intentionally narrow:

- prove `037_add_gallery_form_support` is a no-op marker by default
- prove `038_config_and_secrets` is a no-op marker by default
- prove the explicit audit opt-in can still expose both real SQL migration
  names
- prove the package verifier checks for these migration bridge entries

## Local Verification

### Migration provider unit tests

Command:

```bash
pnpm --filter @metasheet/core-backend exec vitest run tests/unit/migration-provider.test.ts tests/unit/gallery-form-sql-migration.test.ts tests/unit/users-must-change-password-migration.test.ts --watch=false
```

Result:

- 3 files passed.
- 12 tests passed.

Expected coverage:

- superseded legacy SQL marker mode includes `037_add_gallery_form_support`
  and `038_config_and_secrets`
- marker-mode `up()` resolves without executing SQL
- explicit audit mode still exposes the real SQL migration names
- gallery/form SQL bridge tests remain green
- users `must_change_password` bridge tests remain green

### Script syntax checks

Commands:

```bash
bash -n scripts/ops/multitable-onprem-package-build.sh
bash -n scripts/ops/multitable-onprem-package-verify.sh
```

Result:

- Passed with exit code 0.

### Package contract

Command:

```bash
scripts/ops/multitable-onprem-package-build.sh
scripts/ops/multitable-onprem-package-verify.sh <generated-package.zip>
```

Result:

- Package build passed with `BUILD_WEB=1` and `BUILD_BACKEND=1`.
- Frontend build passed; Vite emitted the existing large-chunk warning.
- Backend `tsc` build passed.
- Package verifier passed against:
  `output/releases/multitable-onprem/metasheet-multitable-onprem-v2.5.0-gap-guard-20260514.zip`.

Expected package verifier coverage:

- packaged `migration-provider.js` contains
  `MIGRATION_INCLUDE_SUPERSEDED_LEGACY_SQL`
- packaged `migration-provider.js` contains
  `037_add_gallery_form_support`
- packaged `migration-provider.js` contains `038_config_and_secrets`
- packaged docs include this development and verification note

### Diff hygiene

Command:

```bash
git diff --check
```

Result:

- Passed with exit code 0.

## Deployment Impact

- No live 142 deployment was touched.
- No production database was touched.
- No migration file was added.
- No runtime API behavior was changed.
- This is a tests/package-verifier hardening slice for the on-prem upgrade
  path.

## Operator Note

For normal upgrades, leave `MIGRATION_INCLUDE_SUPERSEDED_LEGACY_SQL` unset.
Setting it to `true` is only for compatibility audits and can intentionally
re-expose legacy SQL migrations that are not safe to replay against every
newer on-prem schema.
