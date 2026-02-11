# Attendance Production Go/No-Go (2026-02-11)

## Scope

This record closes the production readiness loop for Attendance after enabling:

- Async import strict gate by default
- Perf threshold gate
- Deploy-time DB migration execution

## Final Gate Result

| Gate | Run | Status | Evidence |
|---|---|---|---|
| Strict gates twice (async strict) | [#21894374032](https://github.com/zensgit/metasheet2/actions/runs/21894374032) | PASS | `output/playwright/ga/21894374032/20260211-055556-1/`, `output/playwright/ga/21894374032/20260211-055556-2/` |
| Perf baseline (10k, async+export+rollback, thresholds enabled) | [#21894377908](https://github.com/zensgit/metasheet2/actions/runs/21894377908) | PASS | `output/playwright/ga/21894377908/attendance-perf-mlhm8esx-abitlr/perf-summary.json` |
| Build + deploy (with migration step) | [#21894316469](https://github.com/zensgit/metasheet2/actions/runs/21894316469) | PASS | GitHub Actions run logs |

Perf summary (`#21894377908`):

- `rows=10000`
- `previewMs=2919`
- `commitMs=66985`
- `exportMs=390`
- `rollbackMs=114`
- `regressions=[]`

## Incident and Fix Trace

Initial failures before closure:

- [#21894139054](https://github.com/zensgit/metasheet2/actions/runs/21894139054): strict gate failed (`/attendance-admin/audit-logs/export.csv` missing).
- [#21894142162](https://github.com/zensgit/metasheet2/actions/runs/21894142162): perf gate failed (`/attendance/import/commit-async` missing).
- [#21894255303](https://github.com/zensgit/metasheet2/actions/runs/21894255303): strict gate failed (`occurred_at` column missing).
- [#21894258310](https://github.com/zensgit/metasheet2/actions/runs/21894258310): perf gate failed (`DB_NOT_READY`).

Root cause:

- Deploy workflow recreated containers but did not run DB migrations.

Remediation shipped:

- PR [#137](https://github.com/zensgit/metasheet2/pull/137)
- Commit: `24b97562`
- Change: `.github/workflows/docker-build.yml` deploy step now executes:
  - `docker compose ... exec -T backend node packages/core-backend/dist/src/db/migrate.js`

## Decision

- **GO** (production continuation approved)

Rationale:

- Strict gates and perf threshold gates are both passing on `main` after migration-enabled deploy.
