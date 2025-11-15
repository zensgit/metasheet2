# Admin & Telemetry Guide

This guide shows how to inspect sanitized config, trigger config reload (hot), and verify telemetry-related metrics.

## Admin Endpoints

- GET `/api/admin/config`
  - Returns sanitized config (secrets masked/omitted)
  - Requires admin role
- POST `/api/admin/config/reload`
  - Reloads configuration from environment
  - Emits metrics: `config_reload_total{result}`
  - Updates `config_sampling_rate` gauge (if telemetry configured)

Authorization
- For local/CI, mint a dev token (non-prod only):
  - GET `/api/auth/dev-token?roles=admin`

Example (bash)
```bash
ORIGIN=${ORIGIN:-http://localhost:8900}
TOKEN=$(curl -s "$ORIGIN/api/auth/dev-token?roles=admin" | jq -r .token)

# Get sanitized config
curl -s -H "Authorization: Bearer $TOKEN" "$ORIGIN/api/admin/config" | jq

# Trigger reload
curl -s -X POST -H "Authorization: Bearer $TOKEN" "$ORIGIN/api/admin/config/reload" | jq

# Check metrics
curl -s "$ORIGIN/metrics/prom" | grep -E "config_reload_total|config_sampling_rate"
```

## Telemetry Configuration

Environment variables (subset):
- `OTEL_ENABLED`: `true|false`
- `OTEL_SAMPLING`: float in [0,1]
- `OTEL_EXPORTER`: `otlp|jaeger|none` (reserved for SDK integration)
- `OTEL_ENDPOINT`: exporter endpoint (optional)
- `OTEL_SERVICE_NAME`: service name (optional)

On config reload:
- `config_reload_total{result="ok|error"}` increments
- `config_sampling_rate` reflects `OTEL_SAMPLING` (or 0 if unset)

## Plugins (Verbose)

- GET `/api/plugins?verbose=1` returns
```json
{
  "plugins": [ ... ],
  "engine": {
    "version": "v2-core",
    "config": { /* sanitized */ }
  }
}
```


## 相关
- 视图数据与 RBAC: docs/VIEW_DATA_API.md
- Prometheus 指标: GET /metrics/prom

### RBAC Cache Tuning

ConfigService exposes RBAC cache controls:
- `rbac.cacheEnabled`: enable/disable in-memory permission cache (default true)
- `rbac.cacheTtlMs`: TTL for cache entries in milliseconds (default 60000)

Environment usage:
```
export RBAC_CACHE_ENABLED=false
export RBAC_CACHE_TTL_MS=30000
```

## Local Auth & Pre-merge

### Generate a dev JWT
- Script (preferred):
  ```bash
  pnpm -F @metasheet/core-backend gen:token -- --user dev-admin --roles admin > /tmp/token.json
  TOKEN=$(jq -r .token /tmp/token.json)
  ```
- If jq is unavailable (sed fallback):
  ```bash
  TOKEN=$(pnpm -F @metasheet/core-backend gen:token -- --user dev-admin --roles admin | sed -n 's/.*"token": "\([^"]*\)".*//p' | head -n 1)
  ```

### Verify admin endpoints
```bash
curl -i -H "Authorization: Bearer $TOKEN" http://localhost:8900/api/admin/config
```

### Pre-merge check (metrics gate)
```bash
API_ORIGIN=http://localhost:8900 pnpm -F @metasheet/core-backend pre-merge:check
```
- Ensures presence of: `config_reload_total`, `config_sampling_rate`, `view_data_latency_seconds`, `view_data_requests_total`.
- Note: admin auth failures are warnings in this check (metrics-only gate).
