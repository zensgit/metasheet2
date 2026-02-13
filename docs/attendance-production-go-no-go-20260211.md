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
| Strict gates twice (post prod preflight fix) | [#21956369650](https://github.com/zensgit/metasheet2/actions/runs/21956369650) | PASS | `output/playwright/ga/21956369650/attendance-strict-gates-prod-21956369650-1/20260212-170455-1/`, `output/playwright/ga/21956369650/attendance-strict-gates-prod-21956369650-1/20260212-170455-2/` |
| Deploy (with remote preflight) | [#21956719862](https://github.com/zensgit/metasheet2/actions/runs/21956719862) | PASS | GitHub Actions run logs |
| Strict gates twice (post deploy remote preflight) | [#21956821613](https://github.com/zensgit/metasheet2/actions/runs/21956821613) | PASS | `output/playwright/ga/21956821613/attendance-strict-gates-prod-21956821613-1/20260212-171848-1/`, `output/playwright/ga/21956821613/attendance-strict-gates-prod-21956821613-1/20260212-171848-2/` |
| Perf baseline (10k, upload_csv=true default, post deploy remote preflight) | [#21956821796](https://github.com/zensgit/metasheet2/actions/runs/21956821796) | PASS | `output/playwright/ga/21956821796/attendance-import-perf-21956821796-1/attendance-perf-mljq1ur9-cg0wyh/perf-summary.json` |
| Deploy (preflight step summary + deploy.log artifact) | [#21958027752](https://github.com/zensgit/metasheet2/actions/runs/21958027752) | PASS | `output/playwright/ga/21958027752/deploy.log` |
| Deploy (workflow_dispatch re-verify preflight summary + artifacts) | [#21972069433](https://github.com/zensgit/metasheet2/actions/runs/21972069433) | PASS | `output/playwright/ga/21972069433/deploy.log` |
| Deploy (failure drill: require-token misconfig, expected FAIL) | [#21973689456](https://github.com/zensgit/metasheet2/actions/runs/21973689456) | FAIL (expected) | `output/playwright/ga/21973689456/deploy.log` |
| Deploy (post-drill restore, expected PASS) | [#21973784431](https://github.com/zensgit/metasheet2/actions/runs/21973784431) | PASS | `output/playwright/ga/21973784431/deploy.log` |
| Deploy (step summary: artifact download + mismatch hint) | [#21973932069](https://github.com/zensgit/metasheet2/actions/runs/21973932069) | PASS | `output/playwright/ga/21973932069/deploy.log` |
| Deploy (step summary: remote stages migrate/smoke) | [#21974371801](https://github.com/zensgit/metasheet2/actions/runs/21974371801) | PASS | `output/playwright/ga/21974371801/deploy.log` |
| Deploy (drill: intentional migrate failure, expected FAIL) | [#21974887993](https://github.com/zensgit/metasheet2/actions/runs/21974887993) | FAIL (expected) | `output/playwright/ga/21974887993/deploy.log` |
| Deploy (drill: intentional smoke failure, expected FAIL) | [#21975944250](https://github.com/zensgit/metasheet2/actions/runs/21975944250) | FAIL (expected) | `output/playwright/ga/21975944250/deploy.log` |
| Deploy (step summary archived to artifact) | [#21976281725](https://github.com/zensgit/metasheet2/actions/runs/21976281725) | PASS | `output/playwright/ga/21976281725/step-summary.md`, `output/playwright/ga/21976281725/deploy.log` |
| Deploy (drill stage recorded + step summary artifact) | [#21976355633](https://github.com/zensgit/metasheet2/actions/runs/21976355633) | FAIL (expected) | `output/playwright/ga/21976355633/step-summary.md`, `output/playwright/ga/21976355633/deploy.log` |
| Deploy (deploy drill + deploy output tail) | [#21976588135](https://github.com/zensgit/metasheet2/actions/runs/21976588135) | FAIL (expected) | `output/playwright/ga/21976588135/step-summary.md`, `output/playwright/ga/21976588135/deploy.log` |
| Deploy (step summary: exit code meaning + stage reasons) | [#21976718210](https://github.com/zensgit/metasheet2/actions/runs/21976718210) | PASS | `output/playwright/ga/21976718210/step-summary.md`, `output/playwright/ga/21976718210/deploy.log` |
| Deploy (drill: deploy stage exit code meaning + stage reasons) | [#21976791431](https://github.com/zensgit/metasheet2/actions/runs/21976791431) | FAIL (expected) | `output/playwright/ga/21976791431/step-summary.md`, `output/playwright/ga/21976791431/deploy.log` |
| Deploy (failure drill: preflight END marker present, expected FAIL) | [#21974005618](https://github.com/zensgit/metasheet2/actions/runs/21974005618) | FAIL (expected) | `output/playwright/ga/21974005618/deploy.log` |
| Deploy (post-drill restore, expected PASS) | [#21974057204](https://github.com/zensgit/metasheet2/actions/runs/21974057204) | PASS | `output/playwright/ga/21974057204/deploy.log` |
| Deploy (workflow_dispatch re-verify: smoke PASS requires SMOKE END marker) | [#21977059789](https://github.com/zensgit/metasheet2/actions/runs/21977059789) | PASS | `output/playwright/ga/21977059789/step-summary.md`, `output/playwright/ga/21977059789/deploy.log` |
| Deploy (drill: smoke stage, expected FAIL; validates Smoke FAIL detection + artifacts) | [#21977247241](https://github.com/zensgit/metasheet2/actions/runs/21977247241) | FAIL (expected) | `output/playwright/ga/21977247241/step-summary.md`, `output/playwright/ga/21977247241/deploy.log` |
| Remote Preflight (Prod) | [#21984121413](https://github.com/zensgit/metasheet2/actions/runs/21984121413) | PASS | `output/playwright/ga/21984121413/step-summary.md`, `output/playwright/ga/21984121413/preflight.log` |
| Remote Preflight drill (expected FAIL) | [#21984026399](https://github.com/zensgit/metasheet2/actions/runs/21984026399) | FAIL (expected) | `output/playwright/ga/21984026399/step-summary.md`, `output/playwright/ga/21984026399/preflight.log` |
| Remote Preflight drill (tagged `[DRILL]`, expected FAIL) | [#21984401016](https://github.com/zensgit/metasheet2/actions/runs/21984401016) | FAIL (expected) | `output/playwright/ga/21984401016/step-summary.md`, `output/playwright/ga/21984401016/preflight.log` |
| Remote Preflight (step summary includes host sync output) | [#21984647956](https://github.com/zensgit/metasheet2/actions/runs/21984647956) | PASS | `output/playwright/ga/21984647956/step-summary.md`, `output/playwright/ga/21984647956/preflight.log` |
| Remote Preflight drill (host sync output included, expected FAIL) | [#21984677244](https://github.com/zensgit/metasheet2/actions/runs/21984677244) | FAIL (expected) | `output/playwright/ga/21984677244/step-summary.md`, `output/playwright/ga/21984677244/preflight.log` |
| Remote Preflight drill (issue escalation, safe title override) | [#21985036421](https://github.com/zensgit/metasheet2/actions/runs/21985036421) | FAIL (expected) | `output/playwright/ga/21985036421/step-summary.md`, `output/playwright/ga/21985036421/preflight.log`, Issue: [#151](https://github.com/zensgit/metasheet2/issues/151) |
| Remote Preflight (post issue escalation change, non-drill) | [#21985494906](https://github.com/zensgit/metasheet2/actions/runs/21985494906) | PASS | `output/playwright/ga/21985494906/step-summary.md`, `output/playwright/ga/21985494906/preflight.log` |
| Remote Preflight drill (preflight status robust to stdout/stderr ordering) | [#21985669802](https://github.com/zensgit/metasheet2/actions/runs/21985669802) | FAIL (expected) | `output/playwright/ga/21985669802/step-summary.md`, `output/playwright/ga/21985669802/preflight.log` |
| Daily Gate Dashboard (includes Remote Preflight gate) | [#21984145075](https://github.com/zensgit/metasheet2/actions/runs/21984145075) | PASS | `output/playwright/ga/21984145075/attendance-daily-gate-dashboard.md`, `output/playwright/ga/21984145075/attendance-daily-gate-dashboard.json` |
| Daily Gate Dashboard (drill-induced FAIL, expected) | [#21984060098](https://github.com/zensgit/metasheet2/actions/runs/21984060098) | FAIL (expected) | `output/playwright/ga/21984060098/attendance-daily-gate-dashboard.md`, `output/playwright/ga/21984060098/attendance-daily-gate-dashboard.json` |
| Daily Gate Dashboard (ignores preflight `[DRILL]` runs) | [#21984436363](https://github.com/zensgit/metasheet2/actions/runs/21984436363) | PASS | `output/playwright/ga/21984436363/attendance-daily-gate-dashboard.md`, `output/playwright/ga/21984436363/attendance-daily-gate-dashboard.json` |
| Daily Gate Dashboard (post host-sync summary update; still ignores drill) | [#21984702152](https://github.com/zensgit/metasheet2/actions/runs/21984702152) | PASS | `output/playwright/ga/21984702152/attendance-daily-gate-dashboard.md`, `output/playwright/ga/21984702152/attendance-daily-gate-dashboard.json` |
| Daily Gate Dashboard (post remote preflight refresh) | [#21985530489](https://github.com/zensgit/metasheet2/actions/runs/21985530489) | PASS | `output/playwright/ga/21985530489/attendance-daily-gate-dashboard.md`, `output/playwright/ga/21985530489/attendance-daily-gate-dashboard.json` |
| Strict gates drill (tagged `[DRILL]`, no-op, expected PASS) | [#21989332414](https://github.com/zensgit/metasheet2/actions/runs/21989332414) | PASS | `output/playwright/ga/21989332414/drill/drill.txt` |
| Perf baseline drill (tagged `[DRILL]`, no-op, expected PASS) | [#21989337598](https://github.com/zensgit/metasheet2/actions/runs/21989337598) | PASS | `output/playwright/ga/21989337598/drill/drill.txt` |
| Daily Gate Dashboard (ignores strict/perf `[DRILL]` runs) | [#21989379486](https://github.com/zensgit/metasheet2/actions/runs/21989379486) | PASS | `output/playwright/ga/21989379486/attendance-daily-gate-dashboard-21989379486-1/attendance-daily-gate-dashboard.md`, `output/playwright/ga/21989379486/attendance-daily-gate-dashboard-21989379486-1/attendance-daily-gate-dashboard.json` |
| Strict gates drill (issue escalation, tagged `[DRILL]`, expected FAIL) | [#21990301616](https://github.com/zensgit/metasheet2/actions/runs/21990301616) | FAIL (expected) | `output/playwright/ga/21990301616/drill/drill.txt`, Issue: [#153](https://github.com/zensgit/metasheet2/issues/153) |
| Daily Gate Dashboard (ignores strict drill failure, still PASS) | [#21990398576](https://github.com/zensgit/metasheet2/actions/runs/21990398576) | PASS | `output/playwright/ga/21990398576/attendance-daily-gate-dashboard-21990398576-1/attendance-daily-gate-dashboard.md`, `output/playwright/ga/21990398576/attendance-daily-gate-dashboard-21990398576-1/attendance-daily-gate-dashboard.json` |
| Daily Gate Dashboard drill (P0 escalation via branch override, expected FAIL) | [#21989604327](https://github.com/zensgit/metasheet2/actions/runs/21989604327) | FAIL (expected) | `output/playwright/ga/21989604327/attendance-daily-gate-dashboard-21989604327-1/attendance-daily-gate-dashboard.md`, `output/playwright/ga/21989604327/attendance-daily-gate-dashboard-21989604327-1/attendance-daily-gate-dashboard.json`, Issue: [#152](https://github.com/zensgit/metasheet2/issues/152) |
| Daily Gate Dashboard drill recovery (auto-close P0 issue, expected PASS) | [#21989640273](https://github.com/zensgit/metasheet2/actions/runs/21989640273) | PASS | `output/playwright/ga/21989640273/attendance-daily-gate-dashboard-21989640273-1/attendance-daily-gate-dashboard.md`, `output/playwright/ga/21989640273/attendance-daily-gate-dashboard-21989640273-1/attendance-daily-gate-dashboard.json`, Issue: [#152](https://github.com/zensgit/metasheet2/issues/152) |
| Remote Metrics (Prod) | [#21990031274](https://github.com/zensgit/metasheet2/actions/runs/21990031274) | PASS | `output/playwright/ga/21990031274/step-summary.md`, `output/playwright/ga/21990031274/metrics.log` |
| Daily Gate Dashboard (includes Host Metrics gate) | [#21990068558](https://github.com/zensgit/metasheet2/actions/runs/21990068558) | PASS | `output/playwright/ga/21990068558/attendance-daily-gate-dashboard-21990068558-1/attendance-daily-gate-dashboard.md`, `output/playwright/ga/21990068558/attendance-daily-gate-dashboard-21990068558-1/attendance-daily-gate-dashboard.json` |

Perf summary (`#21948416024`):

- `rows=500000`
- `previewMs=16290`
- `commitMs=463804`
- `exportMs=14491`
- `rollbackMs=6566`
- `regressions=[]`

Related design/ops record:

- `docs/attendance-production-import-upload-channel-20260212.md`
