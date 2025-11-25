# Phase 5 SLO Recommendation (Derived)

Generated from `metrics.csv` using `scripts/phase5-slo-recommend.sh`.

## Observed Averages (Local Dev Placeholder)
- Success Rate Avg: 99.00%
- Latency Avg P50/P95/P99: 0.223s / 0.373s / 1.077s
- Fallback Avg: 4.62%
- Error Rate Avg: 0.00%
- CPU Avg: 0.00%
- Memory Avg: 0.00%
- Request Rate Avg: 0.0000 req/s

## Recommended Draft SLO Targets
| Metric | Target | Rationale |
|--------|--------|-----------|
| HTTP Success Rate | 98.00% | Observed 99.00% minus ~1% headroom |
| P99 Latency | 2.000s | 2x observed (cap 2s) |
| Fallback Ratio | < 9.23% | 2x observed capped at 10% |
| 5xx Error Rate | < 1.00% | Double observed (cap 2%, floor 1%) |
| CPU Utilization | < 30.00% | Observed +30% headroom (cap 70%) |
| Memory Utilization | < 30.00% | Observed +30% headroom (cap 80%) |

## Notes
- Replace placeholders after production rerun.
- Adjust latency targets if variance >30% in 24h window.
- Consider error budget: (100 - target success rate)% monthly.

Generated: $(date -Iseconds)
