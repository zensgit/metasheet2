# Issue Draft: Multi-Source Validation for Observability Metrics

**Priority**: P1 (High Value)
**Status**: Draft
**Created**: 2025-11-12
**Related**: Phase 4 Post-Deployment Optimizations

---

## Title

`[P1] Implement Multi-Source Validation for Observability Metrics Collection`

---

## Labels

`observability`, `enhancement`, `p1-high`, `phase5`, `reliability`

---

## Problem Statement

### Current Limitation

During Phase 3 24-hour observation (Samples #15-17), a temporary unavailability of CI workflow logs caused false CRIT alerts due to single data source dependency. While the system correctly triggered alerts and auto-recovered, this incident revealed:

1. **Single Point of Failure**: Dependency on CI logs creates vulnerability to external service disruptions
2. **False Positives**: Data source unavailability is indistinguishable from actual system failures
3. **No Cross-Validation**: Unable to verify metrics consistency across multiple collection methods

### Evidence

- **Incident Timeline**: 2025-11-12 03:55:59Z - 05:27:04Z (~1.5 hours)
- **Impact**: 3 samples with zero-valued metrics → CRIT alerts
- **Root Cause**: CI workflow logs temporarily unavailable (external dependency issue)
- **Recovery**: Automatic, no manual intervention required

**Reference**: `claudedocs/PHASE4_COMPLETION_REPORT_DRAFT_*.md` - "Transient Data Source Degradation" section

---

## Proposed Solution

### Multi-Source Validation Architecture

Implement a fallback chain with cross-validation:

```bash
# Priority order
1. Production Prometheus (if METRICS_URL available)
   └─ Validation: Check metric timestamps within expected window

2. CI Workflow Logs (current default)
   └─ Validation: Verify run completion status

3. Synthetic Fallback (last resort)
   └─ Tag with collect_empty_source alert flag
```

### Cross-Validation Logic

```bash
if [ -n "$METRICS_URL" ]; then
  prom_metrics=$(collect_from_prometheus)
  ci_metrics=$(collect_from_ci_logs)

  # Compare for consistency
  if [ "$prom_metrics" != "$ci_metrics" ]; then
    echo "⚠️  WARNING: Prometheus and CI logs disagree"
    # Use Prometheus as source of truth, log discrepancy
    echo "$TIMESTAMP | WARN | metric_disagreement | prom=$prom_metrics ci=$ci_metrics" >> alerts/collection-discrepancies.txt
  fi
fi
```

---

## Benefits

1. **Resilience to Single Source Failures**: System continues functioning when one data source is unavailable
2. **Cross-Validation**: Detects collection bugs and data quality issues
3. **Better Classification**: Distinguish between real failures and collection artifacts
4. **Improved Confidence**: Multiple sources increase go/no-go decision reliability

---

## Implementation Details

### Phase 1: Prometheus Integration
- [ ] Add Prometheus client library
- [ ] Implement `collect_from_prometheus()` function
- [ ] Add `METRICS_URL` environment variable support
- [ ] Test against local Prometheus instance

### Phase 2: Cross-Validation Logic
- [ ] Implement metric comparison logic
- [ ] Add discrepancy logging to `alerts/collection-discrepancies.txt`
- [ ] Define tolerance thresholds (e.g., ±5% for success_rate)
- [ ] Implement source-of-truth selection rules

### Phase 3: Fallback Orchestration
- [ ] Implement priority-based source selection
- [ ] Add retry logic for transient failures
- [ ] Implement timeout handling (15s per source)
- [ ] Add health check endpoints for each source

### Phase 4: Monitoring & Alerting
- [ ] Add collection health metrics to summary JSON
- [ ] Create alert for persistent source disagreements
- [ ] Document multi-source configuration in guide
- [ ] Update Phase 3 observation script

---

## Testing Strategy

1. **Unit Tests**:
   - Test each collection method independently
   - Test cross-validation logic with mock data
   - Test fallback chain prioritization

2. **Integration Tests**:
   - Test with real Prometheus instance
   - Test with CI logs
   - Test source disagreement scenarios

3. **Failure Scenarios**:
   - Prometheus unavailable
   - CI logs empty
   - Both sources unavailable
   - Sources return conflicting data

---

## Success Criteria

- [ ] All three collection methods working independently
- [ ] Cross-validation detects ≥90% of metric discrepancies
- [ ] Fallback chain activates correctly when primary source fails
- [ ] No false CRIT alerts due to single-source unavailability
- [ ] 2-hour production sanity check passes with multi-source enabled

---

## Related Documents

- `claudedocs/PHASE4_POST_DEPLOYMENT_OPTIMIZATIONS.md` - Section 4: Multi-Source Validation
- `scripts/observe-24h.sh` - Current single-source implementation
- `claudedocs/PHASE4_COMPLETION_REPORT_DRAFT_*.md` - Transient incident analysis

---

## Estimated Effort

**Complexity**: High (requires dual collection paths and comparison logic)
**Estimated Time**: 2-3 days
**Dependencies**: None (can implement independently)

---

## Follow-Up Tasks

After implementation:
- [ ] Run 2-hour production sanity with multi-source enabled
- [ ] Document configuration in `OBSERVABILITY_HARDENING_COMPLETE_GUIDE.md`
- [ ] Create dashboard showing source health and discrepancies
- [ ] Schedule weekly review of collection-discrepancies.txt

---

**Created by**: Claude Code (Automated)
**Context**: Phase 4 completion, identified from Sample #15-17 incident analysis
