# Integration-Core Runs Composite Index · Verification

> Date: 2026-04-26
> Companion: `integration-core-runs-composite-index-design-20260426.md`
> PR: #1189

## Commands run

```bash
node plugins/plugin-integration-core/__tests__/migration-sql.test.cjs
# Full regression:
for f in plugins/plugin-integration-core/__tests__/*.test.cjs; do node "$f" 2>&1 | tail -1; done
git diff --check

# Real Postgres smoke:
# initdb throwaway cluster, apply 057, 058, 059 transactionally, then inspect pg_indexes.
```

## Result — migration-sql.test.cjs

```
✓ migration-sql: 057/058/059 integration migration structure passed
```

## Result — full suite regression (18 files)

All 18 integration-core test files pass. The 059 migration adds no application-code
changes, so no unit tests are affected.

## Result — real PostgreSQL migration smoke

Ran against a local throwaway Postgres cluster via `initdb`/`pg_ctl`, applying
057, 058, and 059 with `psql -1` for the follow-up migrations.

```
indexname                                             | indexdef
------------------------------------------------------+------------------------------------------------------------
idx_integration_runs_scope_pipeline_status_created_at | CREATE INDEX ... (tenant_id, workspace_id, pipeline_id, status, created_at DESC)
uniq_integration_runs_one_running_per_pipeline        | CREATE UNIQUE INDEX ... (tenant_id, COALESCE(workspace_id, ''::text), pipeline_id) WHERE (status = 'running'::text)
```

This confirms 059 coexists with 058 and keeps the correctness/performance split:
058 enforces uniqueness for `running` rows, while 059 supports run-history and
pipeline-scoped lookup performance.

## Migration SQL review

```sql
CREATE INDEX IF NOT EXISTS idx_integration_runs_scope_pipeline_status_created_at
  ON integration_runs (tenant_id, workspace_id, pipeline_id, status, created_at DESC);
```

| Check | Result |
|---|---|
| No `CONCURRENTLY` — compatible with Kysely transactional migration runner | ✅ |
| `IF NOT EXISTS` — idempotent re-run | ✅ |
| References only `integration_runs` — no cross-table FK concerns | ✅ |
| Does not drop or alter any existing index or table | ✅ |
| Column names match 057 schema (`tenant_id`, `workspace_id`, `pipeline_id`, `status`, `created_at`) | ✅ |
| No `DROP INDEX` or `DROP TABLE` statement | ✅ |
| Migration number is 059, after #1187's 058 running unique index | ✅ |

## CI failure caught and fix

Initial #1189 used `CREATE INDEX CONCURRENTLY IF NOT EXISTS`, but CI's
`migration-replay` job failed with:

```text
error: CREATE INDEX CONCURRENTLY cannot run inside a transaction block
```

Root cause: `packages/core-backend/src/db/migration-provider.ts` executes SQL
files via Kysely migrations, and Kysely wraps each migration in a transaction.
The fix is to use plain `CREATE INDEX IF NOT EXISTS`, preserving idempotency and
planner benefit while staying compatible with the existing migration runner.

After #1187 merged, this PR was also updated from `058_...` to `059_...` because
058 now belongs to `uniq_integration_runs_one_running_per_pipeline`.

## Manual EXPLAIN analysis (expected)

For run-history and stale-run lookup:
```sql
EXPLAIN SELECT * FROM integration_runs
WHERE tenant_id='t1'
  AND workspace_id IS NULL
  AND pipeline_id='p1'
  AND status='succeeded'
ORDER BY created_at DESC
LIMIT 50;
```

**Before 059:** Bitmap Index Scan on `idx_integration_runs_scope` or
`idx_integration_runs_pipeline`, then filter by status and sort by `created_at`.

**After 059:** Index Scan on
`idx_integration_runs_scope_pipeline_status_created_at` using the full
tenant/workspace/pipeline/status equality prefix and reading rows in
`created_at DESC` order.

## CI expectations

- `migration-sql.test.cjs` — validates 057/058/059 integration SQL shape
- `migration-replay` CI job — replays migrations 001-059 against real Postgres;
  plain `CREATE INDEX IF NOT EXISTS` is accepted inside the runner transaction
- `contracts`, `test 18.x`, `test 20.x` — unaffected (no application code changes)
