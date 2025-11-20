# PR: Sprint 2 — Snapshot Protection System (Staging Validation)

## Overview
- Introduces Snapshot Protection: labels, protection levels, release channels
- Adds Protection Rules admin APIs with dry-run evaluation

## Validation Summary
- Local: PASSED — see docs/sprint2/local-validation-report.md
- Staging: In Progress — see docs/sprint2/staging-validation-report.md
  - Automation active: watcher monitoring Issue #5 and awaiting BASE_URL + JWT
  - Once provided, validation runs automatically; evidence will be added under docs/sprint2/
  - Watcher log: /tmp/staging-watcher.log (PID recorded in /tmp/staging-watcher.pid)
  - Ops runbook: docs/sprint2/ops-runbook.md | Rollback: docs/sprint2/rollback.md

### Performance Summary
- Samples: 60  |  Errors: 0
- P50: 38 ms  |  P95: 43 ms  |  P99: 51 ms  |  Max: 58 ms
- Artifact:       docs/sprint2/performance/perf-20251120_132024.csv.summary.json

## Evidence (latest)
- docs/sprint2/evidence/validation-summary-20251120_101114.json
- docs/sprint2/evidence/rule-delete-20251120_101114.json
- docs/sprint2/evidence/rate-limit-20251120_101114.txt
- docs/sprint2/evidence/rule-create-duplicate-20251120_101114.json
- docs/sprint2/evidence/rule-eval-20251120_101114.json
- docs/sprint2/evidence/rule-create-20251120_101114.json
- docs/sprint2/evidence/snapshot-query-tag-20251120_101114.json
- docs/sprint2/evidence/snapshot-channel-20251120_101114.json
- docs/sprint2/evidence/snapshot-protection-20251120_101114.json
- docs/sprint2/evidence/snapshot-tags-20251120_101114.json

## Risks & Mitigations
- Rule precedence and effect conflicts — precedence documented
- Idempotency & rate limiting — validated in staging scripts
- Audit trail linkage — rule_execution_log checked

## Follow-ups
- Fill staging report with final results and attach screenshots
 - Fallback: ready (unused). See docs/sprint2/fallback-README.md and scripts/fallback/*. To be triggered only if staging token is delayed beyond escalation thresholds.

## Fallback Readiness
- Status: Ready (not executed)
- Purpose: Partial Staging validation if official token/URL are delayed
- Entry points: scripts/fallback/prepare.sh, seed.sh, validate.sh, collect.sh, teardown.sh
- Scope: Functional + perf sampling; does not replace real Staging validation
