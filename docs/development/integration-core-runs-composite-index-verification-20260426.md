# Integration-Core Runs Composite Index · Verification

> Date: 2026-04-26
> Companion: `integration-core-runs-composite-index-design-20260426.md`
> PR: #1189

## Commands run

```bash
node plugins/plugin-integration-core/__tests__/migration-sql.test.cjs
# Full regression:
for f in plugins/plugin-integration-core/__tests__/*.test.cjs; do node "$f" 2>&1 | tail -1; done
```

## Result — migration-sql.test.cjs

```
✓ migration-sql: 057 integration migration structure passed
```

## Result — full suite regression (18 files)

All 18 integration-core test files pass. The 058 migration adds no application-code
changes, so no unit tests are affected.

## Migration SQL review

```sql
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_integration_runs_tenant_pipeline_status
  ON integration_runs (tenant_id, pipeline_id, status);
```

| Check | Result |
|---|---|
| `CONCURRENTLY` — no exclusive table lock | ✅ |
| `IF NOT EXISTS` — idempotent re-run | ✅ |
| References only `integration_runs` — no cross-table FK concerns | ✅ |
| Does not drop or alter any existing index or table | ✅ |
| Column names match 057 schema (`tenant_id`, `pipeline_id`, `status`) | ✅ |
| No `DROP INDEX` or `DROP TABLE` statement | ✅ |

## Manual EXPLAIN analysis (expected)

For the concurrent-run guard:
```sql
EXPLAIN SELECT * FROM integration_runs
WHERE tenant_id='t1' AND workspace_id='ws1' AND pipeline_id='p1' AND status='running'
LIMIT 1;
```

**Before 058:** Bitmap Index Scan on `idx_integration_runs_scope` + BitmapAnd or
Seq Scan on filtered rows, then filter on `pipeline_id` and `status`.

**After 058:** Index Scan on `idx_integration_runs_tenant_pipeline_status`
using `(tenant_id='t1', pipeline_id='p1', status='running')` as a composite key.
With LIMIT 1, execution short-circuits on the first matching row (typically 0 rows
for healthy pipelines, meaning a single key lookup with no rows returned).

## CI expectations

- `migration-sql.test.cjs` — unchanged behavior (validates 057 only)
- `migration-replay` CI job — replays migrations 001-058 against real Postgres;
  `CONCURRENTLY` is accepted by Postgres ≥ 9.2 (CI uses Postgres 18.x / 20.x)
- `contracts`, `test 18.x`, `test 20.x` — unaffected (no application code changes)
