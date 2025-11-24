# Rollback Guide — Sprint 2

Use when staging/prod validation fails or regressions detected.

## Triggers
- Any MUST PASS check fails (9 endpoints, rule effects, latency gates, error rate).
- Metrics regress (P95>150ms or P99>250ms).
- Elevated error rate or DB migration incompatibility.

## Steps
1. Freeze deploy: label PR as `blocked:rollback`.
2. Revert code: `git revert <merge_commit_sha>` or close PR.
3. DB: run rollback if needed: `pnpm --filter @metasheet/core-backend db:rollback`.
4. Verify health: `/health`, `/metrics/prom`, critical API smoke.
5. Communicate status in PR/Issue; attach evidence.

## Verification Checklist
- [ ] /health 200 and ok
- [ ] 9 endpoints return 200
- [ ] Rule evaluation ok or feature toggled off
- [ ] Error rate <1%, latency within targets
- [ ] Metrics dashboards back to baseline

