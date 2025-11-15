# Phase 2: Post-Merge Verification Report

**Execution Time**: $(date)
**PR**: #421 (ci/observability-hardening)

---

## Verification Results


### 1. Main Branch CI Run

- **Run ID**: 19172740657
- **Conclusion**: success
- **Created**: 2025-11-07T15:19:35Z
- **Status**: ✅ PASS


### 2. Migration Verification

#### 042a_core_model_views.sql
```

```
**Status**: ❌ Not Found

#### 042c_audit_placeholder.sql
```

```
**Status**: ❌ Not Found


### 3. Metrics Baseline (Main Branch)

```
v2-observability-strict	UNKNOWN STEP	2025-11-07T15:22:14.3434819Z [36;1m  echo "conflict=$CONFLICT"[0m
v2-observability-strict	UNKNOWN STEP	2025-11-07T15:22:14.3437162Z [36;1m  "p99": $P99,[0m
v2-observability-strict	UNKNOWN STEP	2025-11-07T15:22:14.3437378Z [36;1m  "dbp99": $DBP99,[0m
v2-observability-strict	UNKNOWN STEP	2025-11-07T15:22:14.3438011Z [36;1m  "approvals": {"success": $SUCCESS, "conflict": $CONFLICT},[0m
v2-observability-strict	UNKNOWN STEP	2025-11-07T15:22:14.3865828Z [36;1m    "p99_latency": ${p99:-null},[0m
v2-observability-strict	UNKNOWN STEP	2025-11-07T15:22:14.3866103Z [36;1m    "db_p99_latency": ${dbp99:-null},[0m
v2-observability-strict	UNKNOWN STEP	2025-11-07T15:22:14.3868907Z [36;1m    "approval_success": ${success:-0},[0m
v2-observability-strict	UNKNOWN STEP	2025-11-07T15:22:14.3869191Z [36;1m    "approval_conflict": ${conflict:-0}[0m
v2-observability-strict	UNKNOWN STEP	2025-11-07T15:22:14.3873173Z [36;1m    "p99_threshold": "0.3",[0m
v2-observability-strict	UNKNOWN STEP	2025-11-07T15:22:14.3911582Z   p99: 0
v2-observability-strict	UNKNOWN STEP	2025-11-07T15:22:14.3911753Z   dbp99: 0
v2-observability-strict	UNKNOWN STEP	2025-11-07T15:22:14.3912665Z   conflict: 2
v2-observability-strict	UNKNOWN STEP	2025-11-07T15:22:14.4092960Z     "p99_latency": 0,
v2-observability-strict	UNKNOWN STEP	2025-11-07T15:22:14.4093313Z     "db_p99_latency": 0,
v2-observability-strict	UNKNOWN STEP	2025-11-07T15:22:14.4095271Z     "approval_success": 8,
v2-observability-strict	UNKNOWN STEP	2025-11-07T15:22:14.4095503Z     "approval_conflict": 2
v2-observability-strict	UNKNOWN STEP	2025-11-07T15:22:14.4097127Z     "p99_threshold": "0.3",
v2-observability-strict	UNKNOWN STEP	2025-11-07T15:22:14.4607099Z [36;1mp99=0[0m
v2-observability-strict	UNKNOWN STEP	2025-11-07T15:22:14.4607866Z [36;1mconflict=2[0m
v2-observability-strict	UNKNOWN STEP	2025-11-07T15:22:14.4618442Z [36;1msecurity_scan_duration_seconds{repo="smartsheet",branch="${BRANCH_REF}",scan_type="incremental"} ${p99:-0}[0m
```

**Key Metrics**:
- approval_success: 
- conflicts:  ⚠️
- post_fallback_success:  ⚠️

**Assessment**:
- ⚠️  Conflicts present: 
- ❌ No successful approvals
- ⚠️  High fallback dependency

