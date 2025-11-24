# Phase 5 Production Baseline Preparation Checklist

**Created**: 2025-11-22 13:12 CST
**Target Start**: 2025-11-23 (After Sprint 2 completion)
**Duration**: 2 days
**Status**: 🟡 Preparation Phase

---

## Prerequisites

### ✅ Completed (Ready)
- [x] Phase 5 scripts verified present (13 scripts found)
- [x] Environment template created (`.env.phase5.template`)
- [x] Environment template enhanced with comprehensive SLO targets (2025-11-24)
- [x] Pre-flight validation script created (`phase5-verify-preconditions.sh`)
- [x] Comprehensive metrics guide created (`docs/phase5/METRICS_GUIDE.md`, 726 lines)
- [x] Enhancement implementation guide created (`docs/phase5/ENHANCEMENT_GUIDE.md`, 467 lines)
- [x] Working directory structure created (`final-artifacts/phase5-prep/`, `docs/phase5/`)
- [x] Sprint 2 preparation 100% complete
- [x] Local baseline established (Day 1: 17/17 tests, P95: 43ms)

### ⏳ Pending (Required Before Start)
- [ ] **Sprint 2 Decision Complete** (Target: 2025-11-22 22:30 CST)
- [ ] **Production Environment Access**:
  - [ ] Production Prometheus/Grafana URL
  - [ ] Production admin JWT token
  - [ ] Production BASE_URL endpoint
  - [ ] Database access credentials (optional, for capacity metrics)
- [ ] **Feature Flags Verification**:
  - [ ] `COUNT_CACHE_MISS_AS_FALLBACK=false` (confirmed in production)
  - [ ] `ENABLE_PHASE5_INTERNAL=false` (no internal features)
  - [ ] `ENABLE_FALLBACK_TEST=false` (no test mode)

---

## Phase 5 Scripts Inventory

### Core Execution Scripts
- ✅ `scripts/phase5-run-production-baseline.sh` - Main orchestrator
- ✅ `scripts/phase5-load.sh` - Load generation (rate=80, concurrency=20)
- ✅ `scripts/phase5-observe.sh` - Metrics collection (~2h, 12 samples)

### Report Generation
- ✅ `scripts/phase5-fill-production-report.sh` - Generate report from metrics.csv
- ✅ `scripts/phase5-append-production.sh` - Append to PHASE5_COMPLETION_REPORT.md

### Utilities
- ✅ `scripts/phase5-capture-env.sh` - Environment capture
- ✅ `scripts/phase5-slo-recommend.sh` - SLO recommendations
- ✅ `scripts/phase5-archive.sh` - Artifact archiving
- ✅ `scripts/phase5-completion.sh` - Completion tasks
- ✅ `scripts/phase5-demo-conclusion.sh` - Demo conclusion
- ✅ `scripts/phase5-partial-summary.sh` - Partial summary

---

## Metrics Schema (CSV v3)

Header (CSV v3):
```
timestamp,http_success_rate,p50_latency,p90_latency,p95_latency,p99_latency,raw_fallback_ratio,effective_fallback_ratio,error_rate,error_rate_4xx,error_rate_5xx,cpu_percent,rss_mb,request_rate,raw_fallback_total,effective_fallback_total,fallback_http,fallback_message,fallback_cache,http_adapter_ops,message_bus_rpc_attempts,cache_get_attempts,fb_http_ratio,fb_message_ratio,fb_cache_ratio,plugin_reload_success,plugin_reload_failure,snapshot_create_success,snapshot_create_failure,snapshot_restore_success,snapshot_restore_failure,cache_hit_rate,plugin_reload_p95,plugin_reload_p99,plugin_reload_success_rate,snapshot_operation_p95,snapshot_operation_p99,snapshot_success_rate,cache_hits_raw,cache_misses_raw,sample_num
```

Key Columns:
| Column | Description |
|--------|-------------|
| raw_fallback_ratio | Raw fallback ratio (includes cache misses; basis for visibility only) |
| effective_fallback_ratio | Effective fallback ratio (excludes cache misses when `COUNT_CACHE_MISS_AS_FALLBACK=false`) |
| cache_hit_rate | Cache hits / (hits + misses) |
| plugin_reload_p95/p99 | Plugin reload operation latency percentiles |
| snapshot_operation_p95/p99 | Snapshot create/restore latency percentiles |
| plugin_reload_success_rate | plugin reload success percentage |
| snapshot_success_rate | (create + restore success) / all snapshot ops |
| cache_hits_raw / cache_misses_raw | Raw counters used to compute global cache hit rate (preferred over per-sample average) |
| sample_num | Sequential sample index (1..N) |

Success Rate Definition: only 2xx/3xx considered successful; 4xx/5xx excluded. "NA" is emitted when TOTAL_REQUESTS=0 for the interval.

NA Handling Policy: NA values are neutral (do not auto-fail SLO); production Go/No-Go requires metrics to be non-NA for all mandatory SLO categories (success rate, latency P95/P99, effective fallback, error, memory, cache hit).

---

---

## Day 1 Execution Plan (2025-11-23)

### Morning (09:00-10:00) - Environment Preparation
**Duration**: ~1 hour
**Tasks**:
1. Copy template and fill production values:
   ```bash
   cp .env.phase5.template .env.phase5
   # Edit .env.phase5 with actual production credentials
   source .env.phase5
   ```

2. Verify production access:
   ```bash
   # Test Prometheus metrics endpoint
   curl -s "${METRICS_URL}/api/v1/query?query=up" | jq '.status'

   # Test production API health
   curl -s -H "Authorization: Bearer ${PROD_JWT}" "${LOAD_BASE_URL}/health" | jq '.'
   ```

3. Run 10-minute warmup:
   ```bash
   # Light load to warm up caches
   ./scripts/phase5-load.sh \
     --base-url "${LOAD_BASE_URL}" \
     --jwt "${PROD_JWT}" \
     --rate 20 \
     --concurrency 5 \
     --duration-seconds 600
   ```

### Afternoon (14:00-16:00) - 2h Production Baseline
**Duration**: ~2 hours (actual: 2h5m for buffer)
**Command**:
```bash
# Launch production baseline collection
./scripts/phase5-run-production-baseline.sh \
  --base-url "${LOAD_BASE_URL}" \
  --jwt "${PROD_JWT}" \
  --rate 80 \
  --concurrency 20 \
  --samples 12 \
  --interval-seconds 600

# Expected output directory: results/phase5-prod-<timestamp>/
# - metadata.json
# - load.log
# - observe.log
# - metrics.csv (populated progressively)
# - raw-metrics.txt
```

**Monitoring**:
```bash
# Check progress
tail -n +1 results/phase5-prod-*/metrics.csv

# Watch live updates
tail -f results/phase5-prod-*/observe.log | grep '📊'

# Verify processes running
ps -fp $(cat phase5-load.pid) $(cat phase5-observe.pid)
```

### Evening (16:30-17:30) - Report Generation
**Duration**: ~1 hour
**Tasks**:
1. Wait for completion:
   ```bash
   # Check if processes finished
   ps -fp $(cat phase5-load.pid) $(cat phase5-observe.pid) || echo "Completed"
   ```

2. Generate production report:
   ```bash
   RESULT_DIR=$(ls -td results/phase5-prod-* | head -1)
   ./scripts/phase5-fill-production-report.sh ${RESULT_DIR}/metrics.csv \
     > ${RESULT_DIR}/production-report.md
   ```

3. Append to completion report:
   ```bash
   ./scripts/phase5-append-production.sh ${RESULT_DIR}/production-report.md
   ```

4. Draft SLO recommendations:
   ```bash
   ./scripts/phase5-slo-recommend.sh ${RESULT_DIR}/metrics.csv \
     > docs/phase5/SLO_DRAFT.md
   ```

---

## Day 2 Execution Plan (2025-11-24)

### Morning (09:00-10:00) - Extended Validation
**Duration**: ~1 hour
**Purpose**: Validate consistency over longer period

**Command**:
```bash
# 1h extended validation (4 samples × 15min)
./scripts/phase5-run-production-baseline.sh \
  --base-url "${LOAD_BASE_URL}" \
  --jwt "${PROD_JWT}" \
  --rate 80 \
  --concurrency 20 \
  --samples 4 \
  --interval-seconds 900
```

### Optional - Fallback Scenario Test (If Time Permits)
**Duration**: ~30 minutes
**Condition**: Only if `COUNT_CACHE_MISS_AS_FALLBACK` needs validation

**Command**:
```bash
# Run with fallback counting enabled
COUNT_CACHE_MISS_AS_FALLBACK=true \
  ./scripts/phase5-run-production-baseline.sh \
    --base-url "${LOAD_BASE_URL}" \
    --jwt "${PROD_JWT}" \
    --rate 80 \
    --concurrency 20 \
    --samples 2 \
    --interval-seconds 900
```

### Afternoon (14:00-16:00) - Finalization
**Duration**: ~2 hours
**Tasks**:

1. **Finalize SLO Document**:
   ```bash
   # Review and finalize SLO recommendations
   vim docs/phase5/SLO_DRAFT.md
   # Move to final location
   mv docs/phase5/SLO_DRAFT.md docs/SLO_v2.5.0.md
   ```

2. **Update Documentation**:
   ```bash
   # Update main README with Phase 5 results
   # Add production metrics summary
   # Update SLO references
   vim docs/README.md
   vim docs/ROADMAP_V2.md
   ```

3. **Create Git Tag**:
   ```bash
   # Ensure all Phase 5 artifacts committed
   git add final-artifacts/phase5-* docs/phase5/ docs/SLO_v2.5.0.md
   git commit -m "feat: Phase 5 production baseline complete

   - Production baseline: 2h collection (12 samples)
   - Extended validation: 1h (4 samples)
   - SLO calibration: P95/P99 targets from production data
   - Prometheus metrics: 6 core metrics validated
   - Production artifacts archived

   Results:
   - P95 latency: [value]ms
   - P99 latency: [value]ms
   - Memory usage: [value]MB avg
   - Fallback rate: [value]%
   - Cache hit rate: [value]%
   - Error rate: [value]%

   🤖 Generated with Claude Code

   Co-Authored-By: Claude <noreply@anthropic.com>"

   # Create release tag
   git tag -a v2.5.0-baseline -m "Phase 5 Production Baseline - v2.5.0"

   # Push to remote
   git push origin feature/sprint2-snapshot-protection
   git push origin v2.5.0-baseline
   ```

4. **Archive Artifacts**:
   ```bash
   # Archive all Phase 5 results
   ARCHIVE_READONLY=true ./scripts/phase5-archive.sh results/phase5-prod-*
   ```

---

## Success Criteria

### Technical Metrics
- [ ] Production baseline collected: ≥12 samples over ≥2 hours
- [ ] Extended validation: ≥4 samples over ≥1 hour
- [ ] Core Metrics (enumerated 8 now):
  1. HTTP Success Rate
  2. Latency P95 / P99
  3. Raw Fallback Ratio
  4. Effective Fallback Ratio (cache misses excluded when COUNT_CACHE_MISS_AS_FALLBACK=false)
  5. Error Rate (overall + 4xx/5xx split)
  6. RSS Memory Usage
  7. Cache Hit Rate (hits / (hits + misses))
  8. Plugin & Snapshot Success Rates
- [ ] **Latency**: P95 ≤ 150ms, P99 ≤ 250ms
- [ ] **Memory**: RSS ≤ 500MB average
- [ ] **Cache Performance**: Hit rate ≥ 80%
- [ ] **Success Rates**: Plugin reload ≥ 95%, Snapshot operations ≥ 99%
- [ ] **Error Rate**: ≤ 1% overall
- [ ] **Effective Fallback**: ≤ 5% (cache misses excluded)

### Documentation
- [ ] Production report generated with all sections
- [ ] SLO document finalized with targets and rationale
- [ ] README.md updated with Phase 5 summary
- [ ] ROADMAP_V2.md updated with completion status
- [ ] PHASE5_COMPLETION_REPORT.md finalized

### Version Control
- [ ] All artifacts committed and pushed
- [ ] Git tag v2.5.0-baseline created
- [ ] Tag pushed to remote
- [ ] Branch merged to main (if approved)

---

## Rollback Plan

### If Production Issues Detected
1. **Stop Load Immediately**:
   ```bash
   kill $(cat phase5-load.pid)
   kill $(cat phase5-observe.pid)
   ```

2. **Notify DevOps**:
   - Report production impact immediately
   - Provide load parameters and duration
   - Share partial results if available

3. **Partial Results Handling**:
   ```bash
   # Save whatever was collected
   RESULT_DIR=$(ls -td results/phase5-prod-* | head -1)
   ./scripts/phase5-partial-summary.sh ${RESULT_DIR}
   ```

### If Access Issues
1. **Verify Credentials**:
   ```bash
   # Re-test all endpoints
   ./scripts/phase5-capture-env.sh
   ```

2. **Escalate to DevOps**:
   - Request credential refresh
   - Verify network access
   - Check rate limits

3. **Use Staging Alternative** (If Production Unavailable):
   - Document as "staging baseline" not production
   - Adjust SLO confidence accordingly
   - Plan production collection later

---

## Risk Mitigation

### Production Load Impact
- **Mitigation**: Conservative load parameters (rate=80, concurrency=20)
- **Monitoring**: Watch error rate and effective fallback (exclude cache misses) for spikes
- **Circuit Breaker**: Stop immediately if error rate > 2% or effective fallback > 8%

### Raw vs Effective Fallback Definition
- Raw Fallback: All recorded fallback events (including cache misses if flag true)
- Effective Fallback: Degradation events excluding pure cache misses when `COUNT_CACHE_MISS_AS_FALLBACK=false`
- Purpose: Prevent normal cache cold misses from inflating degradation metrics

### Cache Hit Rate Calculation
- Metics: `cache_hits_total`, `cache_miss_total`
- Formula: hits / (hits + misses)
- Target: ≥ `CACHE_HIT_RATE_TARGET` (env, default 80%)

### Plugin & Snapshot Success Rates
- Plugin Success Rate: success / (success + failure) from `metasheet_plugin_reload_total`
- Snapshot Success Rate: (create_success + restore_success) / (all snapshot ops) from snapshot metrics
- Latency Percentiles (if available): histogram buckets parsed for p95/p99 on reload and snapshot operations

### Credential Security
- **Mitigation**: Store JWT in `.env.phase5` (gitignored)
- **Cleanup**: Delete JWT from environment after completion
- **Rotation**: Request new JWT daily if multi-day work

### Data Collection Failures
- **Mitigation**: Incremental CSV saves (every 10 minutes)
- **Recovery**: Partial results still useful for trends
- **Backup**: Keep raw-metrics.txt for manual analysis

---

## File Locations

### Configuration
- `.env.phase5` - Production environment variables (gitignored)
- `.env.phase5.template` - Template for reference

### Results
- `results/phase5-prod-<timestamp>/` - Timestamped result directories
  - `metadata.json` - Execution parameters
  - `metrics.csv` - Structured metrics (main artifact)
  - `raw-metrics.txt` - Raw Prometheus scrapes
  - `load.log` - Load generator logs
  - `observe.log` - Observer logs
  - `production-report.md` - Generated report

### Documentation
- `docs/phase5/PHASE5_PREPARATION_CHECKLIST.md` - This file
- `docs/phase5/SLO_DRAFT.md` - Draft SLO document (Day 1)
- `docs/SLO_v2.5.0.md` - Final SLO document (Day 2)
- `docs/PHASE5_COMPLETION_REPORT.md` - Comprehensive completion report

### Archives
- `final-artifacts/phase5-prep/` - Preparation work
- `final-artifacts/phase5-prod-<timestamp>.tar.gz` - Archived results

---

## Next Steps (After This Preparation)

**Immediate** (Today, 2025-11-22):
- [x] Create preparation checklist
- [x] Verify scripts present
- [x] Create environment template
- [x] Create directory structure
- [ ] Run Sprint 2 checkpoint at 17:00 CST
- [ ] Continue monitoring until 22:28 CST decision

**Tomorrow** (2025-11-23):
- [ ] Execute Sprint 2 decision (staging validation OR PR submission)
- [ ] After Sprint 2 complete: Begin Phase 5 Day 1
- [ ] Morning: Environment prep + warmup
- [ ] Afternoon: 2h production baseline
- [ ] Evening: Report generation

**Day After** (2025-11-24):
- [ ] Morning: Extended validation
- [ ] Afternoon: Finalization + git tag
- [ ] Complete Phase 5 and create v2.5.0-baseline tag

---

**Prepared By**: Claude Code
**Session**: Sprint 2 + Phase 5 Preparation
**Status**: ✅ Preparation Complete, Awaiting Sprint 2 Decision
