# SRE Runbook: Observability & Migrations

**Last Updated**: 2025-11-06
**Owner**: SRE Team
**Related**: Phase B Observability Stabilization

## 📋 Table of Contents

- [Overview](#overview)
- [Architecture](#architecture)
- [Emergency Procedures](#emergency-procedures)
- [Degradation Mode](#degradation-mode)
- [Migration Management](#migration-management)
- [Troubleshooting](#troubleshooting)
- [Monitoring & Alerts](#monitoring--alerts)
- [Common Error Codes](#common-error-codes)

## Overview

This runbook covers operational procedures for the Metasheet v2 observability system and database migrations, specifically focusing on:

- **Event Bus System**: 8 tables for event-driven architecture
- **RBAC Core**: 5 tables for role-based access control
- **Approval System**: 2 tables for approval workflows
- **Graceful Degradation**: Emergency fallback mechanisms

### System Status

- **Event Bus**: ✅ Fully migrated (8/8 tables)
- **RBAC**: ✅ Fully migrated (5/5 tables)
- **Approval**: ✅ Fully migrated (2/2 tables)
- **Degradation Logic**: 🛡️ Retained in source code for fault tolerance

## Architecture

### Database Tables

**Event Bus** (Migration 048):
```sql
- event_types
- event_subscriptions
- event_store (partitioned by occurred_at)
- event_handlers
- event_queue
- event_deliveries
- event_aggregates
- event_dead_letters
- event_replays (future use)
- plugin_event_permissions
```

**RBAC Core** (Migration 033):
```sql
- roles
- permissions
- role_permissions
- user_roles
- user_permissions
```

**Approval** (Migrations 030, 032):
```sql
- approval_instances (with optimistic locking via version column)
- approval_records (audit trail)
```

### Graceful Degradation Architecture

The system includes degradation logic that automatically falls back to in-memory storage when database tables are unavailable:

```typescript
// Detection mechanism
function isDatabaseSchemaError(error: any): boolean {
  // PostgreSQL error code 42P01: relation does not exist
  if (error?.code === '42P01') return true
  // ... additional checks
}

// Controlled by environment flags (DISABLED by default in production)
const allowDegradation = process.env.EVENT_BUS_OPTIONAL === '1'
```

**⚠️  CRITICAL**: Degradation flags should NEVER be enabled in production except during emergency hotfixes with explicit SRE approval.

## Emergency Procedures

### Incident Response Priority

**P0 - Production Down**: Immediate action required
**P1 - Degraded Service**: Act within 1 hour
**P2 - Non-Critical Issues**: Plan fix within 24 hours

### Emergency Rollback Procedure

If you encounter critical issues related to migrations or observability:

#### Option 1: Enable Degradation Mode (Emergency Only)

```bash
# ⚠️  This is a LAST RESORT - requires SRE approval

# 1. Set environment flags in your deployment
export EVENT_BUS_OPTIONAL=1
export RBAC_OPTIONAL=1
export APPROVAL_OPTIONAL=1

# 2. Restart the service
systemctl restart metasheet-backend

# 3. Verify degradation is active
tail -f /var/log/metasheet/server.log | grep "degraded"
# Expected output: "⚠️  Event Bus service degraded - event_types table not found"

# 4. Create incident report immediately
# 5. Plan proper fix within 24 hours
```

#### Option 2: Roll Back Migrations

```bash
# ⚠️  Only if degradation mode is insufficient

# 1. Stop the service
systemctl stop metasheet-backend

# 2. Connect to database
psql -U metasheet -d metasheet_v2

# 3. Check current migration state
SELECT * FROM schema_migrations ORDER BY applied_at DESC LIMIT 5;

# 4. Manually revert problematic migration
# Example for Migration 048:
DROP TABLE IF EXISTS event_types CASCADE;
DROP TABLE IF EXISTS event_subscriptions CASCADE;
DROP TABLE IF EXISTS event_store CASCADE;
# ... (drop all 8 event bus tables)

DELETE FROM schema_migrations WHERE filename = '048_create_event_bus_tables.sql';

# 5. Restart service
systemctl start metasheet-backend

# 6. Verify service is running
curl -f http://localhost:8900/health || echo "Service failed to start"
```

### Health Check Procedures

```bash
# Check service health
curl -f http://localhost:8900/health

# Check database connectivity
psql -U metasheet -d metasheet_v2 -c "SELECT 1"

# Check migration status
psql -U metasheet -d metasheet_v2 -c "
  SELECT filename, applied_at
  FROM schema_migrations
  ORDER BY applied_at DESC
  LIMIT 10;
"

# Verify critical tables exist
psql -U metasheet -d metasheet_v2 -c "
  SELECT tablename
  FROM pg_tables
  WHERE schemaname = 'public'
    AND tablename IN (
      'event_types', 'roles', 'permissions',
      'approval_instances', 'approval_records'
    );
"
```

## Degradation Mode

### When to Use Degradation Mode

**✅ Appropriate Use Cases**:
- CI/CD testing environments
- Local development environments
- Emergency hotfix during production outage (with SRE approval)
- Diagnostic/troubleshooting sessions

**❌ Inappropriate Use Cases**:
- Production deployments (unless P0 incident)
- Long-term workarounds for migration issues
- Avoiding proper database migration work
- "Temporarily" disabling features

### How Degradation Works

1. **Detection**: System catches PostgreSQL error code `42P01` (relation does not exist)
2. **Fallback**: Switches to in-memory storage (Map-based)
3. **Warning**: Logs degradation event with specific table missing
4. **Continuation**: Service continues with reduced functionality

### Degradation Mode Limitations

**Event Bus Degradation**:
- ❌ No event persistence across restarts
- ❌ No event replay capability
- ❌ No cross-service event subscriptions
- ✅ In-process event handling still works

**RBAC Degradation**:
- ❌ No persistent role assignments
- ❌ Roles/permissions lost on restart
- ✅ Basic permission checks still functional

**Approval Degradation**:
- ❌ No approval history persistence
- ❌ Approval state lost on restart
- ✅ Approval workflow logic still executes

### Monitoring Degradation Mode

```bash
# Check for degradation warnings in logs
grep "degraded" /var/log/metasheet/server.log

# Expected output if degraded:
# ⚠️  Event Bus service degraded - event_types table not found
# ⚠️  Falling back to in-memory event storage
# ⚠️  Set EVENT_BUS_OPTIONAL=1 environment variable is active

# Alert if degradation detected in production
if grep -q "degraded" /var/log/metasheet/server.log; then
  echo "⚠️  ALERT: Production service running in degraded mode!"
  # Trigger PagerDuty/Slack alert
fi
```

## Migration Management

### Running Migrations

```bash
# Standard migration execution
cd metasheet-v2/packages/core-backend
pnpm run db:migrate

# With exclusions (for testing)
MIGRATION_EXCLUDE="048_create_event_bus_tables.sql" pnpm run db:migrate

# Verify migration applied
psql -U metasheet -d metasheet_v2 -c "
  SELECT * FROM schema_migrations
  WHERE filename = '048_create_event_bus_tables.sql';
"
```

### Migration Replay (Testing)

```bash
# Full replay on fresh database
dropdb metasheet_v2_test
createdb metasheet_v2_test
DATABASE_URL='postgresql://metasheet:metasheet123@localhost:5432/metasheet_v2_test' \
  pnpm run db:migrate

# Verify idempotency (run twice)
DATABASE_URL='postgresql://metasheet:metasheet123@localhost:5432/metasheet_v2_test' \
  pnpm run db:migrate

# Should succeed with no errors
```

### Creating New Migrations

**Migration Naming Convention**:
```
NNN_description.sql   # NNN = zero-padded migration number, e.g. 048

Examples:
048_create_event_bus_tables.sql
049_add_event_metadata_columns.sql
050_create_audit_log_indices.sql
```

**Migration Best Practices**:

1. **Idempotency**: Use `CREATE TABLE IF NOT EXISTS`
2. **Triggers**: Guard with `DO $$ BEGIN IF NOT EXISTS ... END $$;`
3. **Indexes**: Use `CREATE INDEX IF NOT EXISTS`
4. **Comments**: Document purpose and dependencies
5. **Testing**: Test replay on empty database before merging

**Example Template**:
```sql
-- 049_add_event_metadata_columns.sql
-- Adds metadata columns to event_store for enhanced filtering

-- Add columns if they don't exist
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'event_store' AND column_name = 'metadata'
  ) THEN
    ALTER TABLE event_store ADD COLUMN metadata JSONB;
  END IF;
END $$;

-- Add index for JSONB queries
CREATE INDEX IF NOT EXISTS idx_event_store_metadata
  ON event_store USING gin(metadata);
```

## Troubleshooting

### Common Issues

#### Issue 1: Migration Fails with "relation already exists"

**Symptoms**:
```
ERROR:  relation "event_types" already exists
```

**Cause**: Migration not idempotent

**Solution**:
```sql
-- Instead of:
CREATE TABLE event_types (...);

-- Use:
CREATE TABLE IF NOT EXISTS event_types (...);
```

#### Issue 2: Trigger Creation Fails

**Symptoms**:
```
ERROR:  trigger "process_subscriptions_on_event" already exists
```

**Cause**: Trigger guard missing

**Solution**:
```sql
DO $tg$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'process_subscriptions_on_event'
  ) THEN
    CREATE TRIGGER process_subscriptions_on_event ...;
  END IF;
END $tg$;
```

#### Issue 3: Partition Table Handling

**Symptoms**:
```
ERROR:  cannot create partition of non-partitioned table
```

**Cause**: Migration 048 partition handling on non-fresh database

**Solution**: Migration 048 includes special guards for CI scenarios:
```sql
DO $fn$
DECLARE
  is_partitioned BOOLEAN;
  exists_event_store BOOLEAN;
BEGIN
  -- Check if event_store exists and is partitioned
  SELECT EXISTS (...) INTO is_partitioned;

  IF exists_event_store AND NOT is_partitioned THEN
    -- Fresh CI DBs: safe to drop and recreate
    EXECUTE 'DROP TABLE IF EXISTS event_store CASCADE';
  END IF;
END $fn$;
```

#### Issue 4: Version Conflict in Approvals

**Symptoms**:
```json
{
  "ok": false,
  "error": {
    "code": "APPROVAL_VERSION_CONFLICT",
    "message": "Approval instance version mismatch"
  }
}
```

**Cause**: Concurrent approval actions with optimistic locking

**Solution**: This is expected behavior. Client should:
1. Fetch latest version
2. Retry with updated version number
3. Handle conflict gracefully in UI

**Example Retry Logic**:
```typescript
async function approveWithRetry(instanceId: string, maxRetries = 3) {
  for (let i = 0; i < maxRetries; i++) {
    // Fetch latest version
    const instance = await fetchApprovalInstance(instanceId);

    try {
      return await approve(instanceId, instance.version);
    } catch (error) {
      if (error.code === 'APPROVAL_VERSION_CONFLICT' && i < maxRetries - 1) {
        continue; // Retry with fresh version
      }
      throw error;
    }
  }
}
```

## Monitoring & Alerts

### Key Metrics to Monitor

**Database Health**:
- Migration status (all applied successfully)
- Table existence checks
- Connection pool utilization

**Service Health**:
- Degradation mode activation (should be ZERO in production)
- Error rates by endpoint
- Response time P99

**Event Bus Metrics**:
- Event throughput
- Event processing latency
- Dead letter queue depth

**RBAC Metrics**:
- Permission check latency
- Cache hit rate
- Failed authorization attempts

**Approval Metrics**:
- Approval actions by type
- Version conflicts per hour
- Approval processing time

### Recommended Alerts

**P0 Alerts** (Immediate Response):
```yaml
- alert: ProductionDegradationMode
  expr: degradation_mode_active == 1
  severity: critical
  message: "Production service running in degraded mode"

- alert: MigrationFailed
  expr: migration_failure_count > 0
  severity: critical
  message: "Database migration failed"

- alert: DatabaseDown
  expr: up{job="postgres"} == 0
  severity: critical
  message: "PostgreSQL database is down"
```

**P1 Alerts** (1 Hour Response):
```yaml
- alert: HighErrorRate
  expr: error_rate > 0.05
  severity: warning
  message: "Error rate above 5%"

- alert: SlowMigration
  expr: migration_duration_seconds > 300
  severity: warning
  message: "Migration taking longer than 5 minutes"
```

## Common Error Codes

| Error Code | PostgreSQL Code | Meaning | Action |
|------------|-----------------|---------|--------|
| `42P01` | Relation not found | Table does not exist | Check migration status, verify table creation |
| `42710` | Duplicate object | Object already exists | Ensure migration idempotency (IF NOT EXISTS) |
| `42P17` | Invalid partition | Partition table issue | Check Migration 048 partition handling logic |
| `42P16` | Syntax error | SQL syntax issue | Review migration SQL for typos |
| `40001` | Serialization failure | Concurrent transaction conflict | Retry transaction (expected for optimistic locking) |

### Error Code Resolution Guide

**42P01 - Relation Not Found**:
```bash
# 1. Check which table is missing
grep "42P01" /var/log/metasheet/server.log

# 2. Check migration status
psql -U metasheet -d metasheet_v2 -c "
  SELECT * FROM schema_migrations
  WHERE filename LIKE '%event_bus%' OR
        filename LIKE '%rbac%' OR
        filename LIKE '%approval%';
"

# 3. If migration not applied, run it
pnpm run db:migrate

# 4. If migration already applied but table missing, investigate data loss
```

**42710 - Duplicate Object**:
```bash
# Migration should have used IF NOT EXISTS
# If you see this error:

# 1. Check if migration file uses IF NOT EXISTS
cat migrations/048_create_event_bus_tables.sql | grep "IF NOT EXISTS"

# 2. If missing, update migration to be idempotent
# 3. Test replay on fresh database before deploying
```

**40001 - Serialization Failure** (Approval Version Conflicts):
```bash
# This is EXPECTED behavior for optimistic locking
# Monitor rate to ensure it's reasonable:

psql -U metasheet -d metasheet_v2 -c "
  SELECT
    COUNT(*) as conflict_count,
    DATE_TRUNC('hour', created_at) as hour
  FROM approval_records
  WHERE from_version != to_version - 1
  GROUP BY hour
  ORDER BY hour DESC
  LIMIT 24;
"

# Alert if conflict rate > 10% of total approvals
```

## Runbook Change Log

| Date | Author | Changes |
|------|--------|---------|
| 2025-11-06 | SRE Team | Initial version post Phase B stabilization |

## References

- [Phase B Observability Stabilization Summary](../claudedocs/PHASE_B_OBSERVABILITY_STABILIZATION_SUMMARY.md)
- [Migration 048: Event Bus Tables](../packages/core-backend/migrations/048_create_event_bus_tables.sql)
- [Migration 033: RBAC Core](../packages/core-backend/migrations/033_create_rbac_core.sql)
- [Migrations 030/032: Approval System](../packages/core-backend/migrations/)
- [Release v2.0.0-alpha.1-stabilized](https://github.com/zensgit/smartsheet/releases/tag/v2.0.0-alpha.1-stabilized)
