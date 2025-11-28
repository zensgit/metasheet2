# Phase 5 Detailed Development & Operations Guide

## Purpose
This document consolidates the remaining development, validation, observability, and operational workflows for Phase 5 (SLO validation, cache, fallback, snapshots, Redis integration, Slack enrichment, baseline rotation, and SLO tightening).

---
## Quick Start (Local Memory Mode)
```bash
corepack enable && pnpm install --frozen-lockfile
PORT=8901 FEATURE_CACHE=true ENABLE_FALLBACK_TEST=true COUNT_CACHE_MISS_AS_FALLBACK=false ALLOW_UNSAFE_ADMIN=true pnpm --filter @metasheet/core-backend dev
API_BASE=http://127.0.0.1:8901 METRICS_URL=http://127.0.0.1:8901/metrics/prom bash scripts/phase5-run-all.sh
```
Artifacts: `/tmp/phase5.json`, `/tmp/phase5.md`, appended to `claudedocs/PHASE5_COMPLETION_REPORT_FINAL.md`.

---
## Environment Flags
| Flag | Dev (Validation) | Production | Notes |
|------|------------------|------------|-------|
| FEATURE_CACHE | true | true | Enables cache layer selection. |
| CACHE_IMPL | memory/redis | memory/redis | Redis optional. |
| ENABLE_FALLBACK_TEST | true | false | Dev-only fallback route. |
| COUNT_CACHE_MISS_AS_FALLBACK | false | false (usually) | Include cache_miss in effective fallback if true. |
| ALLOW_UNSAFE_ADMIN | true | false | Plugin reload & internal ops. |
| DISABLE_EVENT_BUS | (optional) true for degraded Redis startup | false | Avoid in production. |
| REDIS_ARTIFICIAL_DELAY_MS | simulation only | 0 | Adds latency for alert tests. |

---
## Critical File Map
Metrics registry: `packages/core-backend/src/metrics/metrics.ts`
Cache registry: `packages/core-backend/core/cache/CacheRegistry.ts`
Memory cache: `packages/core-backend/src/cache/implementations/memory-cache.ts`
Redis cache: `packages/core-backend/src/cache/implementations/redis-cache.ts`
Fallback recorder: `packages/core-backend/src/fallback/fallback-recorder.ts`
Snapshot routes: `packages/core-backend/src/routes/snapshots.ts`
Validator runner: `scripts/phase5-run-all.sh`
Full validator: `scripts/phase5-full-validate.sh`
Regression check: `scripts/phase5-regression-check.sh`
Baseline save: `scripts/phase5-save-baseline.sh`
Baseline auto-rotate: `scripts/phase5-baseline-auto-rotate.sh`
Slack summary builder: `scripts/phase5-build-slack-summary.sh`
Weekly trend: `scripts/phase5-weekly-trend.sh`
SLO suggestions: `scripts/phase5-slo-tighten-suggestions.sh`
Redis latency simulation: `scripts/phase5-simulate-redis-latency.sh`
HTTP error simulation: `scripts/phase5-simulate-http-errors.sh`
Prometheus rules: `ops/prometheus/phase5-recording-rules.yml`
Prometheus alerts: `ops/prometheus/phase5-alerts.yml`
Grafana dashboard: `docker/observability/grafana/dashboards/metasheet-overview.json`
Nightly workflow: `.github/workflows/phase5-nightly-validation-regression.yml`
Baseline rotation workflow: `.github/workflows/phase5-baseline-rotation.yml`

---
## Baseline Management
Memory baseline symlink: `baseline/phase5-baseline.json`
Redis baseline symlink: `baseline/phase5-baseline-redis.json`
Save baseline:
```bash
# Memory
bash scripts/phase5-save-baseline.sh /tmp/phase5.json baseline
# Redis
CACHE_IMPL=redis bash scripts/phase5-save-baseline.sh /tmp/phase5.json baseline
```
Regression check auto-selects per implementation:
```bash
# Memory
bash scripts/phase5-regression-check.sh baseline /tmp/phase5.json
# Redis
CACHE_IMPL=redis bash scripts/phase5-regression-check.sh baseline /tmp/phase5.json
```
Baseline rotation (after ≥14 PASS nightly JSONs):
```bash
bash scripts/phase5-baseline-auto-rotate.sh results/nightly baseline/phase5-baseline.json 14
```

---
## Redis Baseline Capture
1. Start Redis (e.g. `docker run -d --name metasheet-redis -p 6379:6379 redis:7`).
2. Ensure DB migrations applied.
3. Run validation in Redis mode:
```bash
PORT=8901 FEATURE_CACHE=true CACHE_IMPL=redis REDIS_URL=redis://127.0.0.1:6379 ENABLE_FALLBACK_TEST=true ALLOW_UNSAFE_ADMIN=true pnpm --filter @metasheet/core-backend dev
API_BASE=http://127.0.0.1:8901 METRICS_URL=http://127.0.0.1:8901/metrics/prom CACHE_IMPL=redis bash scripts/phase5-run-all.sh
CACHE_IMPL=redis bash scripts/phase5-save-baseline.sh /tmp/phase5.json baseline
```
4. Confirm latency samples:
```bash
curl -s $METRICS_URL | grep '^redis_operation_duration_seconds_bucket' | head
```
If only near-zero synthetic samples appear, increase sampling:
```bash
REDIS_SAMPLES=400 CACHE_IMPL=redis bash scripts/phase5-run-all.sh
```

---
## Alert Simulation & Verification
HTTP error burn rate:
```bash
bash scripts/phase5-simulate-http-errors.sh 50 200
```
Redis latency spike:
```bash
REDIS_ARTIFICIAL_DELAY_MS=100 CACHE_IMPL=redis bash scripts/phase5-simulate-redis-latency.sh 90
```
Fallback surge (dev route): ensure `ENABLE_FALLBACK_TEST=true` then trigger fallback script if present.
Check Prometheus:
```bash
curl -s http://localhost:19190/api/v1/query?query=ALERTS{alertstate="firing"}
```
Grafana annotation panel should display firing alerts (dashboard top annotations).

---
## Slack Summary QA
Manual build:
```bash
bash scripts/phase5-build-slack-summary.sh /tmp/phase5.json baseline/phase5-baseline.json claudedocs/PHASE5_SLO_SUGGESTIONS.json /tmp/cache_audit.txt > /tmp/slack.txt
cat /tmp/slack.txt
```
Verify presence of:
- Overall status + pass counts
- Baseline deltas (p95/p99, success/cache hit rate)
- Error budget remaining
- Top fallback reasons (if populated)
- Redis GET/SET p95/p99 (non-zero real samples)
- Folded SLO suggestion summary (if JSON exists)

---
## Weekly Trend & SLO Suggestions
Populate nightly JSONs under `results/nightly/phase5-YYYYMMDD.json`.
Weekly trend (7 days):
```bash
bash scripts/phase5-weekly-trend.sh results/nightly claudedocs/PHASE5_WEEKLY_TREND.md 7
```
SLO suggestions (30 days):
```bash
bash scripts/phase5-slo-tighten-suggestions.sh results/nightly claudedocs/PHASE5_SLO_SUGGESTIONS.json 30
```
Incorporate into nightly PR (workflow already does this if artifacts present).

---
## Threshold Automation (Planned)
1. Parse `claudedocs/PHASE5_SLO_SUGGESTIONS.json`.
2. Compare with current thresholds file (e.g. `scripts/phase5-thresholds.json`).
3. Propose new threshold values (e.g. median p95 * 1.15) and create patch.
4. Dry-run mode prints diff table without applying changes.

Suggested CLI pseudo-flow:
```bash
scripts/phase5-update-thresholds.sh claudedocs/PHASE5_SLO_SUGGESTIONS.json scripts/phase5-thresholds.json --dry-run
scripts/phase5-update-thresholds.sh claudedocs/PHASE5_SLO_SUGGESTIONS.json scripts/phase5-thresholds.json --apply
```

---
## Testing Strategy
Run all tests:
```bash
pnpm test
```
Recommended additions (partially implemented):
- Redis recovery attempts after forced disconnect.
- Fallback effective toggle scenario (already covered).
- Snapshot restore histogram presence (covered).
- Optional integration: simulate redis latency + assert percentile change.

---
## Observability Dashboard Enhancements
Already included panels: HTTP success, cache hit, plugin reload p95, snapshot create/restore p95, fallback effective ratio, Redis GET/SET p95, last failure age, sample counts.
Potential refinements:
- Add PASS/FAIL conditional coloring via value mappings per row.
- Long-window (30m / 6h) burn rate panel.
- Redis last failure age buckets (e.g. <300s green, >1800s yellow, >3600s red).

---
## Prometheus / Alerting Review
Recording Rules (examples):
- `metasheet:http_success_rate:5m`
- `metasheet:redis_get_p95:5m` / `:30m`
- `metasheet:fallback_reason_rate:5m`
Alerts (examples):
- High Redis p95 / sustained latency.
- HTTP success below SLO threshold.
- Fallback effective ratio spike.
Validate queries using:
```bash
curl -s 'http://localhost:19190/api/v1/query?query=metasheet:redis_get_p95:5m'
```

---
## Incident Simulation Checklist
| Scenario | Script / Action | Expected Metrics / Alerts |
|----------|-----------------|---------------------------|
| Redis latency spike | `REDIS_ARTIFICIAL_DELAY_MS=120 scripts/phase5-simulate-redis-latency.sh 90` | Redis p95 increase, alert firing |
| HTTP errors surge | `scripts/phase5-simulate-http-errors.sh 100 300` | Burn rate panel rise, HTTP success alert |
| Fallback surge | Trigger dev fallback route repeatedly | Fallback effective ratio alert if threshold set |
| Redis disconnect | Stop container `docker stop metasheet-redis` | Recovery attempts counter increments, last failure timestamp updates |

---
## Production Guardrails
| Item | Enforcement |
|------|-------------|
| Disable fallback test route | `ENABLE_FALLBACK_TEST=false` |
| Disable unsafe admin route | `ALLOW_UNSAFE_ADMIN=false` |
| Avoid degraded event bus flag | Omit `DISABLE_EVENT_BUS` |
| Secrets set | `METRICS_URL`, optional `METRICS_AUTH_HEADER`, `SLACK_WEBHOOK_URL`, `SLACK_CHANNEL`, `REDIS_URL` |
| Branch protection | Require “Phase 5 PR Validation” check |

---
## Remaining Mandatory Work (Estimate)
| Task | Est. Time |
|------|-----------|
| Redis real baseline capture | 1h |
| Dual-baseline regression validation | 0.5h |
| Alert simulations + runbook evidence | 1.5h |
| Slack payload Redis QA | 0.5h |
| TOTAL | ~3.5h |

---
## Recommended Improvements
| Task | Est. Time |
|------|-----------|
| Threshold auto-PR script | 2h |
| Baseline rotation dry-run & docs | 1h |
| Dashboard scoreboard + mappings | 1h |
| Internal auth fail / rate limit metrics | 1h |
| Redis failover test script | 1h |
| TOTAL | ~6h |

---
## Optional Enhancements
| Task | Est. Time |
|------|-----------|
| key_pattern cardinality guard | 1h |
| Long-window (6h) burn rate | 1h |
| Redis timeout ratio metric + alert | 1h |
| Nightly retention cleanup | 0.5h |
| Slack cache audit folding | 0.5h |
| Threshold PR approval workflow | 1h |
| TOTAL | ~5h |

---
## Acceptance Checklist
- [ ] Redis baseline file includes non-synthetic latency percentiles.
- [ ] Regression script selects correct baseline for both implementations.
- [ ] Alert annotations visible in Grafana after simulations.
- [ ] Slack summary contains Redis metrics, error budget, fallback breakdown.
- [ ] Weekly trend & SLO suggestion files appear in nightly PRs.
- [ ] Baseline rotation validated (≥14 PASS days).
- [ ] Threshold automation available (even if dry-run).
- [ ] All tests pass (`pnpm test`).

---
## Reference Commands (Copy/Paste)
Memory full run:
```bash
API_BASE=http://127.0.0.1:8901 METRICS_URL=http://127.0.0.1:8901/metrics/prom bash scripts/phase5-run-all.sh
```
Redis full run:
```bash
API_BASE=http://127.0.0.1:8901 METRICS_URL=http://127.0.0.1:8901/metrics/prom CACHE_IMPL=redis REDIS_URL=redis://127.0.0.1:6379 bash scripts/phase5-run-all.sh
```
Baseline save:
```bash
bash scripts/phase5-save-baseline.sh /tmp/phase5.json baseline
```
Redis baseline save:
```bash
CACHE_IMPL=redis bash scripts/phase5-save-baseline.sh /tmp/phase5.json baseline
```
Regression check:
```bash
bash scripts/phase5-regression-check.sh baseline /tmp/phase5.json
```
Weekly trend:
```bash
bash scripts/phase5-weekly-trend.sh results/nightly claudedocs/PHASE5_WEEKLY_TREND.md 7
```
SLO suggestions:
```bash
bash scripts/phase5-slo-tighten-suggestions.sh results/nightly claudedocs/PHASE5_SLO_SUGGESTIONS.json 30
```
Slack summary build:
```bash
bash scripts/phase5-build-slack-summary.sh /tmp/phase5.json baseline/phase5-baseline.json claudedocs/PHASE5_SLO_SUGGESTIONS.json /tmp/cache_audit.txt > /tmp/slack.txt
```
Alert simulation (HTTP errors):
```bash
bash scripts/phase5-simulate-http-errors.sh 50 200
```
Alert simulation (Redis latency):
```bash
REDIS_ARTIFICIAL_DELAY_MS=120 CACHE_IMPL=redis bash scripts/phase5-simulate-redis-latency.sh 90
```

---
## Next Action Suggestion
Proceed with Redis real baseline capture, then run alert simulations and update runbook with screenshots / outputs.

---
## Changelog
- v1: Initial comprehensive consolidation (auto-generated by assistant).

