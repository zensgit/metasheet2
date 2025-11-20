# Sprint 2 Staging Screenshots

Collect these after running `/tmp/execute-staging-validation.sh` on Staging.

## Required Captures
1. `latency-dashboard.png` – Grafana dashboard showing P50/P95/P99 latency panel for snapshot + rule endpoints (time range: full validation window).
2. `prom-metrics-panel.png` – Prometheus expression browser (or dashboard) listing the 6 core metrics with non‑zero values:
   - `protection_rule_evaluations_total`
   - `protection_rule_blocks_total`
   - `jwt_auth_fail_total`
   - `rate_limit_denials_total` (if present)
   - `snapshot_create_duration_seconds` (if present)
   - `http_request_duration_seconds_*` summary/histogram (if available)
3. `rule-eval-counters.png` – Grafana/Prometheus view showing counts for rule matches vs non‑matches during validation.

## Optional Captures
- `perf-baseline-trend.png` – Trend graph of snapshot stats endpoint latency.
- `db-connections.png` – Database pool dashboard showing stable connection usage.

## Collection Checklist
| Item | Status |
|------|--------|
| Grafana latency dashboard captured |  ☐ |
| Prometheus metrics panel captured   |  ☐ |
| Rule evaluation counters captured   |  ☐ |
| Optional perf trend captured        |  ☐ |
| Optional DB pool captured           |  ☐ |

## Instructions
1. Set time range to cover entire validation run (start → finish).
2. Hide sensitive tokens or IDs if any; redaction acceptable.
3. Save PNG files directly into this directory using the exact filenames above.
4. Run `git add docs/sprint2/screenshots/*.png` and commit with message: `docs(sprint2): add staging screenshots`.
5. Regenerate PR body: `pnpm run staging:pr-body` to include updated evidence list.

## Notes
- If latency panels are split by endpoint, zoom on `snapshot create`, `snapshot stats`, and `rule evaluate` paths.
- Ensure rule evaluation counters show at least one matched and one not matched scenario.
- If a metric is missing (e.g., histogram), note rationale in `staging-validation-report.md`.

