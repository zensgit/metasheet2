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

## Final Re-Validation (2026-02-11, post-closure)

| Gate | Run | Status | Evidence |
|---|---|---|---|
| Perf baseline (10k, tightened thresholds) | [#21912709345](https://github.com/zensgit/metasheet2/actions/runs/21912709345) | PASS | `output/playwright/ga/21912709345/attendance-import-perf-21912709345-1/attendance-perf-mli82mht-ximhdx/perf-summary.json` |
| Strict gates twice (async strict) | [#21912806317](https://github.com/zensgit/metasheet2/actions/runs/21912806317) | PASS | `output/playwright/ga/21912806317/attendance-strict-gates-prod-21912806317-1/20260211-160958-1/`, `output/playwright/ga/21912806317/attendance-strict-gates-prod-21912806317-1/20260211-160958-2/` |
| Daily dashboard | [#21912958814](https://github.com/zensgit/metasheet2/actions/runs/21912958814) | PASS | `output/playwright/ga/21912958814/attendance-daily-gate-dashboard-21912958814-1/attendance-daily-gate-dashboard.md` |

Perf summary (`#21912709345`):

- `rows=10000`
- `previewMs=3013`
- `commitMs=60742`
- `exportMs=406`
- `rollbackMs=129`
- `regressions=[]`

Thresholds in effect:

- `ATTENDANCE_PERF_MAX_PREVIEW_MS=100000`
- `ATTENDANCE_PERF_MAX_COMMIT_MS=150000`
- `ATTENDANCE_PERF_MAX_EXPORT_MS=25000`
- `ATTENDANCE_PERF_MAX_ROLLBACK_MS=8000`

Remediation included in this re-validation:

- PR [#144](https://github.com/zensgit/metasheet2/pull/144): tolerate transient `429/5xx` on async import job polling to avoid false perf gate failures from brief upstream `502`.

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

- Strict gates and perf threshold gates are both passing on `main` after migration-enabled deploy and transient async poll hardening.

## Continuous Monitoring (Post-Go)

- Daily dashboard workflow:
  - `.github/workflows/attendance-daily-gate-dashboard.yml`
- Dashboard generator:
  - `scripts/ops/attendance-daily-gate-report.mjs`
- Escalation behavior:
  - `P0` strict gate failure -> open/update issue `[Attendance Gate] Daily dashboard alert` and fail workflow.
  - `P1` perf gate failure/stale runs -> open/update same issue and fail workflow.
- Channel sync workflow:
  - `.github/workflows/attendance-gate-issue-notify.yml`
  - Routes `[Attendance Gate]` issue events to Slack/DingTalk webhooks when configured.
- Workflow validation:
  - [Attendance Daily Gate Dashboard #21900762111](https://github.com/zensgit/metasheet2/actions/runs/21900762111) (`SUCCESS`)
  - Evidence:
    - `output/playwright/ga/21900762111/attendance-daily-gate-dashboard.md`
    - `output/playwright/ga/21900762111/attendance-daily-gate-dashboard.json`
- Latest recovery validation:
  - [Attendance Daily Gate Dashboard #21912958814](https://github.com/zensgit/metasheet2/actions/runs/21912958814) (`SUCCESS`)
  - Evidence:
    - `output/playwright/ga/21912958814/attendance-daily-gate-dashboard-21912958814-1/attendance-daily-gate-dashboard.md`
    - `output/playwright/ga/21912958814/attendance-daily-gate-dashboard-21912958814-1/attendance-daily-gate-dashboard.json`
- Failure drill validation:
  - [Attendance Daily Gate Dashboard #21912261134](https://github.com/zensgit/metasheet2/actions/runs/21912261134) (`FAILURE`, expected)
  - Escalation issue created:
    - [#141](https://github.com/zensgit/metasheet2/issues/141)
  - Evidence:
    - `output/playwright/ga/21912261134/attendance-daily-gate-dashboard.md`
- Issue channel sync validation:
  - [Attendance Gate Issue Notify #21912549709](https://github.com/zensgit/metasheet2/actions/runs/21912549709) (`SUCCESS`)
  - Behavior:
    - sends notifications when Slack/DingTalk webhook secrets are configured;
    - with no webhook configured, exits success with warning summary.

## Post-Go Validation (2026-02-12): Extreme-Scale Import + CSV Upload Channel

This record does not change the `GO` decision above; it captures a production re-validation after shipping the CSV upload import channel and running an extreme-scale perf baseline.

| Gate | Run | Status | Evidence |
|---|---|---|---|
| Build + deploy (csv upload channel) | [#21948146767](https://github.com/zensgit/metasheet2/actions/runs/21948146767) | PASS | GitHub Actions run logs |
| Strict gates twice (async strict) | [#21948274924](https://github.com/zensgit/metasheet2/actions/runs/21948274924) | PASS | `output/playwright/ga/21948274924/attendance-strict-gates-prod-21948274924-1/20260212-132140-1/`, `output/playwright/ga/21948274924/attendance-strict-gates-prod-21948274924-1/20260212-132140-2/` |
| Strict gates twice (post rate-limit mapping) | [#21949081591](https://github.com/zensgit/metasheet2/actions/runs/21949081591) | PASS | `output/playwright/ga/21949081591/20260212-134540-1/`, `output/playwright/ga/21949081591/20260212-134540-2/` |
| Perf baseline (500k, async+export+rollback, upload_csv=true) | [#21948416024](https://github.com/zensgit/metasheet2/actions/runs/21948416024) | PASS | `output/playwright/ga/21948416024/attendance-perf-mljhqv6r-wx77vt/perf-summary.json` |
| Build + deploy (persist upload volume + nginx override) | [#21950252123](https://github.com/zensgit/metasheet2/actions/runs/21950252123) | PASS | GitHub Actions run logs |
| Strict gates twice (post nginx/volume sync) | [#21950374010](https://github.com/zensgit/metasheet2/actions/runs/21950374010) | PASS | `output/playwright/ga/21950374010/attendance-strict-gates-prod-21950374010-1/20260212-142241-1/`, `output/playwright/ga/21950374010/attendance-strict-gates-prod-21950374010-1/20260212-142241-2/` |
| Perf baseline (10k, async+export+rollback, upload_csv=true) | [#21950373978](https://github.com/zensgit/metasheet2/actions/runs/21950373978) | PASS | `output/playwright/ga/21950373978/attendance-import-perf-21950373978-1/attendance-perf-mljjrtew-l8qyjh/perf-summary.json` |
| Build + deploy (upload observability metrics) | [#21951397169](https://github.com/zensgit/metasheet2/actions/runs/21951397169) | PASS | GitHub Actions run logs |
| Strict gates twice (post upload observability) | [#21951515179](https://github.com/zensgit/metasheet2/actions/runs/21951515179) | PASS | `output/playwright/ga/21951515179/attendance-strict-gates-prod-21951515179-1/20260212-145254-1/`, `output/playwright/ga/21951515179/attendance-strict-gates-prod-21951515179-1/20260212-145254-2/` |
| Perf baseline (10k, async+export+rollback, upload_csv=true, post upload observability) | [#21951515791](https://github.com/zensgit/metasheet2/actions/runs/21951515791) | PASS | `output/playwright/ga/21951515791/attendance-import-perf-21951515791-1/attendance-perf-mljkutd4-b9wc2g/perf-summary.json` |
| Strict gates twice (require_import_upload=true) | [#21954800143](https://github.com/zensgit/metasheet2/actions/runs/21954800143) | PASS | `output/playwright/ga/21954800143/attendance-strict-gates-prod-21954800143-1/20260212-162123-1/`, `output/playwright/ga/21954800143/attendance-strict-gates-prod-21954800143-1/20260212-162123-2/` |
| Perf baseline (10k, async+export+rollback, upload_csv=true default) | [#21954799983](https://github.com/zensgit/metasheet2/actions/runs/21954799983) | PASS | `output/playwright/ga/21954799983/attendance-import-perf-21954799983-1/attendance-perf-mljo09wu-x27iq5/perf-summary.json` |

Perf summary (`#21948416024`):

- `rows=500000`
- `previewMs=16290`
- `commitMs=463804`
- `exportMs=14491`
- `rollbackMs=6566`
- `regressions=[]`

Related design/ops record:

- `docs/attendance-production-import-upload-channel-20260212.md`
