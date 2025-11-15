# Phase 5 Completion Guide

**Phase 5 Production 2-Hour Baseline - Completion Procedures**

---

## 📋 Overview

This guide provides step-by-step instructions for completing Phase 5 after the 2-hour production baseline observation has finished.

**Automation Script**: `scripts/phase5-completion.sh`

---

## ✅ Prerequisites

Before running the completion script, verify:

1. **Observation completed**:
   ```bash
   jq -r '.status' artifacts/observability-24h-summary.json
   # Expected output: "completed"
   ```

2. **All samples collected**:
   ```bash
   jq -r '.samples_collected,.total_samples' artifacts/observability-24h-summary.json
   # Expected: 12 / 12 (or your MAX_SAMPLES value)
   ```

3. **Required files exist**:
   ```bash
   ls -lh artifacts/observability-24h.csv
   ls -lh artifacts/observability-24h-summary.json
   ls -lh artifacts/observe-24h.log
   ```

---

## 🚀 Quick Start

### Automated Completion (Recommended)

Run the automated completion script:

```bash
cd metasheet2
bash scripts/phase5-completion.sh
```

The script will:
- ✅ Verify observation completion
- ✅ Create archive directory: `final-artifacts/phase5-prod-2h/`
- ✅ Copy all observation files
- ✅ Generate SHA256 checksums
- ✅ Calculate final metrics (excluding COLD_START/CRIT samples)
- ✅ Update master guide with Phase 5 summary

---

## 📊 Manual Completion Steps

If you prefer manual execution or need to customize the process:

### Step 1: Create Archive Directory

```bash
mkdir -p final-artifacts/phase5-prod-2h
```

### Step 2: Copy Observation Files

```bash
# Required files
cp artifacts/observability-24h.csv final-artifacts/phase5-prod-2h/
cp artifacts/observability-24h-summary.json final-artifacts/phase5-prod-2h/
cp artifacts/observe-24h.log final-artifacts/phase5-prod-2h/

# Optional: Copy phase5-run.log if exists
cp artifacts/phase5-run.log final-artifacts/phase5-prod-2h/ 2>/dev/null || true

# Optional: Copy deduplication variants if they exist
cp artifacts/observability-24h.*.csv final-artifacts/phase5-prod-2h/ 2>/dev/null || true
```

### Step 3: Generate Checksums

```bash
cd final-artifacts/phase5-prod-2h
shasum -a 256 * | grep -v CHECKSUMS.txt | sort > CHECKSUMS.txt
cd ../..
```

### Step 4: Calculate Final Metrics

Exclude COLD_START and CRIT samples:

```bash
awk -F',' '
  NR>1 && $11!="COLD_START" && $11!="CRIT" {
    s+=$9; f+=$10; c+=$5; p+=$7; db+=$8; n++
  }
  END {
    printf "samples=%d success_rate=%.4f fallback_ratio=%.4f p99_avg=%.3fs db_p99_avg=%.3fs conflicts=%d\n",
           n, s/n, f/n, p/n, db/n, c
  }
' artifacts/observability-24h.csv
```

**Expected Output Example**:
```
samples=11 success_rate=0.9900 fallback_ratio=0.0500 p99_avg=0.250s db_p99_avg=0.120s conflicts=0
```

### Step 5: Verify Checksums

```bash
cd final-artifacts/phase5-prod-2h
shasum -a 256 -c CHECKSUMS.txt
cd ../..
```

Expected output: All files should show `OK`

### Step 6: Update Master Guide

Add Phase 5 completion summary to `claudedocs/OBSERVABILITY_HARDENING_COMPLETE_GUIDE.md`:

```markdown
**Phase 5 完成摘要 (YYYY-MM-DD)**: Production 2小时基线采集已完成 | 有效样本: N个 | 成功率: X.XX (目标: ≥0.98) | 回退率: X.XX (目标: <0.10) | P99延迟: X.XXXs (目标: <0.30s) | 冲突数: N (目标: 0) | 数据归档: [`final-artifacts/phase5-prod-2h/`](final-artifacts/phase5-prod-2h/) | 校验和已验证 | Issue #1 已完成
```

---

## 📈 Metrics Interpretation

### Success Criteria

| Metric | Target | Pass Condition |
|--------|--------|----------------|
| Success Rate | ≥ 98% | Must meet |
| Fallback Ratio | < 10% | Must meet |
| Conflicts | 0 | Must meet |
| P99 Latency | < 0.30s | Recommended |

### Assessment Levels

**🎉 Production Ready**:
- Success Rate ≥ 98% ✅
- Fallback Ratio < 10% ✅
- Zero conflicts ✅
- P99 Latency < 0.30s ✅

**✅ Critical Targets Met**:
- Success Rate ≥ 98% ✅
- Fallback Ratio < 10% ✅
- Zero conflicts ✅
- P99 Latency needs attention ⚠️

**⚠️ Review Required**:
- One or more critical targets not met
- Investigate root causes before production deployment

---

## 🔍 Troubleshooting

### Issue: Observation Not Completed

**Symptom**:
```bash
jq -r '.status' artifacts/observability-24h-summary.json
# Output: "in_progress" or "stopped"
```

**Solution**:
1. Check if observation script is still running:
   ```bash
   ps aux | grep observe-24h.sh
   ```

2. Check logs for errors:
   ```bash
   tail -100 artifacts/observe-24h.log
   ```

3. If stopped prematurely, review `STOP_OBSERVATION` signal:
   ```bash
   ls -la artifacts/STOP_OBSERVATION
   ```

### Issue: Missing Files

**Symptom**: Required files not found in `artifacts/`

**Solution**:
1. Check current working directory:
   ```bash
   pwd
   # Should be: /path/to/metasheet2
   ```

2. Check if OUT_DIR was customized:
   ```bash
   echo $OUT_DIR
   # If set, files will be in that directory instead of artifacts/
   ```

3. Search for files:
   ```bash
   find . -name "observability-24h-summary.json"
   ```

### Issue: All Samples Are COLD_START

**Symptom**: Metrics calculation shows 0 valid samples

**Solution**:
- First sample is always COLD_START (expected)
- If all 12 samples are COLD_START, check:
  - INTERVAL_SECONDS setting (should be 600)
  - Observation window duration (should be ~2 hours)
  - Script logs for restart indicators

### Issue: High Failure Rate

**Symptom**: Success rate < 98%

**Investigation Steps**:
1. Check for CRIT events:
   ```bash
   grep "CRIT" artifacts/observability-24h.csv
   ```

2. Review specific failed samples:
   ```bash
   awk -F',' 'NR>1 && $9<0.98 {print}' artifacts/observability-24h.csv
   ```

3. Analyze fallback ratio correlation:
   ```bash
   awk -F',' 'NR>1 {printf "%s: success=%.2f fallback=%.2f\n", $1, $9, $10}' artifacts/observability-24h.csv
   ```

---

## 📝 Post-Completion Checklist

After running the completion script:

### 1. Review Metrics
- [ ] Check `final-artifacts/phase5-prod-2h/phase5-final-metrics.txt`
- [ ] Verify all targets met
- [ ] Document any anomalies

### 2. Verify Data Integrity
- [ ] Run checksum verification
- [ ] Confirm all files archived
- [ ] Check file sizes are reasonable

### 3. Update Documentation
- [ ] Master guide updated with Phase 5 summary
- [ ] Metrics recorded in documentation
- [ ] Screenshots of Grafana dashboards (if applicable)

### 4. GitHub Updates
- [ ] Update Issue #1 with final metrics
- [ ] Add completion comment with metrics summary
- [ ] Close Issue #1 if all targets met

### 5. Git Commit
```bash
git add final-artifacts/phase5-prod-2h/
git add claudedocs/OBSERVABILITY_HARDENING_COMPLETE_GUIDE.md
git commit -m "docs: Phase 5 production baseline completion

- Archived 2-hour observation data (12 samples)
- Final metrics: success_rate=X.XX, fallback=X.XX, p99=X.XXs
- All targets met / Review required (choose one)
- Updated master guide with Phase 5 summary

Related: Issue #1"

git push origin main
```

### 6. Create Release (Optional)

If all targets met:

```bash
git tag -a v2.5.0 -m "Phase 5 Production Baseline Complete

- 2-hour production baseline established
- Success rate: X.XX (≥98% target)
- Fallback ratio: X.XX (<10% target)
- P99 latency: X.XXs (<0.30s target)
- Zero conflicts

Production ready ✅"

git push origin v2.5.0

gh release create v2.5.0 \
  --repo zensgit/metasheet2 \
  --title "Release v2.5.0 - Phase 5 Complete" \
  --notes "Phase 5 production baseline complete. See Issue #1 for details."
```

---

## 🎯 Next Steps After Phase 5

### Option A: Production Deployment
If all metrics meet targets:
1. Plan production rollout
2. Configure monitoring alerts
3. Set up on-call rotation
4. Document runbooks

### Option B: Extended Monitoring
If metrics need validation:
1. Run extended observation window (24-48 hours)
2. Analyze trends over time
3. Tune alert thresholds
4. Revalidate metrics

### Option C: Optimization
If P99 latency needs improvement:
1. Profile slow endpoints
2. Optimize database queries
3. Review caching strategies
4. Run Phase 5 again after optimizations

---

## 📚 Related Documentation

- **Phase 5 Issue**: [#1](https://github.com/zensgit/metasheet2/issues/1)
- **Phase 5 Execution Guide**: [ISSUE_DRAFT_PHASE5_PROD_ENDPOINT.md](ISSUE_DRAFT_PHASE5_PROD_ENDPOINT.md)
- **Alert Integration**: [ALERT_INTEGRATION_CONFIG.md](ALERT_INTEGRATION_CONFIG.md)
- **Master Guide**: [OBSERVABILITY_HARDENING_COMPLETE_GUIDE.md](OBSERVABILITY_HARDENING_COMPLETE_GUIDE.md)

---

**🤖 Generated with [Claude Code](https://claude.com/claude-code)**

**Last Updated**: 2025-11-15
