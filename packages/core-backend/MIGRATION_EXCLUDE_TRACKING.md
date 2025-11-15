# MIGRATION_EXCLUDE Tracking

## Overview

This document tracks database migrations that are currently excluded from automated replay testing. These migrations require manual review and fixing before they can be re-enabled.

**Current Exclude Count**: 3 files (centralized in CI via composite action)

**Default Exclude in CI**: `008_plugin_infrastructure.sql, 048_create_event_bus_tables.sql, 049_create_bpmn_workflow_tables.sql`

**Last Updated**: 2025-11-07

---

## Excluded Migrations

### Pre-Existing Issues (archived)

#### 1. `008_add_indexes_to_workflows.sql`
**Status**: ❌ Excluded
**Issue**: Syntax error - inline INDEX keyword
**Details**:
- Contains `INDEX idx_name` syntax inside CREATE TABLE
- PostgreSQL requires CREATE INDEX as separate statement

**Fix Required**:
```sql
-- ❌ Wrong (current)
CREATE TABLE workflows (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255) INDEX idx_name  -- inline INDEX
);

-- ✅ Correct
CREATE TABLE workflows (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255)
);

CREATE INDEX IF NOT EXISTS idx_name ON workflows(name);
```

**Estimated Effort**: 15 minutes
**Priority**: P1
**Assigned**: TBD

---

#### 2. `031_add_approval_templates.sql`
**Status**: ❌ Excluded
**Issue**: Missing IF NOT EXISTS, potential idempotency issues
**Details**:
- CREATE TABLE without IF NOT EXISTS
- Will fail on second run if table exists

**Fix Required**:
```sql
-- ❌ Wrong
CREATE TABLE approval_templates (...);

-- ✅ Correct
CREATE TABLE IF NOT EXISTS approval_templates (...);
```

**Estimated Effort**: 10 minutes
**Priority**: P1
**Assigned**: TBD

---

#### 3. `036_add_workflow_execution_logs.sql`
**Status**: ❌ Excluded
**Issue**: Trailing comma in column definition
**Details**:
- Has `,)` before closing parenthesis

**Fix Required**:
```sql
-- ❌ Wrong
CREATE TABLE logs (
  id SERIAL PRIMARY KEY,
  message TEXT,  -- trailing comma
);

-- ✅ Correct
CREATE TABLE logs (
  id SERIAL PRIMARY KEY,
  message TEXT
);
```

**Estimated Effort**: 5 minutes
**Priority**: P2
**Assigned**: TBD

---

#### 4. `037_add_notification_preferences.sql`
**Status**: ❌ Excluded
**Issue**: Mixed casing inconsistency
**Details**:
- Uses both `create table` and `CREATE TABLE`

**Fix Required**:
- Standardize to uppercase SQL keywords

**Estimated Effort**: 5 minutes
**Priority**: P3
**Assigned**: TBD

---

#### 5. `042_add_audit_logs.sql`
**Status**: ❌ Excluded
**Issue**: Complex foreign key constraints without proper error handling
**Details**:
- Multiple foreign keys added without existence checks

**Fix Required**:
- Add constraint existence checks before adding

**Estimated Effort**: 20 minutes
**Priority**: P1
**Assigned**: TBD

---

### Phase 2 Additions (archived)

#### 6. `048_create_bpmn_process_definitions.sql`
**Status**: ❌ Excluded (Phase 2)
**Issue**: Inline INDEX keyword
**Details**:
- Same issue as 008: inline INDEX in CREATE TABLE
- Added during Phase 2 microkernel architecture

**Fix Required**:
```sql
-- Current (broken)
CREATE TABLE bpmn_process_definitions (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL INDEX idx_name  -- inline INDEX
);

-- Fixed
CREATE TABLE bpmn_process_definitions (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_name ON bpmn_process_definitions(name);
```

**Estimated Effort**: 15 minutes
**Priority**: P0 (blocks Phase 2 completion)
**Assigned**: Phase 3 Team

---

#### 7. `049_create_bpmn_process_instances.sql`
**Status**: ❌ Excluded (Phase 2)
**Issue**: Inline INDEX keyword
**Details**:
- Same issue as 048
- Part of BPMN workflow system

**Fix Required**:
```sql
-- Current (broken)
CREATE TABLE bpmn_process_instances (
  id TEXT PRIMARY KEY,
  process_definition_id TEXT NOT NULL INDEX idx_def  -- inline INDEX
);

-- Fixed
CREATE TABLE bpmn_process_instances (
  id TEXT PRIMARY KEY,
  process_definition_id TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_def ON bpmn_process_instances(process_definition_id);
```

**Estimated Effort**: 15 minutes
**Priority**: P0 (blocks Phase 2 completion)
**Assigned**: Phase 3 Team

---

## Fix Strategy

### Phase 1: Critical Fixes (Week 1-2)
**Target**: P0 migrations (048, 049)

1. Fix inline INDEX issues in Phase 2 BPMN migrations
2. Run SQL linter: `bash scripts/ci/lint-sql-migrations.sh`
3. Test migration replay: `MIGRATION_EXCLUDE='' pnpm db:migrate`
4. Verify on clean database

**Success Criteria**:
- ✅ 048 & 049 pass migration replay
- ✅ SQL linter reports 0 issues for these files
- ✅ Tables created with proper indexes

---

### Phase 2: Pre-existing Fixes (Week 3-4)
**Target**: P1 migrations (008, 031, 042)

1. Fix syntax errors one by one
2. Test each migration individually
3. Remove from EXCLUDE list incrementally

**Success Criteria**:
- ✅ All P1 migrations pass replay
- ✅ EXCLUDE list reduced to 2 files (036, 037)

---

### Phase 3: Cleanup (Week 5-6)
**Target**: P2/P3 migrations (036, 037)

1. Fix remaining style issues
2. Final comprehensive migration replay test
3. Remove MIGRATION_EXCLUDE entirely

**Success Criteria**:
- ✅ EXCLUDE list empty
- ✅ All migrations pass replay on clean database
- ✅ CI Migration Replay check passes with zero exclusions

---

## Testing Protocol

### Per-Migration Testing
```bash
# 1. Reset database to before this migration
psql -d metasheet_v2 -c "DELETE FROM schema_migrations WHERE name='XXX_migration_name.sql';"

# 2. Run migration
MIGRATION_EXCLUDE='' pnpm db:migrate

# 3. Verify tables/indexes created
psql -d metasheet_v2 -c "\dt"
psql -d metasheet_v2 -c "\di"

# 4. Run replay (should be idempotent)
pnpm db:migrate

# 5. Check for errors
echo $?  # Should be 0
```

### Full Replay Testing
```bash
# 1. Drop and recreate database
dropdb metasheet_v2
createdb metasheet_v2

# 2. Run all migrations without EXCLUDE
MIGRATION_EXCLUDE='' pnpm db:migrate

# 3. Run replay
pnpm db:migrate

# 4. Verify
bash scripts/ci/lint-sql-migrations.sh
```

---

## Migration Best Practices

### ✅ DO

1. **Use IF NOT EXISTS**
   ```sql
   CREATE TABLE IF NOT EXISTS users (...);
   CREATE INDEX IF NOT EXISTS idx_name ON users(name);
   ```

2. **Separate INDEX statements**
   ```sql
   CREATE TABLE users (id SERIAL PRIMARY KEY, name TEXT);
   CREATE INDEX IF NOT EXISTS idx_name ON users(name);
   ```

3. **Use hasTable/hasColumn checks (Kysely)**
   ```typescript
   const exists = await db.schema.hasTable('users').execute()
   if (exists) return
   ```

4. **Add semicolons**
   ```sql
   CREATE TABLE users (...);  -- Don't forget!
   ```

5. **Consistent casing**
   ```sql
   -- All uppercase keywords
   CREATE TABLE users (
     id SERIAL PRIMARY KEY,
     name TEXT NOT NULL
   );
   ```

### ❌ DON'T

1. **Inline INDEX keyword**
   ```sql
   -- ❌ Wrong
   name TEXT NOT NULL INDEX idx_name
   ```

2. **Trailing commas**
   ```sql
   -- ❌ Wrong
   CREATE TABLE users (
     id SERIAL,
     name TEXT,  -- trailing comma
   );
   ```

3. **Missing IF NOT EXISTS**
   ```sql
   -- ❌ Wrong (not idempotent)
   CREATE TABLE users (...);
   ```

4. **Mixed casing**
   ```sql
   -- ❌ Wrong
   create TABLE users (ID serial PRIMARY key);
   ```

---

## PR Review Checklist

When reviewing migration PRs, check:

- [ ] All SQL files pass `bash scripts/ci/lint-sql-migrations.sh`
- [ ] CREATE TABLE uses IF NOT EXISTS
- [ ] CREATE INDEX uses IF NOT EXISTS
- [ ] No inline INDEX keywords
- [ ] No trailing commas
- [ ] Consistent uppercase SQL keywords
- [ ] All statements end with semicolon
- [ ] TypeScript migrations use hasTable/hasColumn checks
- [ ] Migration tested on clean database
- [ ] Migration replay tested (run twice)
- [ ] No new additions to MIGRATION_EXCLUDE without documented reason

---

## History

### 2025-10-29: Initial Tracking
- Documented 7 excluded migrations
- Created fix strategy and testing protocol
- Established P0/P1/P2 priorities

### Next Review: 2025-11-05
- Review P0 fix progress (048, 049)
- Update EXCLUDE list
- Adjust timeline if needed

---

## Related Documents

- [Phase 3 Kickoff Plan](../../claudedocs/PHASE3_KICKOFF_PLAN_20251029.md)
- [Phase 3 Optimization Roadmap](../../claudedocs/PHASE3_OPTIMIZATION_ROADMAP.md)
- [Migration Template](./src/db/migrations/_template.ts)
- [Migration Patterns](./src/db/migrations/_patterns.ts)
- [SQL Linter](../../scripts/ci/lint-sql-migrations.sh)
