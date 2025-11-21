Sprint 2 Staging Latency Smoke Test Notes

Purpose
The `scripts/staging-latency-smoke.sh` script provides a ~30s rapid health and latency snapshot across five critical endpoints prior to (or between) full validation runs.

Endpoints Covered
- `/health` (unauthenticated)
- `/api/snapshots`
- `/api/snapstats`
- `/api/v2/admin/protection-rules`
- `/api/plugins`

Key Behavior
- Samples per endpoint default: 5 (override via `SAMPLES=` env).
- Measures time_total via curl, converts seconds to integer ms.
- Failing curl → latency 999 (counted as error).
- Thresholds: warning ≥150ms; critical ≥250ms.
- Status icons: ✅ (<150ms avg), ⚠️ (≥150ms avg), 🔴 (≥250ms avg) or failure.

JSON Output
Set `SMOKE_JSON_OUT=docs/sprint2/performance/smoke-last.json` to produce a structured summary:
```
{
  "base_url": "https://staging.example.com",
  "samples": 5,
  "threshold_warning_ms": 150,
  "threshold_critical_ms": 250,
  "overall_avg_ms": 42,
  "endpoints": [
    {"name": "health", "min_ms": 30, "max_ms": 35, "avg_ms": 32, "errors": 0, "status_icon": "✅"},
    ...
  ]
}
```

Usage Examples
```
export STAGING_JWT="<token>"
export STAGING_BASE_URL="https://staging.company.com"
SMOKE_JSON_OUT=docs/sprint2/performance/smoke-$(date +%Y%m%d_%H%M%S).json \
  bash scripts/staging-latency-smoke.sh "$STAGING_JWT" "$STAGING_BASE_URL"
```

Exit Codes
- 0: all endpoints healthy within warning threshold
- 1: at least one warning or critical latency
- 2: at least one endpoint failed all samples

Common Issues
- All failures: check network reachability / token validity.
- High latency only on `/api/snapstats`: verify DB load or aggregation changes.
- Errors on protected endpoints: ensure JWT role includes `admin` for admin routes.

Change Log
- Added JSON output (`SMOKE_JSON_OUT`) option.
- Hardened ms conversion and result table alignment.
- Added documentation (this file) in Sprint 2 standby phase.

