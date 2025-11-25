# Phase 5 Production Baseline Report (Auto-Filled)
Source Metrics: results/phase5-20251124-142059/metrics.csv

## Summary Table
| Metric | Min | Max | Avg | StdDev | SLO Target | Status |
|--------|-----|-----|-----|--------|------------|--------|
| HTTP Success % | 99.00 | 99.00 | 99.00 | 0.00 | 98.00% | Pass |
| P50 Latency (s) | 0.000 | 0.000 | 0.000 | - | info | Info |
| P90 Latency (s) | 0.000 | 0.000 | 0.000 | - | info | Info |
| P95 Latency (s) | 0.000 | 0.000 | 0.000 | - | info | Info |
| P99 Latency (s) | 0.001 | 0.001 | 0.001 | 0.000 | 2.000s | Pass |
| Fallback % (Raw) | 0.00 | 0.00 | 0.00 | 0.00 | < 9.23% | Pass |
| Effective Fallback % | 0.00 | 0.00 | 0.00 | 0.00 | < 9.23% | Pass |
| Combined Error % | 0.00 | 0.00 | 0.00 | 0.00 | < 1.00% | Pass |
| 4xx Error % (avg) | - | - | 0.00 | - | monitor | Info |
| 5xx Error % (avg) | - | - | 0.00 | - | monitor | Info |
| CPU % | 3.40 | 5.20 | 4.38 | - | < 30.00% | Pass |
| RSS MB | 42.39 | 90.45 | 78.02 | - | < 30.00MB | Fail |
| Request Rate (req/s) | 0.0000 | 78.7166 | 68.9583 | - | profile | Info |
| Fallback Total (raw) | - | - | 0 | context | Info |
| Fallback Total (effective) | - | - | 0 | context | Info |
| Fallback HTTP | - | - | 0 | context | Info |
| Fallback MessageBus | - | - | 0 | context | Info |
| Fallback Cache | - | - | 0 | context | Info |
| HTTP Adapter Ops | - | - | 0 | volume | Info |
| MessageBus RPC Attempts | - | - | 0 | volume | Info |
| Cache Get Attempts | - | - | 0 | volume | Info |
| HTTP Fallback % (src) | - | - | 0.000 | - | Info |
| MessageBus Fallback % (src) | - | - | 0.000 | - | Info |
| Cache Fallback % (src) | - | - | 0.000 | - | Info |
| Avg HTTP Fallback % (src row) | - | - | 0.000 | - | Info |
| Avg MessageBus Fallback % (src row) | - | - | 0.000 | - | Info |
| Avg Cache Fallback % (src row) | - | - | 0.000 | - | Info |
| Effective Fallback % (last sample) | - | - | 0.00 | - | context | Info |

## SLO Verdict
Overall Decision: No-Go

## Details
- Samples: 12
- Success Rate Target: >= 98%
- Latency Target (P99): <= 2s
- Fallback Target (Raw): < 9.23%
- Effective Fallback Target: < 9.23%
- Error Rate Target: < 1%
- CPU Target: < 30%
- Memory Target: < 30%

## Next Actions
- Append this section to PHASE5_COMPLETION_REPORT.md under Production Section.
- Archive metrics & generated report to final-artifacts.
- Validate fallback source proportions (HTTP vs MessageBus vs Cache).
| Plugin Reload Success | - | - | 0 | - | Info |
| Plugin Reload Failure | - | - | 0 | - | Info |
| Snapshot Create Success | - | - | 0 | - | Info |
| Snapshot Create Failure | - | - | 0 | - | Info |
| Snapshot Restore Success | - | - | 0 | - | Info |
| Snapshot Restore Failure | - | - | 0 | - | Info |
