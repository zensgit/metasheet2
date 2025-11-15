# Phase 3: 24-Hour Observation - Quick Start Guide

**📍 Current Status**: Phase 2 completed ✅ → Ready for Phase 3

---

## ⚡ Quick Start (3 Options)

### Option A: Production Monitoring (推荐)
```bash
# Set production Prometheus endpoint
export METRICS_URL="http://localhost:8900/metrics/prom"

# Start 24-hour observation
bash scripts/observe-24h.sh

# Script runs in background, checking every 30 minutes
# To stop early: touch artifacts/STOP_OBSERVATION
```

### Option B: Fast Testing (12-hour, 10-min intervals)
```bash
# For faster validation during development
export INTERVAL_SECONDS=600  # 10 minutes
export MAX_SAMPLES=72        # 12 hours

bash scripts/observe-24h.sh
```

### Option C: CI Logs Fallback (无生产环境)
```bash
# Uses latest successful PR run metrics
# No METRICS_URL needed

bash scripts/observe-24h.sh
```

---

## 📊 What the Script Does

**Sampling Strategy**:
- **Interval**: 30 minutes (default) or custom via `INTERVAL_SECONDS`
- **Duration**: 24 hours = 48 samples (or custom via `MAX_SAMPLES`)
- **Data Source Priority**:
  1. Production Prometheus (`$METRICS_URL` if set)
  2. CI workflow logs (fallback)

**Metrics Collected**:
| Metric | Target | Critical |
|--------|--------|----------|
| **Success Rate** | ≥ 98% | < 95% |
| **Conflicts** | 0 | ≥ 2 |
| **Fallback Ratio** | < 10% | > 25% |
| **P99 Latency** | < 0.30s | > 0.40s |

**Outputs**:
- `artifacts/observability-24h.csv` - 时序数据
- `artifacts/observability-24h-summary.json` - 滚动汇总
- Console logs with real-time status

---

## 🔍 Monitoring Progress

### Check Current Status
```bash
# View latest samples
tail -5 artifacts/observability-24h.csv

# View summary
cat artifacts/observability-24h-summary.json | jq

# Count samples collected
wc -l artifacts/observability-24h.csv
```

### Watch Live (开另一个终端)
```bash
# Real-time CSV updates
watch -n 60 'tail -5 artifacts/observability-24h.csv'

# Alert tracking
watch -n 60 'tail -1 artifacts/observability-24h.csv | cut -d, -f11-12'
```

### Early Stop (如需提前结束)
```bash
touch artifacts/STOP_OBSERVATION

# Script will complete current sample and exit gracefully
```

---

## 📈 After 24 Hours

### Generate Final Report
```bash
bash scripts/generate-phase3-report.sh
```

**Report Output**: `claudedocs/PHASE3_24H_OBSERVATION_REPORT_<timestamp>.md`

**Report Contents**:
1. Executive summary with overall status
2. Detailed metrics analysis (avg/min/max)
3. Anomalous events table
4. Alert history
5. Threshold compliance matrix
6. Recommendations for Phase 4

---

## ⚙️ Advanced Configuration

### Environment Variables

```bash
# Data source
export METRICS_URL="http://your-prod-server:8900/metrics/prom"

# Sampling configuration
export INTERVAL_SECONDS=1800   # 30 minutes
export MAX_SAMPLES=48           # 24 hours

# Run observation
bash scripts/observe-24h.sh
```

### Custom Thresholds (编辑脚本)
```bash
# In scripts/observe-24h.sh, modify:
SUCCESS_RATE_WARN=0.98
SUCCESS_RATE_CRIT=0.95
CONFLICTS_WARN=1
CONFLICTS_CRIT=2
FALLBACK_RATIO_WARN=0.10
FALLBACK_RATIO_CRIT=0.25
P99_WARN=0.30
P99_CRIT=0.40
```

---

## 🚨 Alert Interpretation

### Status Levels

| Status | Meaning | Action |
|--------|---------|--------|
| **OK** | All metrics within targets | Continue monitoring |
| **WARN** | Some metrics near limits | Watch closely |
| **CRIT** | Thresholds breached | Investigate immediately |

### Alert Flags

| Flag | Description | Trigger Condition |
|------|-------------|-------------------|
| `success_rate_warn` | Success rate < 98% | Single occurrence |
| `success_rate_crit` | Success rate < 95% | Single occurrence |
| `conflicts_warn` | Conflicts ≥ 1 | Single occurrence |
| `conflicts_crit` | Conflicts ≥ 2 | Single occurrence |
| `fallback_warn` | Fallback ratio > 10% | Single occurrence |
| `fallback_crit` | Fallback ratio > 25% | Single occurrence |
| `p99_warn` | P99 latency > 0.30s | Single occurrence |
| `p99_crit` | P99 latency > 0.40s | Single occurrence |
| `consecutive_fallback` | High fallback 2+ times in a row | 2 consecutive |
| `consecutive_success` | Low success 2+ times in a row | 2 consecutive |
| `consecutive_conflict` | High conflicts 2+ times in a row | 2 consecutive |
| `consecutive_p99` | High latency 2+ times in a row | 2 consecutive |

---

## 🔧 Troubleshooting

### Issue: Script can't find successful runs
**Symptom**: `⚠️ WARNING: No successful runs found`

**Solution**:
```bash
# Verify PR branch has recent successful runs
gh run list --repo zensgit/smartsheet \
  --branch ci/observability-hardening \
  --workflow "observability-strict.yml" \
  --limit 5

# If needed, set METRICS_URL for production data source
export METRICS_URL="http://localhost:8900/metrics/prom"
```

### Issue: Production metrics unavailable
**Symptom**: `⚠️ WARNING: Failed to fetch metrics from ...`

**Solution**:
```bash
# Test Prometheus endpoint
curl -s http://localhost:8900/metrics/prom | head -20

# Check if server is running
lsof -i :8900

# Script will automatically fall back to CI logs
```

### Issue: Disk space concerns
**Solution**:
```bash
# CSV file is small (~5KB for 48 samples)
ls -lh artifacts/observability-24h.csv

# If concerned, reduce samples:
export MAX_SAMPLES=24   # 12 hours instead of 24
```

---

## 📋 Typical Timeline

| Time | Event |
|------|-------|
| **T+0** | Start observation script |
| **T+30min** | Sample #1 collected |
| **T+1h** | Sample #2 collected |
| **T+12h** | Sample #24 collected |
| **T+24h** | Sample #48 collected, observation complete |
| **T+24h + 5min** | Generate Phase 3 report |
| **T+24h + 10min** | Review report, decide on Phase 4 |

---

## ✅ Success Criteria (Phase 3 → Phase 4)

**Proceed to Phase 4 if**:
- ✅ Average success rate ≥ 98%
- ✅ Total conflicts = 0
- ✅ Average fallback ratio < 10%
- ✅ Average P99 latency < 0.30s
- ✅ No consecutive alerts (2+ in a row)
- ✅ Critical alerts = 0

**Review Required if**:
- ⚠️ Warnings > 5 samples
- ⚠️ Success rate occasionally dips 95-98%
- ⚠️ Fallback ratio 10-25% sometimes

**DO NOT Proceed (consider rollback) if**:
- 🔴 Critical alerts > 0
- 🔴 Success rate < 95% ever
- 🔴 Conflicts ≥ 2 ever
- 🔴 Fallback ratio > 25% ever
- 🔴 Consecutive critical alerts (2+)

---

## 📚 Related Documents

- **Phase 2 Baseline**: [PHASE2_POST_MERGE_VERIFICATION_*.md](./PHASE2_POST_MERGE_VERIFICATION_20251111_145211.md)
- **Complete Guide**: [OBSERVABILITY_HARDENING_COMPLETE_GUIDE.md](./OBSERVABILITY_HARDENING_COMPLETE_GUIDE.md)
- **Rollback SOP**: [OBSERVABILITY_ROLLBACK_SOP.md](./OBSERVABILITY_ROLLBACK_SOP.md)

---

**Last Updated**: 2025-11-11
**Status**: ✅ Ready for Phase 3 execution
