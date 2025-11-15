# MetaSheet v2 — Release Notes (2025-09-22)

## Overview
This release hardens CI observability gates, significantly improves RBAC cache hit rate, and tightens latency thresholds while keeping clear visibility via PR comments, artifacts, and Pages.

## Key Changes
- RBAC cache optimization: hit rate 47.1% → 87.5% (user_only fallback with diversified warmup)
- Strict latency gate: P99 threshold tightened to 0.1s (repo variable `P99_THRESHOLD`)
- Observability comment: trend arrows, soft RBAC gate (≥60%), permMode surfaced
- Weekly trend: reports archived to `gh-pages-data` and linked from Pages (site copies fetched during publish)
- OpenAPI: responses normalized (401/403/404/400), descriptions added; lint noise reduced

## Benefits
- Lower tail latency with strict, parameterized gate
- Predictable authorization performance (high and stable cache hit rate)
- Faster review loops with richer PR comments and historical links

## Compatibility / Risk
- No breaking API changes introduced by CI/docs changes
- Permission endpoints for resource-level checks are not yet implemented; current mode is `user_only` by design
- Weekly Trend card added to Pages; requires a successful publish after weekly summary generation

## Verification Summary
- Strict workflow: stable passes on consecutive runs (P99=0.0012s < 0.1s)
- RBAC stability: 87.5% hit rate across 4–6 consecutive runs
- Pages publish: openapi.yaml available; trend report fetched into site

## Operations
- Variables
  - `P99_THRESHOLD=0.1`
  - `RBAC_SOFT_THRESHOLD=60`
  - `ENFORCE_422=false` (flip to true after backend enforces 422)
- Manual triggers after merge to main
  - Weekly Trend Summary
  - Publish OpenAPI (V2)
  - Observability (V2 Strict) on PRs for comment updates

## Rollout & Monitoring
- Monitor for 24–48h: P99, RBAC hit rate, 5xx
- Consider testing P99=0.05s on a branch if stability persists; keep main at 0.1s meantime
- Rollback lever: raise `P99_THRESHOLD` (e.g., to 0.2s/0.25s) if needed

## Known Limitations / Follow‑ups
- Weekly Trend card may require a fresh publish and cache refresh to appear
- Implement resource-level permission endpoints (`/api/spreadsheets/:id/permissions` or `/api/permissions/check`) to move off user_only mode

## Links
- Pages: https://zensgit.github.io/smartsheet/
- API spec: https://zensgit.github.io/smartsheet/api-docs/openapi.yaml
- PRs: #68 (CI/trend), #69 (RBAC TTL + docs), #70 (RBAC cache fix), #71 (threshold display validation)

---
Release owner: MetaSheet v2 Team
