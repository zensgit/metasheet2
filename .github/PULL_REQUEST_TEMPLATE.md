# Pull Request

English template. 中文模板请见 `.github/PULL_REQUEST_TEMPLATE.zh-CN.md`。
Guides: `AGENTS.md` (includes Local Dev & Troubleshooting).

## Purpose
- What does this change do? Why now?

## Changes
- Summary of key changes (code, routes, contracts)

## Validation
- Commands run (build/tests):
  - `pnpm install --frozen-lockfile`
  - `pnpm -F @metasheet/core-backend test`
  - `NODE_ENV=test pnpm -F @metasheet/core-backend test:integration`
- Contract check (if applicable): `curl -s http://localhost:8900/api/plugins | jq`

## Risks & Rollback
- Potential impact and how to revert

## Checklist
- [ ] One concern per PR; minimal unrelated changes
- [ ] Lockfile committed and CI green
- [ ] Followed coding style (ESM, TS, 2-space indent)
- [ ] Docs updated if needed
- [ ] Local troubleshooting consulted when needed
  - See `AGENTS.md` → "Local Dev & Troubleshooting"
  - One‑shot fix: `bash scripts/fix-local-core-backend.sh`
- [ ] **If monitoring/alerting config changed**: Confirmed routing and thresholds are correct
  - Applies to: `weekly_metrics.yaml`, `scripts/collect-security-metrics.sh`, Prometheus/Grafana configs
  - Verify: Alert routes point to correct channels, thresholds match SLA requirements
  - See: `.github/CODEOWNERS` for dual approval requirement
