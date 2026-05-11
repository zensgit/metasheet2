# On-Prem Plugin Infrastructure Migration Compatibility Verification

## Local Checks

### Targeted Regression

```bash
pnpm --filter @metasheet/core-backend exec vitest run \
  tests/unit/plugin-infrastructure-sql-migration.test.ts \
  --watch=false
```

Result:

```text
Test Files  1 passed (1)
Tests       4 passed (4)
```

Coverage:

- `plugin_configs` compatibility columns are added before scoped indexes
  reference `scope`.
- The expression unique index required by `PluginConfigManager` is present.
- `plugin_registry` jsonb array normalization runs before plugin statistics
  views call `array_length(...)`.
- `plugin_security_audit` and `plugin_cache` compatibility columns are added
  before indexes/triggers reference them.

### Migration Provider Regression

```bash
pnpm --filter @metasheet/core-backend exec vitest run \
  tests/unit/migration-provider.test.ts \
  tests/unit/plugin-infrastructure-sql-migration.test.ts \
  --watch=false
```

Result:

```text
Test Files  2 passed (2)
Tests       8 passed (8)
```

This confirms the SQL migration folder still participates in the packaged
runtime migration provider and that the new `008` guards are present.

### Whitespace / Conflict Marker Check

```bash
git diff --check
```

Result: `0`.

## Environment-Limited Check

Attempted to start a local PostgreSQL container to run the exact SQL against a
simulated old plugin schema:

```bash
docker run -d --name ms2-mig-scope-pg \
  -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=ms2_mig_scope \
  -p 55436:5432 \
  postgres:15-alpine
```

Result:

```text
failed to connect to the docker API at unix:///Users/chouhua/.docker/run/docker.sock
```

The local Docker daemon is unavailable in this environment, so this PR relies on
static SQL regression checks locally and should still go through CI
`migration-replay` before merge.

## Expected On-Prem Validation

After a package containing this fix is built:

1. Re-run the normal Windows/on-prem deploy flow against the same database that
   failed on `008_plugin_infrastructure`.
2. Confirm deploy exit code is `0`.
3. Confirm backend updated to the new package SHA.
4. Confirm `/api/integration/health` and the K3 WISE setup page no longer show
   missing backend route symptoms.
5. Keep customer K3 live GATE blocked until the real K3 API/account answers are
   supplied.
