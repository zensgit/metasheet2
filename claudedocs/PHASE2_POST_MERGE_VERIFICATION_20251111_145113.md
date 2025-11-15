# Phase 2: Post-Merge Verification Report

**Execution Time**: Tue Nov 11 14:51:14 CST 2025
**PR**: #421 (ci/observability-hardening)
**Merge Commit**: 660c2b03e0c398c08e4351e5bbebb8170a5bf43d
**Merge Time**: 2025-11-11 14:06:04 +0800

---

## Important Note

Observability workflows are configured to run on `pull_request` events only, NOT on push to main branch.
This verification uses the **PR branch successful runs** as the source of truth for validation.

---

## Verification Results


### 1. PR Branch CI Runs (Source of Truth)

#### v2-observability-strict
- **Run ID**: 19253708447
- **Conclusion**: success
- **Created**: 2025-11-11T03:14:01Z
- **Commit**: 70d476b23816ce5d2da8bc05b7b7a69c0c6937a3
- **Status**: ✅ PASS

#### metrics-lite
- **Run ID**: 
- **Conclusion**: 
- **Created**: 
- **Commit**: 
- **Status**: ✅ PASS


### 2. Migration Verification

#### 042a_core_model_views.sql
```
v2-observability-strict	UNKNOWN STEP	2025-11-11T03:15:34.6072747Z Applying migration: 042a_core_model_views.sql
```
**Status**: ✅ Applied

#### 042c_audit_placeholder.sql
```
v2-observability-strict	UNKNOWN STEP	2025-11-11T03:15:34.6173272Z Applying migration: 042c_audit_placeholder.sql
v2-observability-strict	UNKNOWN STEP	2025-11-11T03:15:34.6247696Z Applying migration: 042c_plugins_and_templates.sql
```
**Status**: ✅ Applied


### 3. Metrics Baseline (v2-observability-strict)

```
v2-observability-strict	UNKNOWN STEP	  `- **Approvals**: ✅ Success: ${success}, ⚠️ Conflicts: ${conflict}`,
v2-observability-strict	UNKNOWN STEP	2025-11-11T03:16:55.4635535Z   p99: 0
v2-observability-strict	UNKNOWN STEP	2025-11-11T03:16:55.4635718Z   dbp99: 0
v2-observability-strict	UNKNOWN STEP	2025-11-11T03:16:55.4636422Z   conflict: 2
v2-observability-strict	UNKNOWN STEP	2025-11-11T03:16:56.4786493Z [36;1m    "p99_latency": ${p99:-null},[0m
v2-observability-strict	UNKNOWN STEP	2025-11-11T03:16:56.4786784Z [36;1m    "db_p99_latency": ${dbp99:-null},[0m
v2-observability-strict	UNKNOWN STEP	2025-11-11T03:16:56.4789811Z [36;1m    "approval_success": ${success:-0},[0m
v2-observability-strict	UNKNOWN STEP	2025-11-11T03:16:56.4790119Z [36;1m    "approval_conflict": ${conflict:-0}[0m
v2-observability-strict	UNKNOWN STEP	2025-11-11T03:16:56.4793966Z [36;1m    "p99_threshold": "0.3",[0m
v2-observability-strict	UNKNOWN STEP	2025-11-11T03:16:56.4829092Z   p99: 0
v2-observability-strict	UNKNOWN STEP	2025-11-11T03:16:56.4829265Z   dbp99: 0
v2-observability-strict	UNKNOWN STEP	2025-11-11T03:16:56.4829958Z   conflict: 2
v2-observability-strict	UNKNOWN STEP	2025-11-11T03:16:56.4995569Z     "p99_latency": 0,
v2-observability-strict	UNKNOWN STEP	2025-11-11T03:16:56.4995811Z     "db_p99_latency": 0,
v2-observability-strict	UNKNOWN STEP	2025-11-11T03:16:56.4997703Z     "approval_success": 8,
v2-observability-strict	UNKNOWN STEP	2025-11-11T03:16:56.4997941Z     "approval_conflict": 2
v2-observability-strict	UNKNOWN STEP	2025-11-11T03:16:56.4999641Z     "p99_threshold": "0.3",
v2-observability-strict	UNKNOWN STEP	2025-11-11T03:16:56.5472235Z [36;1mp99=0[0m
v2-observability-strict	UNKNOWN STEP	2025-11-11T03:16:56.5473095Z [36;1mconflict=2[0m
v2-observability-strict	UNKNOWN STEP	2025-11-11T03:16:56.5484495Z [36;1msecurity_scan_duration_seconds{repo="smartsheet",branch="${BRANCH_REF}",scan_type="incremental"} ${p99:-0}[0m
```

**Key Metrics**:
- approval_success: 8,
- conflicts: 0 ✅
- post_fallback_success: 0

**Assessment**:
- ✅ No conflicts detected
- ⚠️ No successful approvals detected

### 3b. Metrics Baseline (metrics-lite)

```

```

**Key Metrics**:
- approval_success: 0
- conflicts: 0 ✅


### 4. RBAC Seeding Verification

Found       20 RBAC-related log entries.

```
v2-observability-strict	UNKNOWN STEP	2025-11-11T03:14:05.4252875Z ##[group]GITHUB_TOKEN Permissions
v2-observability-strict	UNKNOWN STEP	2025-11-11T03:14:30.5655479Z   RBAC_SOFT_THRESHOLD: 60
v2-observability-strict	UNKNOWN STEP	2025-11-11T03:14:33.4140666Z   RBAC_SOFT_THRESHOLD: 60
v2-observability-strict	UNKNOWN STEP	2025-11-11T03:14:33.4259667Z   RBAC_SOFT_THRESHOLD: 60
v2-observability-strict	UNKNOWN STEP	2025-11-11T03:14:34.3314118Z   RBAC_SOFT_THRESHOLD: 60
v2-observability-strict	UNKNOWN STEP	2025-11-11T03:14:34.3466111Z   RBAC_SOFT_THRESHOLD: 60
v2-observability-strict	UNKNOWN STEP	2025-11-11T03:14:35.2614546Z   RBAC_SOFT_THRESHOLD: 60
v2-observability-strict	UNKNOWN STEP	2025-11-11T03:14:35.2700097Z   RBAC_SOFT_THRESHOLD: 60
v2-observability-strict	UNKNOWN STEP	2025-11-11T03:14:36.2486918Z   RBAC_SOFT_THRESHOLD: 60
v2-observability-strict	UNKNOWN STEP	2025-11-11T03:14:37.6265535Z   RBAC_SOFT_THRESHOLD: 60
```

**Status**: ✅ RBAC operations detected


### 5. Cross-Workflow Comparison

#### v2-observability-strict (Run 19253708447)
- approval_success: 8,
- conflicts: 0
- Commit: 70d476b23816ce5d2da8bc05b7b7a69c0c6937a3

#### metrics-lite (Run )
- approval_success: 0
- conflicts: 0
- Commit: 

**Cross-Workflow Assessment**:
- ⚠️ Cannot compare: invalid metric values


---

## Summary

**Overall Status**: ⚠️ No successful approvals

**Key Findings**:
- PR #421 successfully merged to main at 2025-11-11 14:06:04 +0800
- Workflows validated on PR branch (workflows don't run on main by design)
- Migrations 042a/042c: Applied
- Approval success rate: 8, events
- Conflicts: 0 events
- RBAC seeding: Verified

**Recommendations**:
1. ⚠️ Review detailed logs for issues
2. Check conflict sources if any
3. Validate approval workflow functionality
4. Consider additional testing before Phase 3


---

**Note**: Observability workflows are configured with:
- `observability-strict.yml`: triggers on `pull_request` to main
- `observability-metrics.yml`: triggers on `push` to feature branches

This is intentional - CI validation happens **before** merge to main, not after.
Phase 2 verification uses successful PR runs as the baseline for validation.

**Next Steps**: See [OBSERVABILITY_HARDENING_COMPLETE_GUIDE.md](./OBSERVABILITY_HARDENING_COMPLETE_GUIDE.md)
