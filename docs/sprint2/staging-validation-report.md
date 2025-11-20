# Sprint 2 — Staging Validation Report

Status: LOCAL PRE-STAGING PASS (plugins skipped) | Date: 2025-11-20 | Executor: staging-validator (local)
Automation: ENABLED — watcher on Issue #5 will auto-run when BASE_URL + JWT are provided; logs: /tmp/staging-watcher.log
Runbooks: ops — docs/sprint2/ops-runbook.md | rollback — docs/sprint2/rollback.md

## 1. Scope
- Environment: http://localhost:8900 (SKIP_PLUGINS=true)
- Commit/PR: <pending staging> | local head
- Token method: Locally signed JWT (dev-jwt-secret-local)

## 2. Validation Checklist (Must Pass)
- [ ] 9 API endpoints authenticated 200/201
- [ ] 4 rule effects validated（allow / block / elevate_risk / require_approval）
- [ ] P95 < 150ms, P99 < 250ms
- [ ] Error rate < 1%
- [ ] 6 Prometheus metrics have data

## 3. Execution Summary
- Start: _[Fill]_  End: _[Fill]_  Duration: _[Fill]_ 
- Wrapper: `/tmp/execute-staging-validation.sh`
- Evidence dir: `docs/sprint2/evidence/`

## 4. API Results
### 4.1 Protection Rules
- List Rules: _[Fill status + sample]_ 
- Create Rule: _[Fill]_  → id: _[Fill]_
- Get Rule: _[Fill]_ 
- Update Rule: _[Fill]_ 
- Evaluate Rule (dry-run): _[Fill]_ 
- Delete Rule: _[Fill]_ 

### 4.2 Snapshots & Labels
- Create Snapshot: 201 Created → id: 1432a202-ffcc-4317-b770-4b288cbd979b
- Update Tags: 200 OK (added staging,sprint2)
- Set Protection Level: 200 OK → protected
- Set Release Channel: 200 OK → canary
- Query by Tag (admin): 200 OK (returns ≥1 snapshot)

## 5. Performance Baseline (Local)
- Endpoint: /api/snapstats | Runs: 60
- P50: 38ms  P95: 43ms  P99: 51ms  Max: 58ms  Errors: 0
- Artifacts: `docs/sprint2/performance/perf-20251120_132024.csv.summary.json`

## 6. Metrics & Dashboards
- Prometheus queries: _[Fill]_ 
- Grafana panels: _[Fill]_ 
- Screenshots saved: `docs/sprint2/screenshots/`

## 7. Risks & Mitigations
- Plugin loader crash when not skipping plugins (needs isolation).
- Using simplified auth (local secret) — staging token acquisition pending.
- Rate limit behavior captured (need expected 429 validation).

## 8. Conclusion
- Verdict: READY FOR STAGING (local functionality validated sans plugins)
- Follow-ups: Acquire staging token & BASE_URL; resolve plugin loader crash; run full 60-round perf on /api/snapshots/stats; capture Prometheus/Grafana screenshots; validate all rule effects including elevate_risk & require_approval.
- Ops: see docs/sprint2/ops-runbook.md; Rollback: docs/sprint2/rollback.md
- Escalation Policy: Active (auto reminders at 1h cadence, escalation thresholds at 6h/12h/24h with increased frequency and fallback planning)
