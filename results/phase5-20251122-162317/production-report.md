# Phase 5 Production Baseline Report (Auto-Filled)
Source Metrics: results/phase5-20251122-162317/metrics.csv

## Summary Table
| Metric | Min | Max | Avg | SLO Target | Status |
|--------|-----|-----|-----|------------|--------|
| HTTP Success % | 99.00 | 99.00 | 99.00 | 98.00% | Pass |
| P50 Latency (s) | 0.200 | 0.200 | 0.200 | info | Info |
| P95 Latency (s) | 0.400 | 0.400 | 0.400 | info | Info |
| P99 Latency (s) | 0.500 | 0.500 | 0.500 | 2.000s | Pass |
| Fallback % | 5.00 | 5.00 | 5.00 | < 9.23% | Pass |
| 5xx Error % | 0.00 | 0.00 | 0.00 | < 1.00% | Pass |
| CPU % | 0.00 | 0.00 | 0.00 | < 30.00% | Pass |
| Memory % | 0.20 | 0.20 | 0.20 | < 30.00% | Pass |
| Request Rate (req/s) | 0.0000 | 0.0000 | 0.0000 | profile | Info |

## SLO Verdict
Overall Decision: Go

## Details
- Samples: 5
- Success Rate Target: >= 98%
- Latency Target (P99): <= 2s
- Fallback Target: < 9.23%
- Error Rate Target: < 1%
- CPU Target: < 30%
- Memory Target: < 30%

## Next Actions
- Append this section to PHASE5_COMPLETION_REPORT.md under Production Section.
- Archive metrics & generated report to final-artifacts.
