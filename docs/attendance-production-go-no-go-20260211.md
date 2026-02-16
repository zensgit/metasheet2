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
  - `P0` failure (strict gates / remote preflight) -> open/update issue `[Attendance Gate] Daily dashboard alert` and fail workflow.
  - `P1` failures -> workflow still fails (visibility), but does not page via `[Attendance Gate]`.
  - `P1` perf baseline failures are tracked in issue: `[Attendance P1] Perf baseline alert` (no paging).
  - `P1` host metrics failures are tracked in issue: `[Attendance P1] Host metrics alert` (no paging).
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
| Remote Metrics drill (tagged `[DRILL]`, expected FAIL) | [#21990759459](https://github.com/zensgit/metasheet2/actions/runs/21990759459) | FAIL (expected) | `output/playwright/ga/21990759459/step-summary.md`, `output/playwright/ga/21990759459/metrics.log` |
| Daily Gate Dashboard (includes Host Metrics gate) | [#21990068558](https://github.com/zensgit/metasheet2/actions/runs/21990068558) | PASS | `output/playwright/ga/21990068558/attendance-daily-gate-dashboard-21990068558-1/attendance-daily-gate-dashboard.md`, `output/playwright/ga/21990068558/attendance-daily-gate-dashboard-21990068558-1/attendance-daily-gate-dashboard.json` |
| Daily Gate Dashboard (ignores metrics `[DRILL]` runs) | [#21990924895](https://github.com/zensgit/metasheet2/actions/runs/21990924895) | PASS | `output/playwright/ga/21990924895/attendance-daily-gate-dashboard-21990924895-1/attendance-daily-gate-dashboard.md`, `output/playwright/ga/21990924895/attendance-daily-gate-dashboard-21990924895-1/attendance-daily-gate-dashboard.json` |

Perf summary (`#21948416024`):

- `rows=500000`
- `previewMs=16290`
- `commitMs=463804`
- `exportMs=14491`
- `rollbackMs=6566`
- `regressions=[]`

Related design/ops record:

- `docs/attendance-production-import-upload-channel-20260212.md`

## Post-Go Validation (2026-02-13): P1 Issue Tracking (Perf + Host Metrics)

This record validates that P1 gates create a **non-paging** tracking issue on failure and auto-close it on recovery.

Notes:

- Drill runs use safe `issue_title` overrides so they do not conflict with the real production titles:
  - `[Attendance P1] Perf baseline alert`
  - `[Attendance P1] Host metrics alert`

| Gate | Run | Status | Evidence |
|---|---|---|---|
| Perf baseline drill (P1 issue open, expected FAIL) | [#21992375357](https://github.com/zensgit/metasheet2/actions/runs/21992375357) | FAIL (expected) | `output/playwright/ga/21992375357/drill/drill.txt`, Issue: [#154](https://github.com/zensgit/metasheet2/issues/154) |
| Perf baseline drill recovery (P1 issue auto-close) | [#21992449283](https://github.com/zensgit/metasheet2/actions/runs/21992449283) | PASS | `output/playwright/ga/21992449283/drill/drill.txt`, Issue: [#154](https://github.com/zensgit/metasheet2/issues/154) |
| Remote Metrics drill (P1 issue open, expected FAIL) | [#21992814049](https://github.com/zensgit/metasheet2/actions/runs/21992814049) | FAIL (expected) | `output/playwright/ga/21992814049/step-summary.md`, `output/playwright/ga/21992814049/metrics.log`, Issue: [#155](https://github.com/zensgit/metasheet2/issues/155) |
| Remote Metrics recovery (P1 issue auto-close) | [#21992862639](https://github.com/zensgit/metasheet2/actions/runs/21992862639) | PASS | `output/playwright/ga/21992862639/step-summary.md`, `output/playwright/ga/21992862639/metrics.log`, Issue: [#155](https://github.com/zensgit/metasheet2/issues/155) |

## Post-Go Validation (2026-02-13): Longrun Upload Coverage + P1 Issue Tracking

This record validates:

- The perf longrun workflow defaults to `upload_csv=true` and produces `uploadCsv: true` in perf summaries.
- Drill runs can validate FAIL/PASS issue behavior without hitting production APIs.

| Gate | Run | Status | Evidence |
|---|---|---|---|
| Perf longrun drill (P1 issue open, expected FAIL) | [#21995454486](https://github.com/zensgit/metasheet2/actions/runs/21995454486) | FAIL (expected) | `output/playwright/ga/21995454486/attendance-import-perf-longrun-drill-21995454486-1/drill.txt`, Issue: [#156](https://github.com/zensgit/metasheet2/issues/156) |
| Perf longrun drill recovery (P1 issue auto-close) | [#21995499250](https://github.com/zensgit/metasheet2/actions/runs/21995499250) | PASS | `output/playwright/ga/21995499250/attendance-import-perf-longrun-drill-21995499250-1/drill.txt`, Issue: [#156](https://github.com/zensgit/metasheet2/issues/156) |
| Perf longrun (upload_csv=true default) | [#21995544569](https://github.com/zensgit/metasheet2/actions/runs/21995544569) | PASS | `output/playwright/ga/21995544569/attendance-import-perf-longrun-trend-21995544569-1/20260213-170505/attendance-import-perf-longrun-trend.md`, `output/playwright/ga/21995544569/attendance-import-perf-longrun-rows10k-commit-21995544569-1/current/rows10k-commit/attendance-perf-mll50tvt-haeu4u/perf-summary.json` |
| Perf longrun (default P1 issue open on failure, expected FAIL) | [#21995762546](https://github.com/zensgit/metasheet2/actions/runs/21995762546) | FAIL (expected) | No artifacts (early failure); Issue: [#157](https://github.com/zensgit/metasheet2/issues/157) |
| Perf longrun recovery (default P1 issue auto-close) | [#21995802821](https://github.com/zensgit/metasheet2/actions/runs/21995802821) | PASS | `output/playwright/ga/21995802821/attendance-import-perf-longrun-trend-21995802821-1/20260213-171327/attendance-import-perf-longrun-trend.md`, Issue: [#157](https://github.com/zensgit/metasheet2/issues/157) |
| Daily Gate Dashboard (includes Perf Long Run gate) | [#21996392027](https://github.com/zensgit/metasheet2/actions/runs/21996392027) | PASS | `output/playwright/ga/21996392027/attendance-daily-gate-dashboard.md`, `output/playwright/ga/21996392027/attendance-daily-gate-dashboard.json` |

## Post-Go Validation (2026-02-13): Remote Storage Health Gate

This record validates:

- The production host upload storage (CSV upload channel volume) can be checked remotely and produces auditable artifacts.
- Drill FAIL/PASS issue behavior works with a safe override title (no paging).
- Daily Gate Dashboard includes `Storage Health` (P1) and stays `PASS`.

| Gate | Run | Status | Evidence |
|---|---|---|---|
| Remote Storage Health (Prod) | [#21998389402](https://github.com/zensgit/metasheet2/actions/runs/21998389402) | PASS | `output/playwright/ga/21998389402/storage.log`, `output/playwright/ga/21998389402/step-summary.md` |
| Remote Storage Health drill (P1 issue open, expected FAIL) | [#21998434122](https://github.com/zensgit/metasheet2/actions/runs/21998434122) | FAIL (expected) | `output/playwright/ga/21998434122/storage.log`, `output/playwright/ga/21998434122/step-summary.md`, Issue: [#158](https://github.com/zensgit/metasheet2/issues/158) |
| Remote Storage Health drill recovery (P1 issue auto-close) | [#21998473905](https://github.com/zensgit/metasheet2/actions/runs/21998473905) | PASS | `output/playwright/ga/21998473905/storage.log`, `output/playwright/ga/21998473905/step-summary.md`, Issue: [#158](https://github.com/zensgit/metasheet2/issues/158) |
| Daily Gate Dashboard (includes Storage Health gate) | [#21998506794](https://github.com/zensgit/metasheet2/actions/runs/21998506794) | PASS | `output/playwright/ga/21998506794/attendance-daily-gate-dashboard.md`, `output/playwright/ga/21998506794/attendance-daily-gate-dashboard.json` |

## Post-Go Validation (2026-02-14): Storage Default P1 Issue + Upload Cleanup Runbook

This record validates:

- `Storage Health` opens the **default** P1 tracking issue on non-drill failures and auto-closes on recovery.
- Upload cleanup workflow runs safely in dry-run mode and uploads evidence artifacts (including safety limits inputs).
- Daily Gate Dashboard includes `Upload Cleanup` as a `P2` gate (weekly signal; longer lookback window).

| Gate | Run | Status | Evidence |
|---|---|---|---|
| Storage Health (forced fail, default P1 issue open) | [#22010149843](https://github.com/zensgit/metasheet2/actions/runs/22010149843) | FAIL (expected) | `output/playwright/ga/22010149843/storage.log`, `output/playwright/ga/22010149843/step-summary.md`, Issue: [#159](https://github.com/zensgit/metasheet2/issues/159) |
| Storage Health recovery (default P1 issue auto-close) | [#22010164550](https://github.com/zensgit/metasheet2/actions/runs/22010164550) | PASS | `output/playwright/ga/22010164550/storage.log`, `output/playwright/ga/22010164550/step-summary.md`, Issue: [#159](https://github.com/zensgit/metasheet2/issues/159) |
| Remote Upload Cleanup (dry-run) | [#22010215217](https://github.com/zensgit/metasheet2/actions/runs/22010215217) | PASS | `output/playwright/ga/22010215217/cleanup.log`, `output/playwright/ga/22010215217/step-summary.md` |
| Remote Upload Cleanup (dry-run, safety limits inputs) | [#22010499353](https://github.com/zensgit/metasheet2/actions/runs/22010499353) | PASS | `output/playwright/ga/22010499353/cleanup.log`, `output/playwright/ga/22010499353/step-summary.md` |
| Daily Gate Dashboard (includes Upload Cleanup gate) | [#22010519536](https://github.com/zensgit/metasheet2/actions/runs/22010519536) | PASS | `output/playwright/ga/22010519536/attendance-daily-gate-dashboard.md`, `output/playwright/ga/22010519536/attendance-daily-gate-dashboard.json` |
| Remote Upload Cleanup drill (P2 issue open, expected FAIL) | [#22011899798](https://github.com/zensgit/metasheet2/actions/runs/22011899798) | FAIL (expected) | `output/playwright/ga/22011899798/cleanup.log`, `output/playwright/ga/22011899798/step-summary.md`, Issue: [#160](https://github.com/zensgit/metasheet2/issues/160) |
| Remote Upload Cleanup drill recovery (P2 issue auto-close) | [#22011916523](https://github.com/zensgit/metasheet2/actions/runs/22011916523) | PASS | `output/playwright/ga/22011916523/cleanup.log`, `output/playwright/ga/22011916523/step-summary.md`, Issue: [#160](https://github.com/zensgit/metasheet2/issues/160) |
| Daily Gate Dashboard (Upload Cleanup latest run, ignores `[DRILL]`) | [#22011935825](https://github.com/zensgit/metasheet2/actions/runs/22011935825) | PASS | `output/playwright/ga/22011935825/attendance-daily-gate-dashboard.md`, `output/playwright/ga/22011935825/attendance-daily-gate-dashboard.json` |
| Remote Upload Cleanup (forced fail, default P2 issue open) | [#22013431489](https://github.com/zensgit/metasheet2/actions/runs/22013431489) | FAIL (expected) | `output/playwright/ga/22013431489/cleanup.log`, `output/playwright/ga/22013431489/step-summary.md`, Issue: [#161](https://github.com/zensgit/metasheet2/issues/161) |
| Remote Upload Cleanup recovery (default P2 issue auto-close) | [#22013441581](https://github.com/zensgit/metasheet2/actions/runs/22013441581) | PASS | `output/playwright/ga/22013441581/cleanup.log`, `output/playwright/ga/22013441581/step-summary.md`, Issue: [#161](https://github.com/zensgit/metasheet2/issues/161) |
| Daily Gate Dashboard (Upload Cleanup latest run, default P2 recovery) | [#22013466240](https://github.com/zensgit/metasheet2/actions/runs/22013466240) | PASS | `output/playwright/ga/22013466240/attendance-daily-gate-dashboard.md`, `output/playwright/ga/22013466240/attendance-daily-gate-dashboard.json` |
| Remote Upload Cleanup (input validation classified, safe title override) | [#22013779376](https://github.com/zensgit/metasheet2/actions/runs/22013779376) | FAIL (expected) | `output/playwright/ga/22013779376/cleanup.log`, `output/playwright/ga/22013779376/step-summary.md`, Issue: [#162](https://github.com/zensgit/metasheet2/issues/162) |
| Remote Upload Cleanup (skip_host_sync=true, recovery closes issue) | [#22013804879](https://github.com/zensgit/metasheet2/actions/runs/22013804879) | PASS | `output/playwright/ga/22013804879/cleanup.log`, `output/playwright/ga/22013804879/step-summary.md`, Issue: [#162](https://github.com/zensgit/metasheet2/issues/162) |
| Daily Gate Dashboard (Upload Cleanup latest run after skip_host_sync recovery) | [#22013819495](https://github.com/zensgit/metasheet2/actions/runs/22013819495) | PASS | `output/playwright/ga/22013819495/attendance-daily-gate-dashboard.md`, `output/playwright/ga/22013819495/attendance-daily-gate-dashboard.json` |

## Post-Go Validation (2026-02-14): Debug Runs Do Not Touch Default Issues

This record validates:

- Workflow-dispatch debug runs (`skip_host_sync=true`, tagged `[DEBUG]`) do not create/reopen/close the **default** production issue titles.
- Debug runs still upload evidence artifacts and step summaries for troubleshooting.

Implementation:

- Commit: `41e3b056`
- Change: remote metrics/storage/upload-cleanup issue jobs now treat `[DEBUG]` runs like drills: skip issue ops unless `issue_title` override is provided.

Evidence:

| Gate | Run | Status | Evidence |
|---|---|---|---|
| Storage Health (debug, expected FAIL; issue unchanged) | [#22014157084](https://github.com/zensgit/metasheet2/actions/runs/22014157084) | FAIL (expected) | `output/playwright/ga/22014157084/storage.log`, `output/playwright/ga/22014157084/step-summary.md`, Issue: [#159](https://github.com/zensgit/metasheet2/issues/159) |
| Storage Health (non-debug; failure updates default issue) | [#22014225635](https://github.com/zensgit/metasheet2/actions/runs/22014225635) | FAIL | `output/playwright/ga/22014225635/storage.log`, `output/playwright/ga/22014225635/step-summary.md`, Issue: [#159](https://github.com/zensgit/metasheet2/issues/159) |
| Remote Metrics (debug) | [#22014173363](https://github.com/zensgit/metasheet2/actions/runs/22014173363) | PASS | `output/playwright/ga/22014173363/metrics.log`, `output/playwright/ga/22014173363/step-summary.md` |
| Remote Upload Cleanup (debug, dry-run) | [#22014183752](https://github.com/zensgit/metasheet2/actions/runs/22014183752) | PASS | `output/playwright/ga/22014183752/cleanup.log`, `output/playwright/ga/22014183752/step-summary.md` |
| Daily Gate Dashboard (ignores `[DEBUG]` runs) | [#22014246043](https://github.com/zensgit/metasheet2/actions/runs/22014246043) | FAIL (expected) | `output/playwright/ga/22014246043/attendance-daily-gate-dashboard-22014246043-1/attendance-daily-gate-dashboard.md`, `output/playwright/ga/22014246043/attendance-daily-gate-dashboard-22014246043-1/attendance-daily-gate-dashboard.json` |

Issue immutability check for #159 (before vs after `#22014157084`):

- `commentCount=2`
- `updatedAt=2026-02-14T08:08:53Z`

Issue update check for #159 after non-debug failure `#22014225635`:

- `commentCount=3`
- `updatedAt=2026-02-14T08:26:52Z`

## Post-Go Validation (2026-02-14): Host Disk Reclaim + Storage Health Recovery

This record validates:

- When storage health fails due to host disk usage (`df_used_pct`), a docker image/cache reclaim run can restore filesystem headroom.
- `Storage Health` recovery auto-closes the default tracking issue.
- Daily Gate Dashboard returns to `PASS` after recovery.

| Gate | Run | Status | Evidence |
|---|---|---|---|
| Remote Docker GC (prune attempt; first run disconnected) | [#22014349249](https://github.com/zensgit/metasheet2/actions/runs/22014349249) | FAIL | `output/playwright/ga/22014349249/docker-gc.log`, `output/playwright/ga/22014349249/step-summary.md` |
| Remote Docker GC (prune already running; shows reclaimed disk) | [#22014433107](https://github.com/zensgit/metasheet2/actions/runs/22014433107) | FAIL | `output/playwright/ga/22014433107/docker-gc.log`, `output/playwright/ga/22014433107/step-summary.md` |
| Remote Docker GC (prune=true, PASS) | [#22015221785](https://github.com/zensgit/metasheet2/actions/runs/22015221785) | PASS | `output/playwright/ga/22015221785/docker-gc.log`, `output/playwright/ga/22015221785/step-summary.md` |
| Storage Health recovery (auto-close default issue) | [#22014448225](https://github.com/zensgit/metasheet2/actions/runs/22014448225) | PASS | `output/playwright/ga/22014448225/storage.log`, `output/playwright/ga/22014448225/step-summary.md`, Issue: [#159](https://github.com/zensgit/metasheet2/issues/159) |
| Storage Health (post docker GC) | [#22015238312](https://github.com/zensgit/metasheet2/actions/runs/22015238312) | PASS | `output/playwright/ga/22015238312/storage.log`, `output/playwright/ga/22015238312/step-summary.md` |
| Daily Gate Dashboard (post recovery) | [#22014457079](https://github.com/zensgit/metasheet2/actions/runs/22014457079) | PASS | `output/playwright/ga/22014457079/attendance-daily-gate-dashboard-22014457079-1/attendance-daily-gate-dashboard.md`, `output/playwright/ga/22014457079/attendance-daily-gate-dashboard-22014457079-1/attendance-daily-gate-dashboard.json` |

Evidence highlights:

- Host disk usage recovered to `Use%=47%` on `/dev/vda2` (see `#22014433107` step summary).
- Default storage issue `#159` is now `CLOSED` with:
  - `updatedAt=2026-02-14T08:44:52Z`

## Post-Go Validation (2026-02-14): Storage Health Metrics Parsing Fix

This record validates:

- `Storage Health` step summary shows computed metrics (not literal `\\1`).
- Host sync updates the workflow logic on the deploy host before executing checks.

Implementation:

- Commit: `e6f5b373`
- Change: fix GNU `sed` backref replacement in storage metrics parsing.

Evidence:

| Gate | Run | Status | Evidence |
|---|---|---|---|
| Remote Storage Health (computed metrics OK) | [#22018028547](https://github.com/zensgit/metasheet2/actions/runs/22018028547) | PASS | `output/playwright/ga/22018028547/storage.log`, `output/playwright/ga/22018028547/step-summary.md` |
| Daily Gate Dashboard (picks up latest Storage Health run) | [#22018238598](https://github.com/zensgit/metasheet2/actions/runs/22018238598) | PASS | `output/playwright/ga/22018238598/attendance-daily-gate-dashboard-22018238598-1/attendance-daily-gate-dashboard.md`, `output/playwright/ga/22018238598/attendance-daily-gate-dashboard-22018238598-1/attendance-daily-gate-dashboard.json` |

## Post-Go Validation (2026-02-14): Perf Baseline Artifacts Include perf.log

This record validates:

- `Perf Baseline` artifacts always include `perf.log` (stdout/stderr capture) for easier debugging.

Implementation:

- Commit: `ec0081e5`
- Change: perf baseline/longrun workflows `tee` output into `perf.log` under the uploaded artifacts.

Evidence:

| Gate | Run | Status | Evidence |
|---|---|---|---|
| Perf baseline (10k, upload_csv=true, perf.log captured) | [#22018316457](https://github.com/zensgit/metasheet2/actions/runs/22018316457) | PASS | `output/playwright/ga/22018316457/perf.log`, `output/playwright/ga/22018316457/attendance-perf-*/perf-summary.json` |

## Post-Go Validation (2026-02-14): Perf Long Run Artifacts Include perf.log

This record validates:

- `Perf Long Run` artifacts always include `perf.log` (stdout/stderr capture) for easier debugging.

Implementation:

- Commit: `ec0081e5`
- Change: perf baseline/longrun workflows `tee` output into `perf.log` under the uploaded artifacts.

Evidence:

| Gate | Run | Status | Evidence |
|---|---|---|---|
| Perf longrun (upload_csv=true, perf.log captured) | [#22020987167](https://github.com/zensgit/metasheet2/actions/runs/22020987167) | PASS | `output/playwright/ga/22020987167/**/perf.log`, `output/playwright/ga/22020987167/**/perf-summary.json`, `output/playwright/ga/22020987167/**/attendance-import-perf-longrun-trend.md` |

## Post-Go Validation (2026-02-14): Remote Metrics Gate Adds Reason + Missing Metrics

This record validates:

- `Remote Metrics` step summary (and issue body on failure) includes:
  - failure `reason`
  - `missing_metrics` list (when applicable)
  - `metrics_url` + `max_time` overrides (workflow inputs)

Implementation:

- Commit: `77453352`
- Change: parse metrics log to emit `metrics_reason` and `missing_metrics` outputs; include them in step summary + P1 issue tracking.

Evidence:

| Gate | Run | Status | Evidence |
|---|---|---|---|
| Remote Metrics (reason visible) | [#22021069004](https://github.com/zensgit/metasheet2/actions/runs/22021069004) | PASS | `output/playwright/ga/22021069004/step-summary.md`, `output/playwright/ga/22021069004/metrics.log` |
| Remote Metrics drill (fetch failure classification, expected FAIL; safe issue title) | [#22021555071](https://github.com/zensgit/metasheet2/actions/runs/22021555071) | FAIL (expected) | `output/playwright/ga/22021555071/step-summary.md`, `output/playwright/ga/22021555071/metrics.log`, Issue: [#163](https://github.com/zensgit/metasheet2/issues/163) |
| Remote Metrics drill recovery (issue auto-close) | [#22021568702](https://github.com/zensgit/metasheet2/actions/runs/22021568702) | PASS | `output/playwright/ga/22021568702/step-summary.md`, `output/playwright/ga/22021568702/metrics.log`, Issue: [#163](https://github.com/zensgit/metasheet2/issues/163) |

## Post-Go Validation (2026-02-15): Daily Gate Dashboard Remediation Hints

This record validates:

- `Attendance Daily Gate Dashboard` includes:
  - `Remediation Hints` section (reason-based guidance for common failure modes, e.g. Host Metrics fetch failure)
  - quick re-run commands for each gate workflow

Implementation:

- Commit: `4123a6c9`
- Change: add remediation hints + quick re-run commands to the dashboard markdown output.

Evidence:

| Gate | Run | Status | Evidence |
|---|---|---|---|
| Daily Gate Dashboard (remediation hints + quick rerun commands) | [#22036640772](https://github.com/zensgit/metasheet2/actions/runs/22036640772) | PASS | `output/playwright/ga/22036640772/attendance-daily-gate-dashboard-22036640772-1/attendance-daily-gate-dashboard.md`, `output/playwright/ga/22036640772/attendance-daily-gate-dashboard-22036640772-1/attendance-daily-gate-dashboard.json` |

## Post-Go Validation (2026-02-15): Daily Gate Dashboard Failure Enrichment (Reason Parsing)

This record validates:

- When a remote gate fails (e.g. `Host Metrics`), the dashboard enriches findings by parsing the gate artifact `step-summary.md`:
  - `reason` (e.g. `METRICS_FETCH_FAILED`)
  - `metrics_url` (when available)
- Evidence is written under `gate-meta/**`.
- The dashboard workflow supports `include_drill_runs=true` for drill validation (do not use for normal scheduled signals).

Implementation:

- Commit: `032a1948`
- Change: download & parse remote gate artifacts (best-effort) to add reason-based metadata and remediation hints.

Evidence:

| Gate | Run | Status | Evidence |
|---|---|---|---|
| Daily Gate Dashboard (include_drill_runs=true; expected FAIL; reason visible) | [#22036997527](https://github.com/zensgit/metasheet2/actions/runs/22036997527) | FAIL (expected) | `output/playwright/ga/22036997527/attendance-daily-gate-dashboard.md`, `output/playwright/ga/22036997527/attendance-daily-gate-dashboard.json`, `output/playwright/ga/22036997527/gate-meta/metrics/meta.json` |
| Daily Gate Dashboard (include_drill_runs=true; expected FAIL; storage reason visible) | [#22037190866](https://github.com/zensgit/metasheet2/actions/runs/22037190866) | FAIL (expected) | `output/playwright/ga/22037190866/attendance-daily-gate-dashboard-22037190866-1/attendance-daily-gate-dashboard.md`, `output/playwright/ga/22037190866/attendance-daily-gate-dashboard-22037190866-1/attendance-daily-gate-dashboard.json`, `output/playwright/ga/22037190866/attendance-daily-gate-dashboard-22037190866-1/gate-meta/storage/meta.json` |
| Daily Gate Dashboard (include_drill_runs=true; expected FAIL; preflight+cleanup reason visible) | [#22037367389](https://github.com/zensgit/metasheet2/actions/runs/22037367389) | FAIL (expected) | `output/playwright/ga/22037367389/attendance-daily-gate-dashboard-22037367389-1/attendance-daily-gate-dashboard.md`, `output/playwright/ga/22037367389/attendance-daily-gate-dashboard-22037367389-1/gate-meta/preflight/meta.json`, `output/playwright/ga/22037367389/attendance-daily-gate-dashboard-22037367389-1/gate-meta/cleanup/meta.json` |
| Daily Gate Dashboard (include_drill_runs=true; expected FAIL; perf+longrun summaries visible) | [#22037515667](https://github.com/zensgit/metasheet2/actions/runs/22037515667) | FAIL (expected) | `output/playwright/ga/22037515667/attendance-daily-gate-dashboard-22037515667-1/attendance-daily-gate-dashboard.md`, `output/playwright/ga/22037515667/attendance-daily-gate-dashboard-22037515667-1/gate-meta/perf/meta.json`, `output/playwright/ga/22037515667/attendance-daily-gate-dashboard-22037515667-1/gate-meta/longrun/meta.json` |
| Daily Gate Dashboard (include_drill_runs=true; expected FAIL; strict gates failure details visible) | [#22037671365](https://github.com/zensgit/metasheet2/actions/runs/22037671365) | FAIL (expected) | `output/playwright/ga/22037671365/attendance-daily-gate-dashboard-22037671365-1/attendance-daily-gate-dashboard.md`, `output/playwright/ga/22037671365/attendance-daily-gate-dashboard-22037671365-1/gate-meta/strict/meta.json` |
| Daily Gate Dashboard (include_drill_runs=true; expected FAIL; strict gates reason codes visible) | [#22037869488](https://github.com/zensgit/metasheet2/actions/runs/22037869488) | FAIL (expected) | `output/playwright/ga/22037869488/attendance-daily-gate-dashboard-22037869488-1/attendance-daily-gate-dashboard.md`, `output/playwright/ga/22037869488/attendance-daily-gate-dashboard-22037869488-1/gate-meta/strict/meta.json` |

## Post-Go Validation (2026-02-15): Remote Preflight Debug skip_host_sync

This record validates:

- `Remote Preflight (Prod)` supports `skip_host_sync=true` for debugging when deploy-host git sync is broken.
- Debug runs are tagged `[DEBUG]` so dashboards can ignore them by default.
- Debug runs skip default P0 escalation unless `issue_title` is explicitly provided.

Implementation:

- Commit: `fe8bcfe5`

Evidence:

| Gate | Run | Status | Evidence |
|---|---|---|---|
| Remote Preflight (debug + drill, safe issue title) | [#22037980657](https://github.com/zensgit/metasheet2/actions/runs/22037980657) | FAIL (expected) | `output/playwright/ga/22037980657/attendance-remote-preflight-prod-22037980657-1/step-summary.md`, Issue: [#168](https://github.com/zensgit/metasheet2/issues/168) |
| Daily Gate Dashboard (recovery, closes drill issue) | [#22038001045](https://github.com/zensgit/metasheet2/actions/runs/22038001045) | PASS | `output/playwright/ga/22038001045/attendance-daily-gate-dashboard-22038001045-1/attendance-daily-gate-dashboard.md`, Issue: [#168](https://github.com/zensgit/metasheet2/issues/168) |

## Post-Go Validation (2026-02-15): Strict Gates apiSmoke Audit Export Reason Coverage

This record validates:

- Strict gates `apiSmoke` failures include stable `gateReasons.apiSmoke` reason codes for audit export issues.
- Daily Gate Dashboard renders remediation hints based on these reason codes.

Implementation:

- Commit: `e2b8a3de`
- Change: add `attendance-detect-api-smoke-reason.sh` and extend `apiSmoke` reason detection + dashboard hints.

Evidence:

| Gate | Run | Status | Evidence |
|---|---|---|---|
| Strict Gates drill (expected FAIL; apiSmoke reason simulated) | [#22038312244](https://github.com/zensgit/metasheet2/actions/runs/22038312244) | FAIL (expected) | `output/playwright/ga/22038312244/drill/gate-summary.json` |
| Daily Gate Dashboard (include_drill_runs=true; expected FAIL; reason + remediation hint visible) | [#22038333334](https://github.com/zensgit/metasheet2/actions/runs/22038333334) | FAIL (expected) | `output/playwright/ga/22038333334/attendance-daily-gate-dashboard.md`, `output/playwright/ga/22038333334/gate-meta/strict/meta.json`, Issue: [#169](https://github.com/zensgit/metasheet2/issues/169) |
| Daily Gate Dashboard (recovery; closes drill issue) | [#22038356301](https://github.com/zensgit/metasheet2/actions/runs/22038356301) | PASS | `output/playwright/ga/22038356301/attendance-daily-gate-dashboard.md`, Issue: [#169](https://github.com/zensgit/metasheet2/issues/169) |

Local replay (historical strict gate apiSmoke logs):

```bash
./scripts/ops/attendance-detect-api-smoke-reason.sh output/playwright/ga/21894139054/20260211-054336-1/gate-api-smoke.log
./scripts/ops/attendance-detect-api-smoke-reason.sh output/playwright/ga/21894255303/20260211-054939-1/gate-api-smoke.log
```

Expected outputs:

- `AUDIT_EXPORT_MISSING`
- `AUDIT_EXPORT_SCHEMA_MISSING`

## Post-Go Validation (2026-02-15): Strict Gates apiSmoke Preview-Async Idempotency Reason Coverage

This record validates:

- Strict gates `apiSmoke` failure reasons cover `preview-async` idempotency retry regressions.
- Daily Gate Dashboard renders reason-based remediation hints for these failures.

Implementation:

- Commit: `9f9c07f0`
- Change: expand `attendance-detect-api-smoke-reason.sh` coverage (batch resolve / preview-async idempotency / commit failures) + add dashboard hints.

Evidence:

| Gate | Run | Status | Evidence |
|---|---|---|---|
| Strict Gates drill (expected FAIL; apiSmoke reason simulated) | [#22038559204](https://github.com/zensgit/metasheet2/actions/runs/22038559204) | FAIL (expected) | `output/playwright/ga/22038559204/drill/gate-summary.json` |
| Daily Gate Dashboard (include_drill_runs=true; expected FAIL; reason + remediation hint visible) | [#22038573057](https://github.com/zensgit/metasheet2/actions/runs/22038573057) | FAIL (expected) | `output/playwright/ga/22038573057/attendance-daily-gate-dashboard.md`, `output/playwright/ga/22038573057/gate-meta/strict/meta.json`, Issue: [#170](https://github.com/zensgit/metasheet2/issues/170) |
| Daily Gate Dashboard (recovery; closes drill issue) | [#22038586374](https://github.com/zensgit/metasheet2/actions/runs/22038586374) | PASS | `output/playwright/ga/22038586374/attendance-daily-gate-dashboard.md`, Issue: [#170](https://github.com/zensgit/metasheet2/issues/170) |

## Post-Go Validation (2026-02-15): Strict Gates Provisioning Reason Coverage

This record validates:

- Strict gates `provisioning` failures include stable `gateReasons.provisioning` reason codes.
- Daily Gate Dashboard renders remediation hints based on these reason codes.

Implementation:

- Commit: `3de56dd4`
- Change: strict gates drill supports selecting which gate fails + provisioning reason hints.

Evidence:

| Gate | Run | Status | Evidence |
|---|---|---|---|
| Strict Gates drill (expected FAIL; provisioning reason simulated) | [#22038675256](https://github.com/zensgit/metasheet2/actions/runs/22038675256) | FAIL (expected) | `output/playwright/ga/22038675256/drill/gate-summary.json` |
| Daily Gate Dashboard (include_drill_runs=true; expected FAIL; reason + remediation hint visible) | [#22038687016](https://github.com/zensgit/metasheet2/actions/runs/22038687016) | FAIL (expected) | `output/playwright/ga/22038687016/attendance-daily-gate-dashboard.md`, `output/playwright/ga/22038687016/gate-meta/strict/meta.json`, Issue: [#171](https://github.com/zensgit/metasheet2/issues/171) |
| Daily Gate Dashboard (recovery; closes drill issue) | [#22038701760](https://github.com/zensgit/metasheet2/actions/runs/22038701760) | PASS | `output/playwright/ga/22038701760/attendance-daily-gate-dashboard.md`, Issue: [#171](https://github.com/zensgit/metasheet2/issues/171) |

## Post-Go Validation (2026-02-15): Strict Gates Playwright Reason Coverage

This record validates:

- Strict gates `playwright*` failures include stable `gateReasons.playwright*` reason codes.
- Daily Gate Dashboard renders remediation hints based on these reason codes.

Implementation:

- Commit: `3de56dd4`
- Commit: `72eaac92`
- Change: strict gates drill supports selecting which gate fails + reason-based hints for playwright gates (including auth/mode/feature checks).

Evidence:

| Gate | Run | Status | Evidence |
|---|---|---|---|
| Strict Gates drill (expected FAIL; playwrightDesktop reason simulated) | [#22038724666](https://github.com/zensgit/metasheet2/actions/runs/22038724666) | FAIL (expected) | `output/playwright/ga/22038724666/drill/gate-summary.json` |
| Daily Gate Dashboard (include_drill_runs=true; expected FAIL; reason + remediation hint visible) | [#22038735962](https://github.com/zensgit/metasheet2/actions/runs/22038735962) | FAIL (expected) | `output/playwright/ga/22038735962/attendance-daily-gate-dashboard.md`, `output/playwright/ga/22038735962/gate-meta/strict/meta.json`, Issue: [#172](https://github.com/zensgit/metasheet2/issues/172) |
| Daily Gate Dashboard (recovery; closes drill issue) | [#22038750877](https://github.com/zensgit/metasheet2/actions/runs/22038750877) | PASS | `output/playwright/ga/22038750877/attendance-daily-gate-dashboard.md`, Issue: [#172](https://github.com/zensgit/metasheet2/issues/172) |
| Strict Gates drill (expected FAIL; playwrightDesktop auth failure simulated) | [#22038819581](https://github.com/zensgit/metasheet2/actions/runs/22038819581) | FAIL (expected) | `output/playwright/ga/22038819581/drill/gate-summary.json` |
| Daily Gate Dashboard (include_drill_runs=true; expected FAIL; auth remediation hint visible) | [#22038829941](https://github.com/zensgit/metasheet2/actions/runs/22038829941) | FAIL (expected) | `output/playwright/ga/22038829941/attendance-daily-gate-dashboard.md`, `output/playwright/ga/22038829941/gate-meta/strict/meta.json`, Issue: [#173](https://github.com/zensgit/metasheet2/issues/173) |
| Daily Gate Dashboard (recovery; closes drill issue) | [#22038845477](https://github.com/zensgit/metasheet2/actions/runs/22038845477) | PASS | `output/playwright/ga/22038845477/attendance-daily-gate-dashboard.md`, Issue: [#173](https://github.com/zensgit/metasheet2/issues/173) |

## Post-Go Validation (2026-02-15): Manual Strict Gates + Daily Dashboard PASS

This record validates:

- A non-drill strict gate run passes after the reason/hint refactors.
- Daily dashboard (non-drill) still evaluates all gates as PASS.

Evidence:

| Gate | Run | Status | Evidence |
|---|---|---|---|
| Strict Gates (manual, non-drill) | [#22038886570](https://github.com/zensgit/metasheet2/actions/runs/22038886570) | PASS | `output/playwright/ga/22038886570/20260215-161416-1/gate-summary.json`, `output/playwright/ga/22038886570/20260215-161416-2/gate-summary.json` |
| Daily Gate Dashboard (manual, non-drill) | [#22038947184](https://github.com/zensgit/metasheet2/actions/runs/22038947184) | PASS | `output/playwright/ga/22038947184/attendance-daily-gate-dashboard.md` |

## Post-Go Validation (2026-02-15): Strict Gates Fast Alert Includes Gate Summary

This record validates:

- The strict gates fast-alert escalation issue body includes a compact `gate-summary.json` excerpt (`exitCode`, failing gates, `gateReasons`) for faster triage.
- The workflow remains `workflow_dispatch`-triggerable after the escalation context extraction change.

Implementation:

- Commit: `1121b038`
- Commit: `fa93216b`
- Commit: `9a971b4a`

Evidence:

| Gate | Run | Status | Evidence |
|---|---|---|---|
| Strict Gates drill (expected FAIL; fast alert issue includes gate summary block) | [#22039515349](https://github.com/zensgit/metasheet2/actions/runs/22039515349) | FAIL (expected) | `output/playwright/ga/22039515349/drill/gate-summary.json`, Issue: [#174](https://github.com/zensgit/metasheet2/issues/174) |
| Strict Gates (manual, non-drill; post-fix) | [#22039600337](https://github.com/zensgit/metasheet2/actions/runs/22039600337) | PASS | `output/playwright/ga/22039600337/20260215-170508-1/gate-summary.json`, `output/playwright/ga/22039600337/20260215-170508-2/gate-summary.json` |
| Daily Gate Dashboard (manual, non-drill; ignores strict `[DRILL]` runs) | [#22039675025](https://github.com/zensgit/metasheet2/actions/runs/22039675025) | PASS | `output/playwright/ga/22039675025/attendance-daily-gate-dashboard.md` |
| Strict Gates drill rerun (expected FAIL; fast alert adds comment when issue already open) | [#22046721909](https://github.com/zensgit/metasheet2/actions/runs/22046721909) | FAIL (expected) | `output/playwright/ga/22046721909/drill/gate-summary.json`, Issue: [#175](https://github.com/zensgit/metasheet2/issues/175) |
| Strict Gates drill rerun (expected FAIL; verify comment path) | [#22046734857](https://github.com/zensgit/metasheet2/actions/runs/22046734857) | FAIL (expected) | `output/playwright/ga/22046734857/drill/gate-summary.json`, Issue: [#175](https://github.com/zensgit/metasheet2/issues/175) |

## Post-Go Validation (2026-02-16): Daily Dashboard Embeds Escalation Issue Link

This record validates:

- The Daily Gate Dashboard report artifact includes an `Escalation Issue` section with the issue title + link (when P0 fails).
- Recovery path removes the open issue and the report reflects `none open`.

Implementation:

- Commit: `b557c3ea`

Evidence:

| Gate | Run | Status | Evidence |
|---|---|---|---|
| Daily Gate Dashboard (include_drill_runs=true; expected FAIL; report includes issue link) | [#22046861202](https://github.com/zensgit/metasheet2/actions/runs/22046861202) | FAIL (expected) | `output/playwright/ga/22046861202/attendance-daily-gate-dashboard.md`, Issue: [#176](https://github.com/zensgit/metasheet2/issues/176) |
| Daily Gate Dashboard recovery (expected PASS; report shows none open; issue closed) | [#22046878200](https://github.com/zensgit/metasheet2/actions/runs/22046878200) | PASS | `output/playwright/ga/22046878200/attendance-daily-gate-dashboard.md`, Issue: [#176](https://github.com/zensgit/metasheet2/issues/176) |

## Post-Go Validation (2026-02-16): Daily Dashboard Lists Open P1 Tracking Issues

This record validates:

- The Daily Gate Dashboard report artifact includes an `Open Tracking Issues (P1)` section that lists open issues with titles starting `[Attendance P1]`.
- A drill-created P1 issue appears in the dashboard report while open, and disappears after recovery auto-close.

Implementation:

- Commit: `d49dc844`

Evidence:

| Gate | Run | Status | Evidence |
|---|---|---|---|
| Perf Long Run drill (P1 issue open, expected FAIL) | [#22047000256](https://github.com/zensgit/metasheet2/actions/runs/22047000256) | FAIL (expected) | `output/playwright/ga/22047000256/drill/drill.txt`, Issue: [#177](https://github.com/zensgit/metasheet2/issues/177) |
| Daily Gate Dashboard (expected PASS; shows open P1 tracking issue) | [#22047013470](https://github.com/zensgit/metasheet2/actions/runs/22047013470) | PASS | `output/playwright/ga/22047013470/attendance-daily-gate-dashboard.md`, Issue: [#177](https://github.com/zensgit/metasheet2/issues/177) |
| Perf Long Run drill recovery (P1 issue auto-close) | [#22047026564](https://github.com/zensgit/metasheet2/actions/runs/22047026564) | PASS | `output/playwright/ga/22047026564/drill/drill.txt`, Issue: [#177](https://github.com/zensgit/metasheet2/issues/177) |
| Daily Gate Dashboard (expected PASS; no open P1 tracking issues) | [#22047038178](https://github.com/zensgit/metasheet2/actions/runs/22047038178) | PASS | `output/playwright/ga/22047038178/attendance-daily-gate-dashboard.md` |

## Post-Go Validation (2026-02-16): Daily Dashboard Reasons + Artifact Download Commands

This record validates:

- The Daily Gate Dashboard Gate Status table includes a `Reason` column (stable reason codes + compact metrics).
- The report includes an `Artifact Download Commands` section for one-liner evidence retrieval per gate.

Implementation:

- Commit: `5ef33df3`

Evidence:

| Gate | Run | Status | Evidence |
|---|---|---|---|
| Daily Gate Dashboard drill (include_drill_runs=true; expected FAIL; reasons + download commands visible; issue link visible) | [#22047507241](https://github.com/zensgit/metasheet2/actions/runs/22047507241) | FAIL (expected) | `output/playwright/ga/22047507241/attendance-daily-gate-dashboard.md`, Issue: [#178](https://github.com/zensgit/metasheet2/issues/178) |
| Daily Gate Dashboard recovery (expected PASS; issue closed) | [#22047524824](https://github.com/zensgit/metasheet2/actions/runs/22047524824) | PASS | `output/playwright/ga/22047524824/attendance-daily-gate-dashboard.md`, Issue: [#178](https://github.com/zensgit/metasheet2/issues/178) |

## Post-Go Validation (2026-02-16): Strict Fast Alert Comment De-Dupe (Rerun Attempts)

This record validates:

- Strict gates fast-alert escalation comments are de-duplicated by `runId` (rerun attempts do not add duplicate comments to the same issue).

Implementation:

- Commit: `5ef33df3`

Evidence:

| Gate | Run | Status | Evidence |
|---|---|---|---|
| Strict Gates drill (expected FAIL; issue created with body) | [#22047540386](https://github.com/zensgit/metasheet2/actions/runs/22047540386) | FAIL (expected) | `output/playwright/ga/22047540386/drill/gate-summary.json`, Issue: [#179](https://github.com/zensgit/metasheet2/issues/179) |
| Strict Gates drill rerun (expected FAIL; issue already open; adds 1 comment) | [#22047554624](https://github.com/zensgit/metasheet2/actions/runs/22047554624) | FAIL (expected) | `output/playwright/ga/22047554624/drill/gate-summary.json`, Issue: [#179](https://github.com/zensgit/metasheet2/issues/179) |
| Strict Gates drill rerun attempt=2 (expected FAIL; duplicate comment skipped) | [#22047554624](https://github.com/zensgit/metasheet2/actions/runs/22047554624) | FAIL (expected) | `output/playwright/ga/22047554624/attempt2/drill/gate-summary.json`, Issue: [#179](https://github.com/zensgit/metasheet2/issues/179) |

## Post-Go Validation (2026-02-16): Dashboard `gateFlat` + Strict Artifacts Cmd In Escalation Section

This record validates:

- `attendance-daily-gate-dashboard.json` includes a machine-friendly `gateFlat` object (reasonCode/reasonSummary + key metrics).
- When P0 fails, the report `Escalation Issue` section includes a strict-gates artifact download one-liner pointing at the strict runId.

Implementation:

- Commit: `8fcb6a4b`

Evidence:

| Gate | Run | Status | Evidence |
|---|---|---|---|
| Daily Gate Dashboard drill (include_drill_runs=true; expected FAIL; strict artifacts cmd visible; gateFlat visible) | [#22047781872](https://github.com/zensgit/metasheet2/actions/runs/22047781872) | FAIL (expected) | `output/playwright/ga/22047781872/attendance-daily-gate-dashboard.md`, `output/playwright/ga/22047781872/attendance-daily-gate-dashboard.json`, Issue: [#180](https://github.com/zensgit/metasheet2/issues/180) |
| Daily Gate Dashboard recovery (expected PASS; issue closed) | [#22047797730](https://github.com/zensgit/metasheet2/actions/runs/22047797730) | PASS | `output/playwright/ga/22047797730/attendance-daily-gate-dashboard.md`, Issue: [#180](https://github.com/zensgit/metasheet2/issues/180) |

## Post-Go Validation (2026-02-16): Strict Fast Alert Title Split + Auto-Close On Recovery

This record validates:

- Strict gates fast alert uses a dedicated title (separate from Daily Dashboard escalation issue).
- Recovery path auto-comments and closes the strict fast alert issue.

Implementation:

- Commit: `8fcb6a4b`

Evidence:

| Gate | Run | Status | Evidence |
|---|---|---|---|
| Strict Gates drill (expected FAIL; opens fast alert issue) | [#22047808837](https://github.com/zensgit/metasheet2/actions/runs/22047808837) | FAIL (expected) | `output/playwright/ga/22047808837/drill/gate-summary.json`, Issue: [#181](https://github.com/zensgit/metasheet2/issues/181) |
| Strict Gates drill recovery (expected PASS; auto-close issue) | [#22047821432](https://github.com/zensgit/metasheet2/actions/runs/22047821432) | PASS | `output/playwright/ga/22047821432/drill/gate-summary.json`, Issue: [#181](https://github.com/zensgit/metasheet2/issues/181) |

## Post-Go Validation (2026-02-16): Dashboard RunId De-dup + Strict-only P0 Suppression

This record validates:

- Daily dashboard issue updates are de-duplicated by `runId` (rerun attempts do not produce duplicate comments).
- Daily dashboard suppresses P0 issue creation when the only P0 failure is `Strict Gates` (to avoid dual paging with strict fast alert).
- Dashboard JSON exposes `gateFlat.schemaVersion=2`.

Implementation:

- Commit: `d9862334`

Evidence:

| Gate | Run | Status | Evidence |
|---|---|---|---|
| Daily Dashboard non-drill baseline | [#22050219004](https://github.com/zensgit/metasheet2/actions/runs/22050219004) | PASS | `output/playwright/ga/22050219004/attendance-daily-gate-dashboard.md`, `output/playwright/ga/22050219004/attendance-daily-gate-dashboard.json` |
| Strict drill fail (strict-only source) | [#22050232447](https://github.com/zensgit/metasheet2/actions/runs/22050232447) | FAIL (expected) | `output/playwright/ga/22050232447/attendance-strict-gates-prod-22050232447-1/drill/gate-summary.json`, Issue: [#182](https://github.com/zensgit/metasheet2/issues/182) |
| Daily Dashboard include-drill (strict-only; suppression path) | [#22050242111](https://github.com/zensgit/metasheet2/actions/runs/22050242111) | FAIL (expected) | `output/playwright/ga/22050242111/attendance-daily-gate-dashboard.md` (Escalation section: `Issue: suppressed ...`), `output/playwright/ga/22050242111/attendance-daily-gate-dashboard.json` (`gateFlat.schemaVersion=2`) |
| Preflight drill fail (force non strict-only P0) | [#22050258287](https://github.com/zensgit/metasheet2/actions/runs/22050258287) | FAIL (expected) | `output/playwright/ga/22050258287/attendance-remote-preflight-prod-22050258287-1/preflight.log` |
| Daily Dashboard fail run (issue created once) | [#22050266002](https://github.com/zensgit/metasheet2/actions/runs/22050266002) | FAIL (expected) | `output/playwright/ga/22050266002/attendance-daily-gate-dashboard.md`, Issue: [#183](https://github.com/zensgit/metasheet2/issues/183) |
| Daily Dashboard rerun attempt=2 (same runId; duplicate skipped) | [#22050266002](https://github.com/zensgit/metasheet2/actions/runs/22050266002) | FAIL (expected) | `output/playwright/ga/22050266002-attempt2/attendance-daily-gate-dashboard.md` (Escalation section: `(skipped_duplicate)`), `gh issue view 183 --json comments` => empty list |
| Strict drill recovery (close strict drill issue) | [#22050296690](https://github.com/zensgit/metasheet2/actions/runs/22050296690) | PASS | `output/playwright/ga/22050296690/attendance-strict-gates-prod-22050296690-1/drill/gate-summary.json`, Issue: [#182](https://github.com/zensgit/metasheet2/issues/182) closed |
| Daily Dashboard recovery (close dashboard drill issue) | [#22050308198](https://github.com/zensgit/metasheet2/actions/runs/22050308198) | PASS | `output/playwright/ga/22050308198/attendance-daily-gate-dashboard.md`, Issue: [#183](https://github.com/zensgit/metasheet2/issues/183) closed |

## Post-Go Validation (2026-02-16): Final Non-Drill PASS After Dashboard Hardening

This record validates:

- The hardened daily-dashboard escalation logic does not regress the production (non-drill) strict + dashboard path.
- Strict gates and dashboard both pass with latest main.

Implementation baseline:

- Commit: `d9862334`

Evidence:

| Gate | Run | Status | Evidence |
|---|---|---|---|
| Strict Gates (manual, non-drill; strict chain full pass) | [#22060140322](https://github.com/zensgit/metasheet2/actions/runs/22060140322) | PASS | `output/playwright/ga/22060140322/20260216-110306-1/gate-summary.json`, `output/playwright/ga/22060140322/20260216-110306-2/gate-summary.json` |
| Daily Gate Dashboard (manual, non-drill; final pass) | [#22060251897](https://github.com/zensgit/metasheet2/actions/runs/22060251897) | PASS | `output/playwright/ga/22060251897/attendance-daily-gate-dashboard.md`, `output/playwright/ga/22060251897/attendance-daily-gate-dashboard.json` (`gateFlat.schemaVersion=2`, `p0Status=pass`, `overallStatus=pass`) |

## Post-Go Validation (2026-02-16): Dashboard `escalationIssue` JSON Contract

This record validates:

- Dashboard report JSON includes machine-readable escalation metadata at `.escalationIssue`.
- PASS and strict-only suppression paths both emit deterministic escalation modes.

Implementation:

- Commit: `2113c6f0`

Evidence:

| Gate | Run | Status | Evidence |
|---|---|---|---|
| Daily Dashboard non-drill (contract PASS path) | [#22067085381](https://github.com/zensgit/metasheet2/actions/runs/22067085381) | PASS | `output/playwright/ga/22067085381/attendance-daily-gate-dashboard.json` (`escalationIssue.mode=none_or_closed`) |
| Strict drill fail (source for strict-only P0) | [#22067119138](https://github.com/zensgit/metasheet2/actions/runs/22067119138) | FAIL (expected) | `output/playwright/ga/22067119138/attendance-strict-gates-prod-22067119138-1/drill/gate-summary.json`, Issue: [#184](https://github.com/zensgit/metasheet2/issues/184) |
| Preflight recovery (ensure strict-only condition) | [#22067169136](https://github.com/zensgit/metasheet2/actions/runs/22067169136) | PASS | `output/playwright/ga/22067169136/attendance-remote-preflight-prod-22067169136-1/step-summary.md` |
| Daily Dashboard include-drill strict-only suppression | [#22067185239](https://github.com/zensgit/metasheet2/actions/runs/22067185239) | FAIL (expected) | `output/playwright/ga/22067185239/attendance-daily-gate-dashboard.json` (`escalationIssue.mode=suppressed_strict_only`, `action=suppressed_strict_only_closed`), `output/playwright/ga/22067185239/attendance-daily-gate-dashboard.md`, Issue: [#185](https://github.com/zensgit/metasheet2/issues/185) closed |
| Strict drill recovery (cleanup close) | [#22067219193](https://github.com/zensgit/metasheet2/actions/runs/22067219193) | PASS | `output/playwright/ga/22067219193/attendance-strict-gates-prod-22067219193-1/drill/gate-summary.json`, Issue: [#184](https://github.com/zensgit/metasheet2/issues/184) closed |
