# Attendance Import Perf Long Run Auth Fallback Development 2026-05-14

## Summary

The scheduled `Attendance Import Perf Long Run` workflow failed on `main` at
run `25845123113` before executing any perf scenario. Every matrix job stopped
in `Resolve valid auth token` because the configured `ATTENDANCE_ADMIN_JWT`
could not validate against `/api/auth/me`, and no login credentials were
available for fallback.

This change applies the same deploy-host token fallback used by the passing
`Attendance Locale zh Smoke (Prod)` workflow. If the configured token,
refresh-token, and login paths fail, the long-run workflow mints a short-lived
Attendance admin token from the running backend container through the deploy
host, masks it, validates it with `attendance-resolve-auth.sh`, and uses only
the validated token for the scenario.

## Changes

- Added `DEPLOY_HOST`, `DEPLOY_USER`, `DEPLOY_SSH_KEY_B64`, `DEPLOY_PATH`, and
  `DEPLOY_COMPOSE_FILE` to the long-run scenario job environment.
- Added deploy-host fallback execution through
  `scripts/ops/resolve-attendance-smoke-token.sh`.
- Kept the original auth order intact:
  `ATTENDANCE_ADMIN_JWT` -> refresh-token -> login -> deploy-host mint.
- Wrote fallback diagnostics to each scenario artifact under
  `deploy-host-auth-fallback.log`.
- Kept token values masked and out of logs, docs, artifacts, and Git.
- Hardened trend summary rendering so the workflow no longer runs `cat ""`
  when trend generation fails before producing a markdown path.
- Added a workflow contract test for the long-run auth fallback and trend
  summary guard.

## Scope

In scope:

- `.github/workflows/attendance-import-perf-longrun.yml`
- `scripts/ops/attendance-import-perf-longrun-workflow-contract.test.mjs`
- this development note and the companion verification note

Out of scope:

- Attendance runtime APIs
- Database migrations
- Perf scenario thresholds
- DingTalk runtime behavior
- The existing dirty root worktree changes for Attendance report fields/export
  and DingTalk directory UI

## Rollback

Revert this commit to return the long-run workflow to configured-token-only
resolution. If reverted, scheduled long-run runs will remain dependent on a
fresh `ATTENDANCE_ADMIN_JWT` or configured login credentials.
