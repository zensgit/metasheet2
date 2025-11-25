# Phase 5 Production Baseline Rerun Guide

Purpose: Execute canonical 2-hour production baseline with real Prometheus metrics and improved latency parsing.

## 1. Preconditions
- Production backend deployment healthy.
- Prometheus scraping endpoint reachable from runner.
- Histogram metrics exposed: `*_http_request_duration_seconds_bucket` (prefixed or unprefixed).
- Fallback and error metrics present: `http_requests_total`, `metasheet_fallback_total` (or equivalent legacy `fallback_total`).

## 2. Environment Variables
```bash
export METRICS_URL="https://prometheus.prod.example.com:9090/metrics/prom"
export INTERVAL_SECONDS=600      # 10m
export MAX_SAMPLES=12            # 2h window
```

## 3. Run
```bash
./scripts/phase5-observe.sh
```
Press Enter after pre-flight checks; ensure no terminal interruption.

## 4. Data Collected
- `metrics.csv`: success_rate, p99_latency (histogram-derived), fallback_ratio, sample_num
- `metadata.json`: configuration snapshot
- `summary.md`: aggregated statistics (auto-generated at completion)

## 5. Validating Latency Parsing
Check histogram buckets presence:
```bash
curl -s "$METRICS_URL" | grep http_request_duration_seconds_bucket | head
```
If absent, enable histogram metric in backend configuration (`buckets` array) and redeploy.

## 6. Post-Run Steps
1. Confirm all SLOs met (>=98% success, <=2s P99, <10% fallback).
2. Replace placeholder report with production metrics in `PHASE5_COMPLETION_REPORT.md` (append Production section).
3. Tag repository `v2.5.0-baseline` (optional) for baseline snapshot.
4. Archive CSV + metadata to `final-artifacts/phase5-prod-<date>/`.

## 7. Troubleshooting
| Symptom | Check | Action |
|---------|-------|--------|
| P99 always same | Bucket parsing order | Ensure buckets sorted ascending; verify counts increasing |
| Success rate 0.99 default | `http_requests_total` missing | Enable HTTP metrics middleware |
| Fallback ratio constant | Missing dedicated metric (`metasheet_fallback_total`); using retries proxy | Instrument real fallback counter in backend |
| Script exits pre-flight | `METRICS_URL` unreachable | Fix DNS/network/port; validate curl manually |

## 8. Extending to 24h
```bash
export MAX_SAMPLES=144   # 24h @10m
./scripts/phase5-observe.sh
```
Consider enabling plugin reload + snapshot operations periodically (cron or manual triggers) for operational success metrics during extended window.

## 9. Enhancements (Optional Pre-Rerun)
- Add CPU/memory sampling per interval.
- Add error-class breakdown (4xx vs 5xx) columns.
- Emit JSON summary for automated ingestion.

## 10. Acceptance Criteria
- All SLOs green across samples (variance acceptable <5%).
- No Sev-1/Sev-2 incidents during window.
- Histogram-based P99 reflects realistic production latency profile.
- Report updated and reviewed.

---
Generated: $(date -Iseconds)
