# Phase 5 Production Baseline Rerun Template

Use this template after completing the 2h production observation with enhanced script.

## 1. Run Metadata
- Start Time: <YYYY-MM-DD HH:MM:SS>
- End Time: <YYYY-MM-DD HH:MM:SS>
- Samples: 12 (10m interval)
- Metrics File: `results/phase5-prod-<date>/metrics.csv`
- Script Version: commit <sha>
- Prometheus Endpoint: `<METRICS_URL>`

## 2. Observed Metrics (Summary)
| Metric | Min | Max | Avg | SLO Target | Status |
|--------|-----|-----|-----|------------|--------|
| HTTP Success % | | | | 98.00% | |
| P50 Latency (s) | | | | (info) | |
| P95 Latency (s) | | | | (info) | |
| P99 Latency (s) | | | | 2.000s | |
| Fallback % | | | | < 9.23% | |
| 5xx Error Rate % | | | | < 1.00% | |
| CPU % | | | | < 30.00% | |
| Memory % | | | | < 30.00% | |
| Request Rate (req/s) | | | | (profile) | |
| Plugin Reload Success % | | | | ≥95% | |
| Snapshot Success % | | | | ≥99% | |

## 3. Variance & Stability
- Peak latency deviation vs average P99: <X>%
- Error rate spikes: <none / details>
- Resource utilization pattern: <describe>
- Throughput trend: <increasing/steady/variable>

## 4. Incidents / Anomalies
- Sev-1: <none>
- Sev-2: <none>
- Notable warnings: <list>

## 5. Root Cause Analyses (if any)
| Issue | Root Cause | Mitigation | Follow-Up |
|-------|-----------|------------|-----------|
|       |           |            |           |

## 6. Final SLO Confirmation
| SLO | Target | Observed | Verdict |
|-----|--------|----------|---------|
| HTTP Success Rate | 98.00% | | Pass/Fail |
| P99 Latency | 2.000s | | Pass/Fail |
| Fallback Ratio | < 9.23% | | Pass/Fail |
| 5xx Error Rate | < 1.00% | | Pass/Fail |
| CPU Utilization | < 30.00% | | Pass/Fail |
| Memory Utilization | < 30.00% | | Pass/Fail |

## 7. Adjusted SLOs (If Needed)
| Metric | New Target | Reason |
|--------|------------|--------|
|        |            |        |

## 8. Go/No-Go Decision
Decision: <Go/No-Go>
Rationale: <summary>
Next Phase Entry: <conditions>

## 9. Action Items
- [ ] Archive artifacts to `final-artifacts/phase5-prod-<date>/`
- [ ] Update `PHASE5_COMPLETION_REPORT.md` Production section
- [ ] Update README timeline date for Phase 5 canonical completion
- [ ] Tag release `v2.5.0-baseline`
- [ ] Create follow-up issues (latency variance, error budget tracking)

## 10. Attachments
- Metrics CSV snapshot
- Prometheus dashboard screenshots (Success Rate, Latency, Errors, CPU/Memory)
- Logs (any error spikes)

---
Generated: $(date -Iseconds)
