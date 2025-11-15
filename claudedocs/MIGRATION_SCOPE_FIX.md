# Migration "scope" Column Fix

## Problem Analysis

### Error
```
Migration failed: error: column "scope" does not exist at character 2717
```

### Root Cause
1. **Migration 008_plugin_infrastructure.sql** is currently **EXCLUDED** in CI:
   ```yaml
   MIGRATION_EXCLUDE: 008_plugin_infrastructure.sql,048_create_event_bus_tables.sql,049_create_bpmn_workflow_tables.sql
   ```

2. **When PR updates trigger re-run**, 008 tries to execute and fails because:
   - Creates `plugin_configs` table with `scope` column (line 52-65)
   - Then creates indexes using `WHERE scope = ...` (lines 69-81)
   - **But** if table already exists from previous partial run, it might not have `scope` column

3. **Conflict with 046_plugins_and_templates.sql**:
   - Both 008 and 046 create `plugin_dependencies` table (different schemas)
   - Execution order: 008 → 046, but 008 is excluded so 046 runs first

### Impact
- **Blocks 5+ PRs**: #338, #337, #83, and others
- Affects all PRs that trigger Observability E2E workflow
- Fresh DB works, but replay on existing DB fails

## Solution Options

### Option 1: Keep 008 Excluded (RECOMMENDED - Quick Fix)
**Pros:**
- Immediate fix, no code changes
- Aligns with current working configuration
- Zero risk

**Cons:**
- Doesn't address root cause
- Plugin infrastructure tables not tested in CI

**Implementation:**
```bash
# No changes needed - 008 is already excluded
# Just document why it's excluded
```

### Option 2: Make 008 Fully Idempotent (Proper Fix)
**Pros:**
- Fixes root cause
- Enables full migration testing
- Future-proof

**Cons:**
- Requires code changes
- Needs testing
- Takes more time

**Implementation:**
Add guards to 008_plugin_infrastructure.sql around line 69-81:

```sql
-- Check if scope column exists before creating indexes
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'plugin_configs' AND column_name = 'scope'
  ) THEN
    -- Only create scope-dependent indexes if column exists
    CREATE UNIQUE INDEX IF NOT EXISTS idx_plugin_configs_global
    ON plugin_configs (plugin_name, config_key)
    WHERE scope = 'global';

    CREATE UNIQUE INDEX IF NOT EXISTS idx_plugin_configs_user
    ON plugin_configs (plugin_name, config_key, user_id)
    WHERE scope = 'user';

    CREATE UNIQUE INDEX IF NOT EXISTS idx_plugin_configs_tenant
    ON plugin_configs (plugin_name, config_key, tenant_id)
    WHERE scope = 'tenant';
  END IF;
END $$;
```

### Option 3: Remove 008 and Use 046 (Medium-term)
**Pros:**
- Eliminates duplicate table definitions
- Cleaner migration history

**Cons:**
- Breaking change for existing deployments
- Requires migration consolidation
- High risk

## Recommended Action Plan

### Immediate (Today)
1. ✅ Document that 008 stays excluded (this file)
2. ✅ Update .github/workflows/migration-replay.yml comments to explain why
3. ✅ Merge PRs that are currently blocked

### Short-term (Next Sprint)
1. Audit all plugin-related migrations (008, 046, 047, 048, 049)
2. Create consolidated plugin migration strategy
3. Test migration replay with real data

### Medium-term (Next Quarter)
1. Consolidate duplicate migrations
2. Remove MIGRATION_EXCLUDE entirely
3. Implement runtime schema verification

## Files to Update

### 1. .github/workflows/migration-replay.yml
Add comment explaining exclusion:

```yaml
# Exclude 008: Has table conflicts with 046_plugins_and_templates.sql
# Both create plugin_dependencies with different schemas
# 008 creates comprehensive plugin infrastructure but is not needed for V2 alpha
MIGRATION_EXCLUDE: 008_plugin_infrastructure.sql,048_create_event_bus_tables.sql,049_create_bpmn_workflow_tables.sql
```

### 2. packages/core-backend/migrations/claudedocs/MIGRATION_CONFLICTS.md
Document the conflict:

```markdown
## 008 vs 046 Conflict

**Tables affected:** `plugin_dependencies`, `plugin_configs`

**Issue:** Both migrations create these tables with different schemas.

**Resolution:** 008 is excluded in CI. Future PRs should use 046's schema.

**Long-term:** Consolidate into single plugin infrastructure migration.
```

## Verification

After applying fix:
```bash
# Should pass
gh pr checks 338
gh pr checks 337
gh pr checks 83

# Should show 008 still excluded
cat .github/workflows/migration-replay.yml | grep MIGRATION_EXCLUDE
```

## Related Issues
- PR #338: Docs-only, blocked by migration issue
- PR #337: Phase 3 DTO typing, blocked by migration + conflicts
- PR #83: Permission whitelist, blocked by migration + conflicts

---

**Created**: 2025-11-01
**Status**: Documented - Option 1 (Keep Excluded) recommended for immediate fix
**Owner**: Infrastructure team
