# audit_logs Current-Month Partition Lifecycle

Date: 2026-05-27
Issue: #503

## Scope

This note covers the operational lifecycle for the partitioned `audit_logs` table. It does not change attendance strict-gate behavior or the `operation_audit_logs` table used by newer attendance admin routes.

## Expected lifecycle

- The audit table migration creates the partition for the month in which the migration runs.
- `create_audit_partition()` remains the pre-provisioning helper for the next month.
- `AuditRepository.createAuditLog()` now treats PostgreSQL's `no partition of relation "audit_logs" found for row` response as a recoverable lifecycle gap:
  - create the database server's current-month `audit_logs_YYYY_MM` partition;
  - retry the original audit insert once;
  - rethrow unrelated insert errors and any retry failure.

The self-heal path uses the database server calendar (`CURRENT_DATE`) so it stays aligned with the `created_at DEFAULT CURRENT_TIMESTAMP` value produced by PostgreSQL during the insert.

## Operator verification

Check the current partition:

```sql
SELECT to_regclass('audit_logs_' || to_char(date_trunc('month', CURRENT_DATE), 'YYYY_MM')) AS current_partition;
```

Expected result is a non-null relation name such as `audit_logs_2026_05`.

Check the next pre-provisioned partition when the scheduled monthly helper is enabled:

```sql
SELECT to_regclass('audit_logs_' || to_char(date_trunc('month', CURRENT_DATE + INTERVAL '1 month'), 'YYYY_MM')) AS next_partition;
```

If the current partition is missing, a normal audit write should recreate it automatically. To preflight without waiting for traffic, call the repository guard from a maintenance script or run the equivalent DO block used by `AuditRepository.ensureCurrentMonthPartition()`.

## Failure handling

- Missing current-month partition: audit repository creates the partition and retries once.
- Concurrent first writes in the same month: the self-heal block takes a transaction-scoped advisory lock for the computed partition name before creating it.
- Missing parent table, permissions, invalid table shape, or any non-partition insert error: not swallowed by the repository.

## Verification

Focused unit coverage lives in `packages/core-backend/tests/unit/audit-repository-partition.test.ts` and covers:

- self-heal plus one retry after the PostgreSQL missing-partition error;
- no retry for unrelated insert errors;
- direct current-month partition guard SQL.
