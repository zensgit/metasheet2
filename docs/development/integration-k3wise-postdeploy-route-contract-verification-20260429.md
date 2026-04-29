# K3 WISE Postdeploy Route Contract Guard Verification - 2026-04-29

## Local Verification

Worktree:

`/tmp/ms2-k3wise-route-contract-20260429`

Branch:

`codex/k3wise-route-contract-20260429`

Commands run:

```bash
node --test scripts/ops/integration-k3wise-postdeploy-smoke.test.mjs
node --test scripts/ops/integration-k3wise-postdeploy-summary.test.mjs
node --test scripts/ops/integration-k3wise-postdeploy-workflow-contract.test.mjs
git diff --check
```

Results:

- `integration-k3wise-postdeploy-smoke.test.mjs`: 10/10 passed.
- `integration-k3wise-postdeploy-summary.test.mjs`: 5/5 passed.
- `integration-k3wise-postdeploy-workflow-contract.test.mjs`: 2/2 passed.
- `git diff --check`: passed.

## Regression Coverage

Added coverage:

- successful authenticated smoke now verifies `routesChecked` equals 15.
- fake server route inventory is centralized in `DEFAULT_ROUTES`.
- missing `POST /api/integration/dead-letters/:id/replay` produces a failing
  `integration-route-contract` check and records the missing route in sanitized
  evidence details.

Existing coverage preserved:

- public smoke still skips authenticated integration checks when no token is
  provided.
- protected integration routes still skip plugin health rather than failing the
  public-only path.
- tenant-scoped read-only list probes still run for external systems, pipelines,
  runs, and dead letters.
- staging descriptor contract still requires all five K3 WISE staging tables.

## Mainline Status Checked Before This Work

The previous PR `#1249` merged at
`f4acf8bf8bff28610691368f123d4259a6ed8395`. Post-merge push workflows on that
commit were checked before opening this route-contract lane:

- `Phase 5 Production Flags Guard`: success.
- `Deploy to Production`: success.
- `Build and Push Docker Images`: success.
- `Plugin System Tests`: success.
- `.github/workflows/monitoring-alert.yml`: success.

## Remaining External Configuration

This route-contract change is independent of the scheduled DingTalk stability
webhook issue found during the same maintenance window. The scheduled stability
workflow still requires one supported GitHub Actions secret to be configured for
Alertmanager self-heal:

- `ALERTMANAGER_WEBHOOK_URL`
- `ALERT_WEBHOOK_URL`
- `SLACK_WEBHOOK_URL`
- `ATTENDANCE_ALERT_SLACK_WEBHOOK_URL`
