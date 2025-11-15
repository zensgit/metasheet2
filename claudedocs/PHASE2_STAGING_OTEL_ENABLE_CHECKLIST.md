# Phase 2 — Staging OTEL Enablement Checklist

Date: 2025-11-04
Owner: Platform/Infra
Status: Ready to execute (safe-by-default)

## Objective
Enable the telemetry plugin in staging with FEATURE_OTEL=true, scrape Prometheus via /metrics/otel, observe stability for 3–5 days, and be ready to roll back instantly.

## Preconditions
- main includes OTEL plugin and local scripts (merged)
- Branch protections restored (required checks enabled)
- Staging deploy pipeline healthy

## Configuration (staging)
- Environment variables
  - FEATURE_OTEL=true
  - PORT=8900 (or environment default)
  - OTEL_SERVICE_NAME=metasheet-staging (optional for logs)
- Prometheus scrape (recommended)
  ```yaml
  scrape_configs:
    - job_name: metasheet-staging
      static_configs:
        - targets: ['<staging-host>:8900']
      metrics_path: /metrics/otel
  ```

## Rollout Steps
1) Enable feature flag
   - Set FEATURE_OTEL=true in staging deployment (env or secret)
   - Deploy/rollout the service

2) Validate health and endpoints
   - curl -fsS http://<host>:8900/health | jq .
   - curl -fsS http://<host>:8900/metrics | head -n 5  # JSON/alt format (compat)
   - curl -fsS http://<host>:8900/metrics/otel | head -n 5  # Prometheus text

3) Confirm Prometheus collection
   - promtool check rules (if applicable)
   - Check target up and sample count increasing

4) Grafana quick checks
   - Panel: http_* metrics present and updating
   - Optional: plugin-specific counters visible

## Canary + Observation
- Window: 3–5 days
- Watch: scrape errors, 5xx spikes, process memory, event loop lag
- Alert thresholds (suggested)
  - scrape_failure > 0 for 5m
  - http_request_errors_total > baseline + 2σ for 15m

## Rollback Plan (instant)
- Set FEATURE_OTEL=false
- Redeploy service
- Prometheus can keep /metrics/otel job; endpoint will 404 (OK) until re-enabled

## Success Criteria
- No increase in 5xx or error logs
- Prometheus successfully scraping /metrics/otel with stable sample rates
- No endpoint conflict reports from consumers

## Notes
- /metrics remains for compatibility; /metrics/otel is the recommended primary scrape path
- Tracking issue created to make /metrics/otel primary and deprecate /metrics

