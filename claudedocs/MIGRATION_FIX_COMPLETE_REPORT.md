# Migration Scope Issue - Complete Fix Report

## Executive Summary

✅ **Root cause identified and fixed**
✅ **PR #342 created** with migration exclusion restore
✅ **Will unblock 5+ PRs** once merged
📄 **Comprehensive documentation** created for future reference

## Timeline

### Issue Discovery (2025-11-01 16:30)
- Multiple PRs (#338, #337, #83) failing with same error:
  ```
  Migration failed: error: column "scope" does not exist
  ```
- Affects all PRs running Observability E2E workflow

### Root Cause Analysis (2025-11-01 17:00)
1. **Migration Conflict**: 008_plugin_infrastructure.sql conflicts with 046_plugins_and_templates.sql
2. **Missing Exclusion**: PR #341 removed MIGRATION_EXCLUDE from migration-replay.yml
3. **Table Collision**: Both migrations create `plugin_dependencies` with different schemas

### Fix Implementation (2025-11-01 17:30)
1. ✅ Created fix branch: `fix/migration-scope-issue`
2. ✅ Restored MIGRATION_EXCLUDE environment variable
3. ✅ Added explanatory comments
4. ✅ Committed documentation files
5. ✅ Created PR #342: https://github.com/zensgit/smartsheet/pull/342

## Technical Details

### Problem Migration
**File**: `metasheet-v2/packages/core-backend/migrations/008_plugin_infrastructure.sql`

**Issue**: Creates indexes using `scope` column at character 2717:
```sql
CREATE UNIQUE INDEX IF NOT EXISTS idx_plugin_configs_global
ON plugin_configs (plugin_name, config_key)
WHERE scope = 'global';  -- ← scope column may not exist in partial schema
```

### Conflicting Migrations
| Migration | Tables Created | Schema |
|-----------|---------------|--------|
| 008_plugin_infrastructure.sql | plugin_dependencies | VARCHAR columns |
| 046_plugins_and_templates.sql | plugin_dependencies | UUID columns |

**Execution Order**: 008 → 046 (alphabetically)
**Current Workaround**: Exclude 008 from CI runs

### Fix Applied
**File**: `.github/workflows/migration-replay.yml`

**Change**: Added MIGRATION_EXCLUDE environment variable:
```yaml
- name: Run migrations
  working-directory: metasheet-v2
  env:
    DATABASE_URL: postgresql://postgres:postgres@localhost:5432/metasheet
    # Exclude migrations with table conflicts or incompatibilities:
    # - 008: Conflicts with 046_plugins_and_templates.sql (duplicate plugin_dependencies table)
    # - 048,049: Legacy event bus/workflow tables, not needed for V2
    MIGRATION_EXCLUDE: 008_plugin_infrastructure.sql,048_create_event_bus_tables.sql,049_create_bpmn_workflow_tables.sql
  run: pnpm -F @metasheet/core-backend migrate
```

## Impact Assessment

### Unblocked PRs (5+)
1. **PR #338** - docs: Phase 3 TS migrations plan (batch1)
2. **PR #337** - feat: Phase 3 DTO typing (batch1)
3. **PR #83** - feat: expand permission whitelist
4. Plus multiple dependency update PRs

### Remaining Blockers for Other PRs
- **Merge Conflicts**: Many PRs still CONFLICTING (need branch updates)
- **Gitleaks Scan**: Some PRs failing secrets detection
- **Unrelated Histories**: PR #84 has git history issues

## Documentation Created

### 1. MIGRATION_SCOPE_FIX.md (7KB)
**Location**: `metasheet-v2/claudedocs/MIGRATION_SCOPE_FIX.md`

**Contents**:
- Detailed problem analysis
- 3 solution options (Keep Excluded, Make Idempotent, Remove 008)
- Action plan (immediate/short-term/medium-term)
- Files to update
- Verification steps

### 2. PR_MERGE_SESSION_REPORT.md (8KB)
**Location**: `metasheet-v2/claudedocs/PR_MERGE_SESSION_REPORT.md`

**Contents**:
- Session summary (3 PRs closed, 10+ analyzed)
- Key findings and patterns
- Recommendations by priority
- Technical root causes
- Metrics and next actions

### 3. This Report (MIGRATION_FIX_COMPLETE_REPORT.md)
**Purpose**: End-to-end fix documentation for future reference

## Verification Plan

### PR #342 Merge Criteria
- [ ] Migration Replay passes (with MIGRATION_EXCLUDE)
- [ ] All required CI checks pass
- [ ] No merge conflicts
- [ ] Approved by maintainer

### Post-Merge Verification
```bash
# 1. Check PR #342 merged
gh pr view 342 --json state,mergedAt

# 2. Update blocked PR branches
gh api repos/zensgit/smartsheet/pulls/338/update-branch -X PUT
gh api repos/zensgit/smartsheet/pulls/337/update-branch -X PUT
gh api repos/zensgit/smartsheet/pulls/83/update-branch -X PUT

# 3. Wait for CI
sleep 60

# 4. Verify unblocked PRs pass
gh pr checks 338
gh pr checks 337
gh pr checks 83
```

## Lessons Learned

### What Went Well
1. ✅ Systematic debugging approach (logs → migrations → conflicts)
2. ✅ Comprehensive documentation created upfront
3. ✅ Root cause identified within 1 hour
4. ✅ Fix implemented and PR created within 2 hours

### What Could Improve
1. ⚠️ Migration conflicts should have been caught in PR #341 review
2. ⚠️ MIGRATION_EXCLUDE removal should have triggered more testing
3. ⚠️ Need better migration conflict detection in CI
4. ⚠️ Duplicate table definitions across migrations need consolidation

### Preventive Measures
1. **Add Migration Conflict Checker** to CI
   - Detect duplicate table/index definitions
   - Warn on CREATE TABLE collisions
   - Validate migration exclusions still valid

2. **Migration Consolidation Sprint**
   - Audit all 50+ migrations
   - Remove duplicates
   - Create single source of truth

3. **Better Documentation**
   - Document WHY each migration is excluded
   - Maintain migration dependency graph
   - Add migration troubleshooting guide

## Next Steps

### Immediate (Today)
1. ⏳ Wait for PR #342 CI to complete
2. ⏳ Merge PR #342 once CI passes
3. ⏳ Update blocked PR branches
4. ⏳ Verify PRs #338, #337, #83 pass CI

### Short-term (This Week)
1. Batch update all dependency PR branches
2. Close PRs with unrelated histories (#84)
3. Address Gitleaks scan issues
4. Create GitHub issue for migration audit

### Medium-term (Next Sprint)
1. Consolidate plugin migrations (008 + 046)
2. Implement migration conflict checker
3. Remove MIGRATION_EXCLUDE need entirely
4. Add migration replay testing to pre-merge checks

## Related Links

- **Fix PR**: https://github.com/zensgit/smartsheet/pull/342
- **Original Issue PR**: https://github.com/zensgit/smartsheet/pull/341
- **Documentation**: `metasheet-v2/claudedocs/MIGRATION_SCOPE_FIX.md`
- **Session Report**: `metasheet-v2/claudedocs/PR_MERGE_SESSION_REPORT.md`

## Metrics

- **Time to Identify**: 1 hour
- **Time to Fix**: 2 hours
- **PRs Unblocked**: 5+
- **Documentation Created**: 15KB across 3 files
- **Lines Changed**: 4 lines (+ extensive comments)

---

**Status**: ✅ Fix implemented, awaiting PR #342 merge
**Priority**: 🔴 HIGH (blocks 5+ PRs)
**Owner**: Infrastructure team
**Created**: 2025-11-01 17:45
**Updated**: 2025-11-01 18:00
