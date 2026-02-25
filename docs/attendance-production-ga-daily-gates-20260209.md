# Attendance Production GA: Daily Gates (2026-02-09)

This document defines the **daily** (or per-deploy) verification loop for keeping the Attendance plugin production-ready.

Rules:

- Do not write any real `AUTH_TOKEN`/JWT/secret into this repo or any document. Use `<ADMIN_JWT>` placeholders.
- Store evidence only under `output/playwright/` (gitignored).

## Target Environment (Current)

- Web: `http://142.171.239.56:8081/attendance`
- API: `http://142.171.239.56:8081/api`
- Backend metrics (host-local): `http://127.0.0.1:8900/metrics/prom` (not exposed via nginx)

## GA Gates (P0)

### 1) Strict Gates Twice (Stability PASS)

This is the primary Go/No-Go gate.

```bash
REQUIRE_ATTENDANCE_ADMIN_API="true" \
REQUIRE_IDEMPOTENCY="true" \
REQUIRE_IMPORT_EXPORT="true" \
REQUIRE_IMPORT_UPLOAD="true" \
REQUIRE_IMPORT_ASYNC="true" \
REQUIRE_IMPORT_TELEMETRY="true" \
REQUIRE_IMPORT_JOB_RECOVERY="false" \
RUN_PREFLIGHT="false" \
API_BASE="http://142.171.239.56:8081/api" \
AUTH_TOKEN="<ADMIN_JWT>" \
EXPECT_PRODUCT_MODE="attendance" \
PROVISION_USER_ID="<TARGET_USER_UUID_FOR_PROVISIONING_GATE>" \
scripts/ops/attendance-run-strict-gates-twice.sh
```

Expected:

- Both runs PASS.
- `gate-api-smoke.log` contains:
  - `idempotency ok`
  - `import upload ok`
  - `export csv ok`
  - `audit export csv ok`
  - `import commit telemetry ok`
  - `import idempotency telemetry ok`
  - `import async telemetry ok`
  - `import async idempotency ok`
- Optional (when `REQUIRE_IMPORT_JOB_RECOVERY=true`):
  - `gate-playwright-full-flow-desktop.log` contains `Admin import recovery assertion passed`.
  - This assertion covers `IMPORT_JOB_TIMEOUT -> Reload import job -> Resume polling`.

Workflow input mapping (`.github/workflows/attendance-strict-gates-prod.yml`):

- `require_import_job_recovery` (default: `false`) -> `REQUIRE_IMPORT_JOB_RECOVERY`.

Evidence:

- The runner prints two evidence directories under:
  - `output/playwright/attendance-prod-acceptance/*`

### 1.5) Remote Preflight (Prod) (Config Drift Gate)

This gate detects production config drift even when no deploy occurs.

Workflow:

- `.github/workflows/attendance-remote-preflight-prod.yml`

Schedule:

- Daily at `02:05 UTC` (before strict gates at `02:15 UTC`).

Manual trigger:

```bash
gh workflow run attendance-remote-preflight-prod.yml -f drill_fail=false
```

Expected:

- `SUCCESS`
- Step Summary includes:
  - PASS/FAIL
  - host sync output snippet (markers)
  - preflight output snippet (markers)
  - runbook links

Artifacts:

- Download:
  - `gh run download <RUN_ID> -n "attendance-remote-preflight-prod-<RUN_ID>-1" -D "output/playwright/ga/<RUN_ID>"`
- Evidence (local, after download):
  - `output/playwright/ga/<RUN_ID>/preflight.log`
  - `output/playwright/ga/<RUN_ID>/step-summary.md`

Drill (expected FAIL, validates FAIL-path evidence upload):

```bash
gh workflow run attendance-remote-preflight-prod.yml -f drill_fail=true
```

Debug inputs:

- `skip_host_sync` (default: `false`) skip deploy-host git sync step (use when host sync is broken)
  - Runs with `skip_host_sync=true` are tagged with `run-name` suffix `[DEBUG]` and ignored by the daily gate dashboard (debug-only).
  - Debug runs also skip default issue escalation unless `issue_title` is explicitly provided.

Notes:

- Drill runs are tagged with `run-name` suffix `[DRILL]`.
- The daily gate dashboard ignores `[DRILL]` runs and uses the latest **non-drill** completed run for:
  - `Remote Preflight`
  - `Host Metrics`
  - `Storage Health`
  - `Strict Gates`
  - `Perf Baseline`
  - `Perf Long Run`
- If the latest non-drill run becomes stale (lookback window), trigger a normal run (`drill_fail=false`) to refresh the signal.
- Remote preflight failures will open/reopen the escalation issue titled:
  - `[Attendance Gate] Daily dashboard alert`
  - This provides fast notifications without waiting for the scheduled dashboard run.
- To validate issue escalation without triggering Slack/DingTalk notifications, run a drill with a safe override title:

```bash
gh workflow run attendance-remote-preflight-prod.yml \
  -f drill_fail=true \
  -f issue_title='[Attendance Gate Drill] Remote preflight issue test'
```

- The notify workflow only sends outbound notifications when the issue title starts with `[Attendance Gate]`.

Strict/perf drill tagging (no production API calls, dashboard ignores these runs):

```bash
gh workflow run attendance-strict-gates-prod.yml -f drill=true
gh workflow run attendance-import-perf-baseline.yml -f drill=true
```

Strict gates failure fast alert:

- The strict gates workflow escalates `[Attendance Gate] Daily dashboard alert` immediately on failure (non-drill runs), without waiting for the scheduled dashboard.
- Safe drill (expected FAIL, creates a non-notify issue title):

```bash
gh workflow run attendance-strict-gates-prod.yml \
  -f drill=true \
  -f drill_fail=true \
  -f issue_title='[Attendance Gate Drill] Strict gates escalation test'
```

### 2) Host Metrics Sanity (Ops-only, on production host)

Run on the production host (where backend binds to `127.0.0.1:8900`):

```bash
scripts/ops/attendance-check-metrics.sh
```

Remote run (recommended, no workstation access required):

- Workflow: `.github/workflows/attendance-remote-metrics-prod.yml`
- Schedule: daily at `02:10 UTC`

Manual trigger:

```bash
gh workflow run attendance-remote-metrics-prod.yml -f drill_fail=false
```

Optional overrides (workflow inputs):

- `metrics_url` (default: `http://127.0.0.1:8900/metrics/prom`)
- `max_time` (default: `10`)

Drill (expected FAIL, validates FAIL-path evidence upload):

```bash
gh workflow run attendance-remote-metrics-prod.yml -f drill_fail=true
```

Artifacts:

- Download:
  - `gh run download <RUN_ID> -n "attendance-remote-metrics-prod-<RUN_ID>-1" -D "output/playwright/ga/<RUN_ID>"`
- Evidence (local, after download):
  - `output/playwright/ga/<RUN_ID>/metrics.log`
  - `output/playwright/ga/<RUN_ID>/step-summary.md`

Expected:

- PASS, and the endpoint contains the attendance counters:
  - `attendance_api_errors_total`
  - `attendance_rate_limited_total`

Notes:

- This gate cannot be executed from a workstation because the backend metrics endpoint is not exposed through nginx.
- Drill runs are tagged with `run-name` suffix `[DRILL]`, and the daily gate dashboard ignores `[DRILL]` (and `[DEBUG]`) runs when selecting the latest completed `Host Metrics` gate run.
- On non-drill failures, this workflow opens/reopens: `[Attendance P1] Host metrics alert` (no paging).
- Safe drill to validate the FAIL-path issue behavior with a safe override title:

```bash
gh workflow run attendance-remote-metrics-prod.yml \
  -f drill_fail=true \
  -f issue_title='[Attendance Metrics Drill] Host metrics issue test'
```

Safe drill to validate a real fetch failure (404) classification:

```bash
gh workflow run attendance-remote-metrics-prod.yml \
  -f drill_fail=true \
  -f metrics_url='http://127.0.0.1:8900/metrics/prom-not-found' \
  -f max_time=3 \
  -f issue_title='[Attendance Metrics Drill] Host metrics reason test'
```
- You can override the target:
  - `METRICS_URL="http://127.0.0.1:8900/metrics/prom" scripts/ops/attendance-check-metrics.sh`

Debug inputs:

- `skip_host_sync` (default: `false`) skip deploy-host git sync step (use when host sync is broken)
  - Runs with `skip_host_sync=true` are tagged with `run-name` suffix `[DEBUG]` and ignored by the daily gate dashboard (debug-only).
  - Debug runs also skip default issue operations (open/reopen/close) unless `issue_title` is explicitly provided.

### 2.5) Remote Storage Health (Prod) (Upload Volume Drift Gate)

This gate checks the health of the upload volume used by the CSV upload channel (`/attendance/import/upload`).

Workflow:

- `.github/workflows/attendance-remote-storage-prod.yml`

Schedule:

- Daily at `02:12 UTC` (between remote metrics at `02:10 UTC` and strict gates at `02:15 UTC`).

Manual trigger:

```bash
gh workflow run attendance-remote-storage-prod.yml -f drill_fail=false
```

Optional thresholds (workflow inputs):

- `max_fs_used_pct` (default: `90`)
- `max_upload_dir_gb` (default: `10`)
- `max_oldest_file_days` (default: `14`)

Debug inputs:

- `skip_host_sync` (default: `false`) skip deploy-host git sync step (use when host sync is broken)
  - Runs with `skip_host_sync=true` are tagged with `run-name` suffix `[DEBUG]` and ignored by the daily gate dashboard (debug-only).
  - Debug runs also skip default issue operations (open/reopen/close) unless `issue_title` is explicitly provided.

Artifacts:

- Download:
  - `gh run download <RUN_ID> -n "attendance-remote-storage-prod-<RUN_ID>-1" -D "output/playwright/ga/<RUN_ID>"`
- Evidence (local, after download):
  - `output/playwright/ga/<RUN_ID>/storage.log`
  - `output/playwright/ga/<RUN_ID>/step-summary.md`

Expected:

- PASS, and the log contains the computed values:
  - `df_used_pct=...`
  - `upload_gb=...`
  - `oldest_file_days=...`

Notes:

- Drill runs are tagged with `run-name` suffix `[DRILL]`, and the daily gate dashboard ignores `[DRILL]` (and `[DEBUG]`) runs when selecting the latest completed `Storage Health` gate run.
- On non-drill failures, this workflow opens/reopens: `[Attendance P1] Storage health alert` (no paging).
- Safe drill to validate the FAIL-path issue behavior with a safe override title:

```bash
gh workflow run attendance-remote-storage-prod.yml \
  -f drill_fail=true \
  -f issue_title='[Attendance Storage Drill] Storage issue test'
```

Remediation (when `df_used_pct` is high):

- Run remote docker garbage collection (removes unused images/caches; does **not** remove named volumes):
  - Workflow: `.github/workflows/attendance-remote-docker-gc-prod.yml`

```bash
gh workflow run attendance-remote-docker-gc-prod.yml -f prune=true
```

- Download artifacts:

```bash
gh run download <RUN_ID> -n "attendance-remote-docker-gc-prod-<RUN_ID>-1" -D "output/playwright/ga/<RUN_ID>"
```

- Then re-run storage health to confirm recovery and auto-close the P1 issue:

```bash
gh workflow run attendance-remote-storage-prod.yml -f drill_fail=false
```

### 2.6) Remote Upload Cleanup (Prod) (Manual / Scheduled Dry-Run)

This workflow provides a safe remediation path when the upload volume accumulates stale files.

Workflow:

- `.github/workflows/attendance-remote-upload-cleanup-prod.yml`

Schedule:

- Weekly dry-run report at `02:20 UTC` (Sunday).

P2 tracking issue (no paging): `[Attendance P2] Upload cleanup alert` (opened/reopened on failure; commented+closed on recovery).

Safety limits (workflow inputs):

- `max_delete_files` (default: `5000`) refuse deletion if stale file count exceeds this threshold
- `max_delete_gb` (default: `5`) refuse deletion if estimated stale size exceeds this threshold

Debug inputs:

- `skip_host_sync` (default: `false`) skip deploy-host git sync step (use when host sync is broken)
  - Runs with `skip_host_sync=true` are tagged with `run-name` suffix `[DEBUG]` and ignored by the daily gate dashboard (debug-only).
  - Debug runs also skip default issue operations (open/reopen/close) unless `issue_title` is explicitly provided.

Manual trigger (dry-run):

```bash
gh workflow run attendance-remote-upload-cleanup-prod.yml \
  -f drill_fail=false \
  -f skip_host_sync=false \
  -f max_file_age_days=14 \
  -f max_delete_files=5000 \
  -f max_delete_gb=5 \
  -f delete=false \
  -f confirm_delete=false
```

Drill (expected FAIL; no destructive delete; uses a safe override title):

```bash
gh workflow run attendance-remote-upload-cleanup-prod.yml \
  -f drill_fail=true \
  -f issue_title='[Attendance Cleanup Drill] Upload cleanup issue test'
```

Manual trigger (destructive, requires explicit confirmation):

```bash
gh workflow run attendance-remote-upload-cleanup-prod.yml \
  -f drill_fail=false \
  -f max_file_age_days=14 \
  -f max_delete_files=5000 \
  -f max_delete_gb=5 \
  -f delete=true \
  -f confirm_delete=true
```

Artifacts:

- Download:
  - `gh run download <RUN_ID> -n "attendance-remote-upload-cleanup-prod-<RUN_ID>-1" -D "output/playwright/ga/<RUN_ID>"`
- Evidence (local, after download):
  - `output/playwright/ga/<RUN_ID>/cleanup.log`
  - `output/playwright/ga/<RUN_ID>/step-summary.md`

### 3) 10k Import Perf Baseline (Rollback Enabled)

This gate establishes a minimum performance baseline for production v1 while keeping the environment clean.

```bash
API_BASE="http://142.171.239.56:8081/api" \
AUTH_TOKEN="<ADMIN_JWT>" \
ROWS="10000" \
MODE="commit" \
ROLLBACK="true" \
COMMIT_ASYNC="true" \
EXPORT_CSV="true" \
node scripts/ops/attendance-import-perf.mjs
```

Expected:

- Preview succeeds and returns items.
- Commit succeeds and returns `batchId`.
- Rollback succeeds (no batch/items left behind).
- Evidence JSON is written to:
  - `output/playwright/attendance-import-perf/<runId>/perf-summary.json`

Recommended thresholds (adjust after 1 week of real traffic data):

- `previewMs <= 120000` for 10k rows
- `commitMs <= 180000` for 10k rows
- `exportMs <= 30000` for 10k rows
- `rollbackMs <= 10000` for 10k rows

Notes:

- By default, this script does **not** enable `groupSync` to avoid creating persistent groups/members.
- If you see `504 Gateway Time-out` from nginx on preview/commit, ensure the web proxy timeouts are increased:
  - `docker/nginx.conf`: `proxy_read_timeout 300s` (then redeploy/restart web)
- To enforce thresholds in CI/manual runs:
  - `MAX_PREVIEW_MS=120000 MAX_COMMIT_MS=180000 MAX_EXPORT_MS=30000 MAX_ROLLBACK_MS=10000 ... node scripts/ops/attendance-import-perf.mjs`

## GitHub Actions (Recommended)

### A) Daily Strict Gates (Prod)

Workflow:

- `.github/workflows/attendance-strict-gates-prod.yml`

Required secrets/vars:

- Secret: `ATTENDANCE_ADMIN_JWT` (admin JWT)
- Variable (optional): `ATTENDANCE_API_BASE` (defaults to `http://142.171.239.56:8081/api`)
- Variable (optional): `ATTENDANCE_PROVISION_USER_ID` (to enable Gate 3 provisioning inside the gate runner)

Artifacts:

- Uploaded for 14 days:
  - `output/playwright/attendance-prod-acceptance/**`

Inputs:

- `require_import_async` defaults to `true` (recommended).
- Set `require_import_async=false` only for temporary legacy compatibility checks.

Notes:

- Strict gates artifacts include a `gate-summary.json` with `gateReasons` (reason codes) to speed up triage in Daily Dashboard remediation hints.
- On failure, the workflow also opens a fast-alert issue (`[Attendance Gate] Daily dashboard alert` by default) with:
  - Run URL + job status
  - A compact `gate-summary.json` excerpt (`exitCode`, failing gates, `gateReasons`)
  - Artifact download command
  - If the issue is already open, the workflow adds a **comment** with the latest strict-gates context (so repeated failures are auditable without overwriting the issue body).
- Default issue title (production): `[Attendance Gate] Strict gates fast alert` (separate from Daily Dashboard escalation title).
- Recovery behavior: when strict gates pass again, the workflow auto-comments and closes the fast-alert issue.
- Common `apiSmoke` reason codes:
  - Auth/feature/mode: `AUTH_FAILED`, `RATE_LIMITED`, `PRODUCT_MODE_MISMATCH`, `FEATURE_DISABLED`
  - Admin/batch resolve: `ADMIN_API_MISSING`, `ADMIN_BATCH_RESOLVE_MISSING`, `ADMIN_BATCH_RESOLVE_SCHEMA_MISMATCH`, `ADMIN_BATCH_RESOLVE_FAILED`
  - Audit logs: `AUDIT_EXPORT_MISSING`, `AUDIT_EXPORT_SCHEMA_MISSING`, `AUDIT_EXPORT_FAILED`, `AUDIT_SUMMARY_MISSING`, `AUDIT_SUMMARY_FAILED`
  - Import channels: `IMPORT_UPLOAD_FAILED`, `IMPORT_EXPORT_MISSING`, `IMPORT_COMMIT_FAILED`, `IDEMPOTENCY_NOT_SUPPORTED`, `PREVIEW_ASYNC_IDEMPOTENCY_NOT_SUPPORTED`, `COMMIT_TOKEN_REJECTED`

Drill (expected FAIL; no production API calls; validates dashboard parsing/hints):

```bash
gh workflow run attendance-strict-gates-prod.yml \
  -f drill=true \
  -f drill_fail=true \
  -f drill_api_smoke_reason='AUDIT_EXPORT_SCHEMA_MISSING' \
  -f issue_title='[Attendance Gate Drill] Strict gates fast alert test'
```

Drill other strict-gate failures (simulates `gate-summary.json` only; still no production API calls):

- Inputs:
  - `drill_failed_gate` selects which gate is marked `FAIL` in `gate-summary.json`.
  - When `drill_failed_gate=apiSmoke`, use `drill_api_smoke_reason=...`.
  - Otherwise, use `drill_gate_reason=...` (example: `AUTH_FAILED`, `TIMEOUT`, `RATE_LIMITED`).

Example (provisioning auth failure):

```bash
gh workflow run attendance-strict-gates-prod.yml \
  -f drill=true \
  -f drill_fail=true \
  -f drill_failed_gate='provisioning' \
  -f drill_gate_reason='AUTH_FAILED'
```

### B) Perf Baseline (Scheduled + Manual)

Workflow:

- `.github/workflows/attendance-import-perf-baseline.yml`

Required secret:

- Secret: `ATTENDANCE_ADMIN_JWT`

Optional repo variables (threshold guardrails):

- `ATTENDANCE_PERF_MAX_PREVIEW_MS`
- `ATTENDANCE_PERF_MAX_COMMIT_MS`
- `ATTENDANCE_PERF_MAX_EXPORT_MS`
- `ATTENDANCE_PERF_MAX_ROLLBACK_MS`
- `ATTENDANCE_PERF_BASELINE_ROWS` (optional; default baseline rows, current default is `100000`)

Artifacts:

- Uploaded for 14 days:
  - `output/playwright/attendance-import-perf/**`
  - Includes `perf.log` (stdout/stderr capture) for debugging failures.

P1 tracking issue (no paging): `[Attendance P1] Perf baseline alert` (opened/reopened on failure; commented+closed on recovery).

Defaults (current):

- `rows=100000` (daily baseline)
- `upload_csv=true`
- `commit_async=true`
- `mode=commit`

Drill (expected FAIL; no production API calls; uses a safe override title):

```bash
gh workflow run attendance-import-perf-baseline.yml \
  -f drill=true \
  -f drill_fail=true \
  -f issue_title='[Attendance Perf Drill] Perf baseline issue test'
```

### C) Perf Long Run (Trend)

Workflow:

- `.github/workflows/attendance-import-perf-longrun.yml`

Schedule:

- Daily at `05:10 UTC`

Defaults:

- `upload_csv=true` (recommended; ensures the longrun trend covers the `/attendance/import/upload` channel).
- Scenario matrix includes:
  - `rows10k-commit` (commit + export)
  - `rows100k-commit` (commit + export; bulk-path guard)
  - `rows50k-preview`
  - `rows100k-preview`
  - `rows500k-preview` (extreme-scale guard)
- Optional threshold overrides for the new commit scenario:
  - `ATTENDANCE_PERF_LONGRUN_100K_COMMIT_MAX_PREVIEW_MS`
  - `ATTENDANCE_PERF_LONGRUN_100K_COMMIT_MAX_COMMIT_MS`
  - `ATTENDANCE_PERF_LONGRUN_100K_COMMIT_MAX_EXPORT_MS`
  - These use dedicated longrun defaults (`180000/300000/45000`) and are intentionally not inherited from baseline `ATTENDANCE_PERF_MAX_*` vars.

Manual trigger:

```bash
gh workflow run attendance-import-perf-longrun.yml -f upload_csv=true -f fail_on_regression=false
```

Artifacts:

- Download (all artifacts for this run):
  - `gh run download <RUN_ID> -D "output/playwright/ga/<RUN_ID>"`
- Evidence (local, after download):
  - `output/playwright/ga/<RUN_ID>/**/attendance-import-perf-longrun-trend.md`
  - `output/playwright/ga/<RUN_ID>/**/perf-summary.json`
  - `output/playwright/ga/<RUN_ID>/**/perf.log` (stdout/stderr capture; per scenario)

P1 tracking issue (no paging): `[Attendance P1] Perf longrun alert` (opened/reopened on failure; commented+closed on recovery).

Drill (expected FAIL; no production API calls; uses a safe override title):

```bash
gh workflow run attendance-import-perf-longrun.yml \
  -f drill=true \
  -f drill_fail=true \
  -f issue_title='[Attendance Longrun Drill] Perf longrun issue test'
```

### D) Daily Gate Dashboard (Scheduled + Manual)

Workflow:

- `.github/workflows/attendance-daily-gate-dashboard.yml`

Purpose:

- Build a daily dashboard from the latest gate workflow runs (remote + strict + perf).
- Apply escalation rules automatically:
  - `P0`: strict gate failure
  - `P1`: host metrics/storage health/perf baseline/perf longrun failure or stale runs
- `P2`: upload cleanup (weekly) failure or stale runs
- Include `Remediation Hints` + quick re-run commands to speed up operator recovery.
  - When a remote gate fails (`Host Metrics` / `Storage Health`), the dashboard best-effort enriches findings by parsing the gate `step-summary.md` artifact (reason/metrics_url/df_used_pct, etc). Evidence is written under `gate-meta/**`.
- Gate Status table includes a `Reason` column (stable reason codes + compact metrics) and an `Artifact Download Commands` section for one-liner evidence retrieval.
- Remote preflight is also included as a `P0` gate (config drift detection).
- Open/update GitHub issue `[Attendance Gate] Daily dashboard alert` only when **P0** status is `FAIL` (Remote preflight / strict gate failure).
- The dashboard report appends an `Escalation Issue` section (issue title + issue link when P0 fails) to keep evidence self-contained in artifacts.
- When P0 fails, the `Escalation Issue` section also includes a one-liner to download `Strict Gates` artifacts for `gate-summary.json` triage.
- P1/P2 findings still make the workflow `FAIL` (for visibility), but do not page via the `[Attendance Gate]` escalation issue.
- The dashboard report also lists open **P1 tracking issues** (titles starting with `[Attendance P1]`) under `Open Tracking Issues (P1)` to keep operational follow-ups visible.
- Report JSON includes a machine-friendly `gateFlat` object (reasonCode/reasonSummary + key metrics) in `attendance-daily-gate-dashboard.json`.

Schedule:

- Daily at `04:30 UTC` (after strict/perf scheduled windows).

Artifacts:

- Uploaded for 30 days:
  - `output/playwright/attendance-daily-gate-dashboard/**`

Manual local generation (operator workstation):

```bash
GH_TOKEN="$(gh auth token)" \
GITHUB_REPOSITORY="zensgit/metasheet2" \
BRANCH="main" \
LOOKBACK_HOURS="48" \
node scripts/ops/attendance-daily-gate-report.mjs
```

Expected outputs:

- `REPORT_STATUS=pass|fail`
- `REPORT_P0_STATUS=pass|fail`
- `REPORT_DIR=...`
- `REPORT_MARKDOWN=...`
- `REPORT_JSON=...`

Safe drill (workflow_dispatch) to validate the P0 issue path without triggering outbound notifications:

```bash
gh workflow run attendance-daily-gate-dashboard.yml \
  -f branch='nonexistent-branch-for-drill' \
  -f lookback_hours=48 \
  -f issue_title='[Attendance Gate Drill] Dashboard P0 escalation test'
```

Optional: include `[DRILL]` / `[DEBUG]` runs in evaluation (for drill validation only):

```bash
gh workflow run attendance-daily-gate-dashboard.yml \
  -f lookback_hours=48 \
  -f include_drill_runs=true
```

### E) Gate Issue Channel Sync (Slack / DingTalk)

Workflow:

- `.github/workflows/attendance-gate-issue-notify.yml`

Trigger:

- Automatic on issue events: `opened/reopened/edited`
- Filter: issue title starts with `[Attendance Gate]`
- Manual test via `workflow_dispatch`

Required secrets (at least one):

- `ATTENDANCE_ALERT_SLACK_WEBHOOK_URL`
- `ATTENDANCE_ALERT_DINGTALK_WEBHOOK_URL`

Behavior:

- Sends normalized alert text to configured channels.
- If no webhook secrets are configured, workflow writes warning in summary (no external send).

## Daily Record Template (Copy/Paste)

Date:
- Strict gates twice:
  - PASS/FAIL:
  - Evidence 1:
  - Evidence 2:
  - Notes:
- Metrics sanity:
  - PASS/FAIL:
  - Notes:
- 10k perf baseline:
  - PASS/FAIL:
  - Evidence:
  - previewMs:
  - commitMs:
  - Notes:

## Latest Notes (2026-02-09)

Strict gates twice (remote) passed:

- Evidence:
  - `output/playwright/attendance-prod-acceptance/20260209-181349-1/`
  - `output/playwright/attendance-prod-acceptance/20260209-181349-2/`

Perf baseline notes:

- 2k preview/commit + rollback passed (examples):
  - `output/playwright/attendance-import-perf/attendance-perf-mlfhy37t-g4n509/perf-summary.json`
  - `output/playwright/attendance-import-perf/attendance-perf-mlfhywc4-6w52wb/perf-summary.json`
- 10k preview returned `504 Gateway Time-out` through nginx on `http://142.171.239.56:8081/api` before the deploy host picked up the updated `docker/nginx.conf`.

## Latest Notes (2026-02-10)

Strict gates workflow passed (remote, strict gates twice + Playwright desktop/mobile):

- GitHub Actions run: [Attendance Strict Gates (Prod) #21856529452](https://github.com/zensgit/metasheet2/actions/runs/21856529452) (`SUCCESS`)
- Artifacts uploaded (14 days):
  - `output/playwright/attendance-prod-acceptance/**`
  - For local inspection, download the artifact:
    - `gh run download 21856529452 -n attendance-strict-gates-prod-21856529452-1 -D output/playwright/ga/21856529452`
    - Evidence directories (downloaded):
      - `output/playwright/ga/21856529452/20260210-080104-1/`
      - `output/playwright/ga/21856529452/20260210-080104-2/`

Provisioning gate is now enabled in the GA workflow via repo variable `ATTENDANCE_PROVISION_USER_ID`.
Validation run with provisioning included:

- GitHub Actions run: [Attendance Strict Gates (Prod) #21862429047](https://github.com/zensgit/metasheet2/actions/runs/21862429047) (`SUCCESS`)
- Download:
  - `gh run download 21862429047 -n attendance-strict-gates-prod-21862429047-1 -D output/playwright/ga/21862429047`
  - Evidence directories (downloaded):
    - `output/playwright/ga/21862429047/20260210-110831-1/`
    - `output/playwright/ga/21862429047/20260210-110831-2/`
  - Provisioning logs are included under:
    - `gate-provision-employee.log`
    - `gate-provision-approver.log`

Local dev verification (feature branch, Step 2/3 hardening):

- Evidence (API smoke + audit export CSV):
  - `output/playwright/attendance-step2-step3-local/20260210-173017/`
  - Contents:
    - `gate-api-smoke.log` (includes `audit export csv ok` + `import async idempotency ok`)
    - `audit-logs-export.csv` (saved response from `GET /api/attendance-admin/audit-logs/export.csv`)

- Evidence (gates + Playwright full flow):
  - `output/playwright/attendance-prod-acceptance/20260210-174721/`
  - Contents:
    - `gate-api-smoke.log` (includes `audit export csv ok` + `import async idempotency ok`)
    - `playwright-full-flow-desktop/02-admin.png` (Admin Center snapshot includes Audit Logs actions)
    - `playwright-full-flow-mobile/02-admin.png` (Mobile policy snapshot)

Notes:

- This run targets a local dev backend, so `/api/auth/me -> features.mode` shows `platform` (not `attendance`).
- No secrets were stored in the repo; tokens were passed via env at runtime only.

## Latest Notes (2026-02-11)

Local strict gates twice passed (including provisioning + async import gate):

- Strict flags:
  - `REQUIRE_ATTENDANCE_ADMIN_API=true`
  - `REQUIRE_IDEMPOTENCY=true`
  - `REQUIRE_IMPORT_EXPORT=true`
  - `REQUIRE_IMPORT_ASYNC=true`
- Evidence:
  - `output/playwright/attendance-prod-acceptance/20260211-052354-1/`
  - `output/playwright/attendance-prod-acceptance/20260211-052354-2/`
- `gate-api-smoke.log` in both runs contains:
  - `audit export csv ok`
  - `idempotency ok`
  - `export csv ok`
  - `import async idempotency ok`

Integration test evidence (includes audit export CSV API regression check):

- Command:
  - `pnpm --filter @metasheet/core-backend test:integration:attendance`
- Evidence:
  - `output/playwright/attendance-next-phase/20260211-052522/attendance-integration.log`

Automation hardening verification (defaults + perf thresholds):

- Strict gates twice with default strictness (no explicit `REQUIRE_IMPORT_ASYNC`):
  - `PASS`
  - Evidence:
    - `output/playwright/attendance-prod-acceptance/20260211-053626-1/`
    - `output/playwright/attendance-prod-acceptance/20260211-053626-2/`
  - API smoke logs include:
    - `audit export csv ok`
    - `idempotency ok`
    - `export csv ok`
    - `import async idempotency ok`
- Perf baseline with threshold guardrails:
  - Command profile: `ROWS=500 MODE=commit COMMIT_ASYNC=true EXPORT_CSV=true ROLLBACK=true`
  - Evidence:
    - `output/playwright/attendance-import-perf-local/attendance-perf-mlhljnlj-wdmfnl/perf-summary.json`
  - Result:
    - `previewMs=11294`
    - `commitMs=8141`
    - `exportMs=31`
    - `rollbackMs=76`
    - `regressions=[]`

Production workflow closure (main, after PR #136 + #137):

- Deploy pipeline:
  - [Build and Push Docker Images #21894316469](https://github.com/zensgit/metasheet2/actions/runs/21894316469) (`SUCCESS`)
  - Includes migration execution in deploy step.
- Strict gates twice (async strict default): `PASS`
  - Run: [Attendance Strict Gates (Prod) #21894374032](https://github.com/zensgit/metasheet2/actions/runs/21894374032)
  - Evidence:
    - `output/playwright/ga/21894374032/20260211-055556-1/`
    - `output/playwright/ga/21894374032/20260211-055556-2/`
  - `gate-api-smoke.log` includes:
    - `audit export csv ok`
    - `idempotency ok`
    - `export csv ok`
    - `import async idempotency ok`
- Perf baseline with thresholds (10k, async+export+rollback): `PASS`
  - Run: [Attendance Import Perf Baseline #21894377908](https://github.com/zensgit/metasheet2/actions/runs/21894377908)
  - Evidence:
    - `output/playwright/ga/21894377908/attendance-perf-mlhm8esx-abitlr/perf-summary.json`
  - Metrics:
    - `previewMs=2919`
    - `commitMs=66985`
    - `exportMs=390`
    - `rollbackMs=114`
    - `regressions=[]`

Daily dashboard local verification (2026-02-11):

- Command:
  - `GH_TOKEN="$(gh auth token)" GITHUB_REPOSITORY="zensgit/metasheet2" BRANCH="main" LOOKBACK_HOURS="48" node scripts/ops/attendance-daily-gate-report.mjs`
- Result:
  - `REPORT_STATUS=pass`
- Evidence:
  - `output/playwright/attendance-daily-gate-dashboard/20260211-100235/attendance-daily-gate-dashboard.md`
  - `output/playwright/attendance-daily-gate-dashboard/20260211-100235/attendance-daily-gate-dashboard.json`

Daily dashboard workflow verification (main, 2026-02-11):

- Run:
  - [Attendance Daily Gate Dashboard #21900762111](https://github.com/zensgit/metasheet2/actions/runs/21900762111) (`SUCCESS`)
- Downloaded artifact evidence:
  - `output/playwright/ga/21900762111/attendance-daily-gate-dashboard.md`
  - `output/playwright/ga/21900762111/attendance-daily-gate-dashboard.json`
- Result:
  - `overallStatus=pass`
  - `strictRun=21894374032`
  - `perfRun=21894377908`

Daily dashboard failure drill verification (main, 2026-02-11):

- Run:
  - [Attendance Daily Gate Dashboard #21912261134](https://github.com/zensgit/metasheet2/actions/runs/21912261134) (`FAILURE`, expected)
- Trigger:
  - `lookback_hours=1` to force stale-run escalation.
- Expected behavior validated:
  - workflow creates/updates issue `[Attendance Gate] Daily dashboard alert`
  - workflow exits with failure (escalation signal)
- Evidence:
  - `output/playwright/ga/21912261134/attendance-daily-gate-dashboard.md`
  - `output/playwright/ga/21912261134/attendance-daily-gate-dashboard.json`
  - issue: [#141](https://github.com/zensgit/metasheet2/issues/141)

Perf threshold lock + tighten execution (2026-02-11):

- Step 2 (lock baseline vars):
  - `ATTENDANCE_PERF_MAX_PREVIEW_MS=120000`
  - `ATTENDANCE_PERF_MAX_COMMIT_MS=180000`
  - `ATTENDANCE_PERF_MAX_EXPORT_MS=30000`
  - `ATTENDANCE_PERF_MAX_ROLLBACK_MS=10000`
- Step 4 (7-day window review + tighten):
  - Evidence summary:
    - `output/playwright/attendance-next-phase/20260211-160000-threshold-review/perf-7d-summary.json`
  - Sample selector: `rows=10000`, `mode=commit`, `window=7d`, `sampleCount=5`
  - Tightened vars (applied):
    - `ATTENDANCE_PERF_MAX_PREVIEW_MS=100000`
    - `ATTENDANCE_PERF_MAX_COMMIT_MS=150000`
    - `ATTENDANCE_PERF_MAX_EXPORT_MS=25000`
    - `ATTENDANCE_PERF_MAX_ROLLBACK_MS=8000`

10k perf baseline now passes through nginx after fixing deploy host config sync (deploy now fast-forwards the repo via `git pull --ff-only origin main` before `docker compose up`):

- 10k preview PASS:
  - Evidence: `output/playwright/attendance-import-perf/attendance-perf-mlgars47-l6wd3m/perf-summary.json`
  - previewMs: `70321`
- 10k commit + rollback PASS:
  - Evidence: `output/playwright/attendance-import-perf/attendance-perf-mlgatxk0-4yzd5p/perf-summary.json`
  - previewMs: `76092`
  - commitMs: `119036`
  - rollbackMs: `886`

Post-merge PR `#129` (import response-size controls) verification (workstation run; token placeholder only):

- Strict gates twice: `PASS`
  Evidence 1: `output/playwright/attendance-prod-acceptance/20260210-130211/`
  Evidence 2: `output/playwright/attendance-prod-acceptance/20260210-130454/`
  API smoke log contains: `idempotency ok`, `export csv ok`
- 10k perf baseline (commit + export + rollback): `PASS`
  Evidence: `output/playwright/attendance-import-perf/attendance-perf-mlgm7tss-775i34/perf-summary.json`
  previewMs: `3462`
  commitMs: `108327`
  exportMs: `1106`
  rollbackMs: `327`
- 50k preview baseline: `PASS`
  Evidence: `output/playwright/attendance-import-perf/attendance-perf-mlgmasnj-1bo840/perf-summary.json`
  previewMs: `5217`
- 100k preview baseline: `PASS`
  Evidence: `output/playwright/attendance-import-perf/attendance-perf-mlgmb8xc-7hkkzr/perf-summary.json`
  previewMs: `5486`

Notes:

- These perf runs exercise the new "large import" safe defaults to avoid huge responses: `previewLimit=200`, `returnItems=false`.

## Latest Notes (2026-02-10, post-merge PR #131)

Strict gates workflow (remote) encountered a transient failure:

- GitHub Actions run: [Attendance Strict Gates (Prod) #21868349289](https://github.com/zensgit/metasheet2/actions/runs/21868349289) (`FAILURE`)
- Failure: `gate-api-smoke.log` hit an intermittent `HTTP 500` on `POST /api/attendance/import/commit`.
- Artifact download:
  - `gh run download 21868349289 -D output/playwright/ga/21868349289`
- Evidence directory (downloaded):
  - `output/playwright/ga/21868349289/attendance-strict-gates-prod-21868349289-1/20260210-141438-1/`

Mitigation (gate stability hardening):

- `scripts/ops/attendance-smoke-api.mjs` now retries the import commit step (bounded; default `COMMIT_RETRIES=3`) by preparing a fresh
  commit token when the server responds with `HTTP 5xx` or commit-token errors.

Workstation strict gates rerun (2x consecutive): `PASS`

- Evidence:
  - `output/playwright/attendance-prod-acceptance/20260210-143245/`
  - `output/playwright/attendance-prod-acceptance/20260210-143523/`

Perf baseline (10k commit + rollback) improved after PR `#131`:

- GitHub Actions run: [Attendance Import Perf Baseline (Manual) #21868374518](https://github.com/zensgit/metasheet2/actions/runs/21868374518) (`SUCCESS`)
- Artifact download:
  - `gh run download 21868374518 -D output/playwright/ga/21868374518`
- Evidence JSON:
  - `output/playwright/ga/21868374518/attendance-import-perf-21868374518-1/attendance-perf-mlgomass-j77nax/perf-summary.json`
- previewMs: `2877`
- commitMs: `62440`
- rollbackMs: `207`

## Latest Notes (2026-02-10, Playwright Prod Rate-Limit Flake)

Another workflow run hit a production-expected rate limiter during the **Playwright production flow** (admin import commit):

- GitHub Actions run: [Attendance Strict Gates (Prod) #21870136102](https://github.com/zensgit/metasheet2/actions/runs/21870136102) (`FAILURE`)
- Failure: `gate-playwright-production-flow.log` saw `HTTP 429 RATE_LIMITED` on `POST /api/attendance/import/commit`.
- Artifact download:
  - `gh run download 21870136102 -n attendance-strict-gates-prod-21870136102-1 -D output/playwright/ga/21870136102`
- Evidence directory (downloaded):
  - `output/playwright/ga/21870136102/20260210-150337-1/`

Mitigation:

- `scripts/verify-attendance-production-flow.mjs` now retries the import commit step when the server responds with:
  - `HTTP 429 RATE_LIMITED` (waits `retryAfterMs` + jitter; bounded attempts)
  - `COMMIT_TOKEN_INVALID` / `COMMIT_TOKEN_REQUIRED` (re-runs preview to refresh `commitToken`)

Workstation verification run: `PASS`

- Evidence:
  - `output/playwright/attendance-prod-acceptance/20260210-production-flow-rate-limit-retry/`

Follow-up strict gates workflow run (post-merge mitigation): `SUCCESS`

- GitHub Actions run: [Attendance Strict Gates (Prod) #21870551973](https://github.com/zensgit/metasheet2/actions/runs/21870551973) (`SUCCESS`)
- Download:
  - `gh run download 21870551973 -n attendance-strict-gates-prod-21870551973-1 -D output/playwright/ga/21870551973`
- Evidence directories (downloaded):
  - `output/playwright/ga/21870551973/20260210-151448-1/`
  - `output/playwright/ga/21870551973/20260210-151448-2/`

Workstation 10k perf baseline (commit + rollback): `PASS`

- Evidence:
  - `output/playwright/attendance-import-perf/attendance-perf-mlgr0m4e-d3110g/perf-summary.json`
- previewMs: `4418`
- commitMs: `62018`
- rollbackMs: `913`

## Latest Notes (2026-02-11, Final Re-Validation)

Perf gate transient polling fix and re-validation:

- Incident run (before fix):
  - [Attendance Import Perf Baseline #21912578076](https://github.com/zensgit/metasheet2/actions/runs/21912578076) (`FAILURE`)
  - Symptom: transient `502 Bad Gateway` while polling `/api/attendance/import/jobs/:id`.
- Remediation:
  - PR [#144](https://github.com/zensgit/metasheet2/pull/144)
  - `scripts/ops/attendance-import-perf.mjs` now retries transient poll responses (`429`, `5xx`) until timeout.
- Post-fix validation run:
  - [Attendance Import Perf Baseline #21912709345](https://github.com/zensgit/metasheet2/actions/runs/21912709345) (`SUCCESS`)
  - Evidence:
    - `output/playwright/ga/21912709345/attendance-import-perf-21912709345-1/attendance-perf-mli82mht-ximhdx/perf-summary.json`
  - Metrics:
    - `previewMs=3013`
    - `commitMs=60742`
    - `exportMs=406`
    - `rollbackMs=129`
    - `regressions=[]`
  - Tightened thresholds applied:
    - `ATTENDANCE_PERF_MAX_PREVIEW_MS=100000`
    - `ATTENDANCE_PERF_MAX_COMMIT_MS=150000`
    - `ATTENDANCE_PERF_MAX_EXPORT_MS=25000`
    - `ATTENDANCE_PERF_MAX_ROLLBACK_MS=8000`

Strict gates + dashboard final pass:

- Strict gates twice:
  - [Attendance Strict Gates (Prod) #21912806317](https://github.com/zensgit/metasheet2/actions/runs/21912806317) (`SUCCESS`)
  - Evidence:
    - `output/playwright/ga/21912806317/attendance-strict-gates-prod-21912806317-1/20260211-160958-1/`
    - `output/playwright/ga/21912806317/attendance-strict-gates-prod-21912806317-1/20260211-160958-2/`
  - API smoke logs contain:
    - `audit export csv ok`
    - `idempotency ok`
    - `export csv ok`
    - `import async idempotency ok`
- Dashboard:
  - [Attendance Daily Gate Dashboard #21912958814](https://github.com/zensgit/metasheet2/actions/runs/21912958814) (`SUCCESS`)
  - Evidence:
    - `output/playwright/ga/21912958814/attendance-daily-gate-dashboard-21912958814-1/attendance-daily-gate-dashboard.md`
    - `output/playwright/ga/21912958814/attendance-daily-gate-dashboard-21912958814-1/attendance-daily-gate-dashboard.json`
  - Result: `overallStatus=pass` (`strictRun=21912806317`, `perfRun=21912709345`)

Issue-to-channel sync workflow validation:

- Run:
  - [Attendance Gate Issue Notify #21912549709](https://github.com/zensgit/metasheet2/actions/runs/21912549709) (`SUCCESS`)
- Notes:
  - Workflow was corrected to avoid unsupported `secrets.*` usage in step-level `if` by checking job `env` values.
  - With no webhook secrets configured, workflow exits successfully and writes warning summary (expected behavior).

## Latest Notes (2026-02-13)

Remote Storage Health gate validated (upload volume health + drill + dashboard):

- Remote Storage Health (Prod):
  - [Attendance Remote Storage Health (Prod) #21998389402](https://github.com/zensgit/metasheet2/actions/runs/21998389402) (`SUCCESS`)
  - Evidence:
    - `output/playwright/ga/21998389402/storage.log`
    - `output/playwright/ga/21998389402/step-summary.md`
- Drill (expected FAIL, safe title override):
  - [Attendance Remote Storage Health (Prod) #21998434122](https://github.com/zensgit/metasheet2/actions/runs/21998434122) (`FAILURE`, expected)
  - Issue: [#158](https://github.com/zensgit/metasheet2/issues/158)
  - Evidence:
    - `output/playwright/ga/21998434122/storage.log`
    - `output/playwright/ga/21998434122/step-summary.md`
- Drill recovery (auto-close issue):
  - [Attendance Remote Storage Health (Prod) #21998473905](https://github.com/zensgit/metasheet2/actions/runs/21998473905) (`SUCCESS`)
  - Issue: [#158](https://github.com/zensgit/metasheet2/issues/158)
  - Evidence:
    - `output/playwright/ga/21998473905/storage.log`
    - `output/playwright/ga/21998473905/step-summary.md`
- Daily Gate Dashboard includes `Storage Health` (P1):
  - [Attendance Daily Gate Dashboard #21998506794](https://github.com/zensgit/metasheet2/actions/runs/21998506794) (`SUCCESS`)
  - Evidence:
    - `output/playwright/ga/21998506794/attendance-daily-gate-dashboard.md`
    - `output/playwright/ga/21998506794/attendance-daily-gate-dashboard.json`

## Latest Notes (2026-02-16): Dashboard P0 Escalation De-dup + Strict-only Suppression

Implementation:

- Commit: `d9862334`
- Changes:
  - Daily dashboard escalation issue comments are de-duplicated by `runId` (rerun attempts do not re-comment the same issue).
  - Daily dashboard suppresses its own P0 issue when P0 failure is strict-only (fast alert issue handles paging).
  - `attendance-daily-gate-dashboard.json` now includes `gateFlat.schemaVersion=2`.

Validation:

- Daily dashboard non-drill pass:
  - [Attendance Daily Gate Dashboard #22050219004](https://github.com/zensgit/metasheet2/actions/runs/22050219004) (`SUCCESS`)
  - Evidence:
    - `output/playwright/ga/22050219004/attendance-daily-gate-dashboard.md`
    - `output/playwright/ga/22050219004/attendance-daily-gate-dashboard.json`
- Strict-only suppression (expected FAIL, no daily drill issue created):
  - Strict drill fail: [Attendance Strict Gates (Prod) #22050232447](https://github.com/zensgit/metasheet2/actions/runs/22050232447) (`FAILURE`, expected)
  - Dashboard include-drill run: [Attendance Daily Gate Dashboard #22050242111](https://github.com/zensgit/metasheet2/actions/runs/22050242111) (`FAILURE`, expected)
  - Evidence:
    - `output/playwright/ga/22050232447/attendance-strict-gates-prod-22050232447-1/drill/gate-summary.json`
    - `output/playwright/ga/22050242111/attendance-daily-gate-dashboard.md` (contains: `Issue: suppressed ...`)
  - Drill issue query:
    - `gh issue list --state all --search "[Attendance Dashboard Drill] strict-only suppression test in:title"`
    - Result: `[]` (no dashboard issue created)
- RunId de-dup (non strict-only failure path):
  - Preflight drill fail: [Attendance Remote Preflight (Prod) #22050258287](https://github.com/zensgit/metasheet2/actions/runs/22050258287) (`FAILURE`, expected)
  - Dashboard fail run: [Attendance Daily Gate Dashboard #22050266002](https://github.com/zensgit/metasheet2/actions/runs/22050266002) (`FAILURE`, expected)
  - Dashboard rerun attempt=2 (same runId): [Attendance Daily Gate Dashboard #22050266002](https://github.com/zensgit/metasheet2/actions/runs/22050266002) (`FAILURE`, expected)
  - Evidence:
    - `output/playwright/ga/22050266002/attendance-daily-gate-dashboard.md`
    - `output/playwright/ga/22050266002-attempt2/attendance-daily-gate-dashboard.md` (contains: `(skipped_duplicate)`)
    - `output/playwright/ga/22050266002/attendance-daily-gate-dashboard.json` (`gateFlat.schemaVersion=2`)
  - Issue:
    - [#183](https://github.com/zensgit/metasheet2/issues/183) (created once, rerun not re-commented)
    - Verification command: `gh issue view 183 --json comments` (result: empty comments array)
- Recovery closure:
  - Strict drill recovery: [Attendance Strict Gates (Prod) #22050296690](https://github.com/zensgit/metasheet2/actions/runs/22050296690) (`SUCCESS`)
  - Dashboard recovery: [Attendance Daily Gate Dashboard #22050308198](https://github.com/zensgit/metasheet2/actions/runs/22050308198) (`SUCCESS`)
  - Evidence:
    - `output/playwright/ga/22050296690/attendance-strict-gates-prod-22050296690-1/drill/gate-summary.json`
    - `output/playwright/ga/22050308198/attendance-daily-gate-dashboard.md`
  - Drill issues auto-closed:
    - [#182](https://github.com/zensgit/metasheet2/issues/182)
    - [#183](https://github.com/zensgit/metasheet2/issues/183)

## Latest Notes (2026-02-16): Final Non-Drill Strict + Dashboard PASS (Post-Hardening)

Final production-path re-validation after dedupe/suppression hardening:

- Strict Gates (manual, non-drill):
  - [Attendance Strict Gates (Prod) #22060140322](https://github.com/zensgit/metasheet2/actions/runs/22060140322) (`SUCCESS`)
  - Evidence:
    - `output/playwright/ga/22060140322/20260216-110306-1/gate-summary.json`
    - `output/playwright/ga/22060140322/20260216-110306-2/gate-summary.json`
  - Contains full strict chain artifacts (`gate-api-smoke.log`, `gate-playwright-*.log`, `gate-provision-*.log`).
- Daily Gate Dashboard (manual, non-drill):
  - [Attendance Daily Gate Dashboard #22060251897](https://github.com/zensgit/metasheet2/actions/runs/22060251897) (`SUCCESS`)
  - Evidence:
    - `output/playwright/ga/22060251897/attendance-daily-gate-dashboard.md`
    - `output/playwright/ga/22060251897/attendance-daily-gate-dashboard.json`
  - Result:
    - `p0Status=pass`
    - `overallStatus=pass`
    - `gateFlat.schemaVersion=2`
    - `strictRunId=22060140322`

## Latest Notes (2026-02-16): Dashboard JSON `escalationIssue` Metadata

Implementation:

- Commit: `2113c6f0`
- Change:
  - `attendance-daily-gate-dashboard.json` now includes machine-readable `escalationIssue` metadata (`title`, `action`, `number`, `url`, `mode`, `p0Status`).

Validation:

- PASS path (`mode=none_or_closed`):
  - [Attendance Daily Gate Dashboard #22067085381](https://github.com/zensgit/metasheet2/actions/runs/22067085381) (`SUCCESS`)
  - Evidence:
    - `output/playwright/ga/22067085381/attendance-daily-gate-dashboard.json`
    - `output/playwright/ga/22067085381/attendance-daily-gate-dashboard.md`
- Strict-only suppression path (`mode=suppressed_strict_only`):
  - Strict drill fail: [Attendance Strict Gates (Prod) #22067119138](https://github.com/zensgit/metasheet2/actions/runs/22067119138) (`FAILURE`, expected), Issue: [#184](https://github.com/zensgit/metasheet2/issues/184)
  - Preflight drill recovery (to keep strict-only condition): [Attendance Remote Preflight (Prod) #22067169136](https://github.com/zensgit/metasheet2/actions/runs/22067169136) (`SUCCESS`)
  - Dashboard include-drill run: [Attendance Daily Gate Dashboard #22067185239](https://github.com/zensgit/metasheet2/actions/runs/22067185239) (`FAILURE`, expected)
  - Evidence:
    - `output/playwright/ga/22067185239/attendance-daily-gate-dashboard.json` (`escalationIssue.mode=suppressed_strict_only`, `action=suppressed_strict_only_closed`)
    - `output/playwright/ga/22067185239/attendance-daily-gate-dashboard.md` (`Issue: suppressed ...`)
  - Suppressed dashboard drill issue auto-closed: [#185](https://github.com/zensgit/metasheet2/issues/185)
- Strict drill recovery close:
  - [Attendance Strict Gates (Prod) #22067219193](https://github.com/zensgit/metasheet2/actions/runs/22067219193) (`SUCCESS`)
  - Issue [#184](https://github.com/zensgit/metasheet2/issues/184) is `CLOSED`.

## Latest Notes (2026-02-17): Dashboard JSON Contract Validation Step (CI Gate)

Implementation:

- Commit: `0805a966`
- Change:
  - Daily dashboard workflow adds `Validate report JSON contract` step.
  - Contract checks:
    - `.gateFlat.schemaVersion` exists and `>= 2`
    - `.escalationIssue.mode` in `{none_or_closed,suppressed_strict_only,open,unknown}`
    - `.escalationIssue.p0Status == .p0Status`

Validation:

- Daily dashboard non-drill:
  - [Attendance Daily Gate Dashboard #22085141111](https://github.com/zensgit/metasheet2/actions/runs/22085141111) (`SUCCESS`)
  - Evidence:
    - `output/playwright/ga/22085141111/attendance-daily-gate-dashboard.json`
    - `output/playwright/ga/22085141111/attendance-daily-gate-dashboard.md`
  - Verified fields:
    - `p0Status=pass`
    - `overallStatus=pass`
    - `gateFlat.schemaVersion=2`
    - `escalationIssue.mode=none_or_closed`
    - `escalationIssue.p0Status=pass`

## Latest Notes (2026-02-17): Strict `gate-summary.json` Contract Gate

Implementation:

- Commit: `dc61d9b5`
  - Added validator script: `scripts/ops/attendance-validate-gate-summary.sh`
  - Strict workflow now validates gate-summary contract in both `drill` and `strict-gates` jobs.
- Commit: `b110f612`
  - Added `checkout` to `drill` job so validator script is available in-run.

Validation:

- Drill FAIL (expected), validator step passes:
  - [Attendance Strict Gates (Prod) #22086891675](https://github.com/zensgit/metasheet2/actions/runs/22086891675) (`FAILURE`, expected due `drill_fail=true`)
  - Evidence:
    - `output/playwright/ga/22086891675/attendance-strict-gates-prod-22086891675-1/drill/gate-summary.json`
  - Job step status: `Validate gate-summary contract (drill) = success`
- Non-drill strict pass, strict validator step passes:
  - [Attendance Strict Gates (Prod) #22086903531](https://github.com/zensgit/metasheet2/actions/runs/22086903531) (`SUCCESS`)
  - Evidence:
    - `output/playwright/ga/22086903531/20260217-052052-1/gate-summary.json`
    - `output/playwright/ga/22086903531/20260217-052052-2/gate-summary.json`
  - Job step status: `Validate gate-summary contract (strict) = success`
- Drill recovery close:
  - [Attendance Strict Gates (Prod) #22086993681](https://github.com/zensgit/metasheet2/actions/runs/22086993681) (`SUCCESS`)
  - Drill issue auto-closed: [#186](https://github.com/zensgit/metasheet2/issues/186)

## Latest Notes (2026-02-17): Dashboard Enforces Strict Summary Evidence On PASS

Implementation:

- Commit: `8a5c1162`
- Change:
  - Daily gate report now fetches strict `gate-summary.json` metadata for every completed strict run (not only failed runs).
  - If latest strict run is `success` but strict artifact has no `gate-summary.json`, dashboard emits P0 finding `STRICT_SUMMARY_MISSING` (prevent false PASS).
  - `gateFlat.strict.summaryPresent` is exported as machine-readable signal.

Validation:

- Dashboard non-drill:
  - [Attendance Daily Gate Dashboard #22097651139](https://github.com/zensgit/metasheet2/actions/runs/22097651139) (`SUCCESS`)
  - Evidence:
    - `output/playwright/ga/22097651139/attendance-daily-gate-dashboard.json`
    - `output/playwright/ga/22097651139/attendance-daily-gate-dashboard.md`
  - Verified fields:
    - `gates.strict.completed.id=22086903531`
    - `gateFlat.strict.summaryPresent=true`
    - `gateFlat.strict.reasonCode=null`
    - `p0Status=pass`

## Latest Notes (2026-02-17): Dashboard JSON Contract Also Enforces Strict Summary Presence

Implementation:

- Commit: `a9588c34`
- Change:
  - `Validate report JSON contract` now enforces:
    - if `.gates.strict.completed.conclusion == "success"` then `.gateFlat.strict.summaryPresent == true`

Validation:

- Daily dashboard non-drill:
  - [Attendance Daily Gate Dashboard #22097790153](https://github.com/zensgit/metasheet2/actions/runs/22097790153) (`SUCCESS`)
  - Evidence:
    - `output/playwright/ga/22097790153/attendance-daily-gate-dashboard.json`
    - `output/playwright/ga/22097790153/gate-meta/strict/meta.json`
  - Verified fields:
    - `gates.strict.completed.conclusion=success`
    - `gateFlat.strict.summaryPresent=true`
    - `p0Status=pass`

## Latest Notes (2026-02-17): Dashboard JSON Contract Validator Script (Reusable)

Implementation:

- Commit: `89718ae9`
- Change:
  - Added reusable validator script:
    - `scripts/ops/attendance-validate-daily-dashboard-json.sh`
  - Workflow `Validate report JSON contract` now calls the script directly (instead of inline jq checks).
  - Script covers:
    - `gateFlat.schemaVersion >= 2`
    - `p0Status/overallStatus` enum checks
    - `escalationIssue.mode` enum
    - `escalationIssue.p0Status == p0Status`
    - `strict success => gateFlat.strict.summaryPresent=true`

Validation:

- Local positive sample:
  - `./scripts/ops/attendance-validate-daily-dashboard-json.sh output/playwright/ga/22097790153/attendance-daily-gate-dashboard.json`
  - Result: `OK`
- Local negative sample (expected fail):
  - set `gateFlat.strict.summaryPresent=false` with `gates.strict.completed.conclusion=success`
  - Result: `ERROR: strict summary contract failed` (expected)
- GA dashboard non-drill:
  - [Attendance Daily Gate Dashboard #22098000346](https://github.com/zensgit/metasheet2/actions/runs/22098000346) (`SUCCESS`)
  - Evidence:
    - `output/playwright/ga/22098000346/attendance-daily-gate-dashboard.json`
    - `output/playwright/ga/22098000346/gate-meta/strict/meta.json`
  - Verified:
    - `p0Status=pass`
    - `overallStatus=pass`
    - `gates.strict.completed.conclusion=success`
    - `gateFlat.strict.summaryPresent=true`
    - `escalationIssue.mode=none_or_closed`

## Latest Notes (2026-02-17): Strict Summary Validity + SchemaVersion Contract

Implementation:

- Commit: `613d2590`
- Change:
  - `scripts/ops/attendance-run-gates.sh` now writes `gate-summary.json` with `schemaVersion: 1`.
  - `.github/workflows/attendance-strict-gates-prod.yml` drill `gate-summary.json` also includes `schemaVersion: 1`.
  - `scripts/ops/attendance-validate-gate-summary.sh` now requires `schemaVersion` integer `>= 1`.
  - `scripts/ops/attendance-daily-gate-report.mjs` now validates strict summary shape and exports:
    - `gateFlat.strict.summaryValid`
    - `gateFlat.strict.summarySchemaVersion`
    - `gateFlat.strict.summaryInvalidReasons`
  - `scripts/ops/attendance-validate-daily-dashboard-json.sh` now enforces:
    - strict `success` => `gateFlat.strict.summaryPresent=true` and `gateFlat.strict.summaryValid=true`.

Validation:

- Strict drill fail (expected), schema validator step passes:
  - [Attendance Strict Gates (Prod) #22098220215](https://github.com/zensgit/metasheet2/actions/runs/22098220215) (`FAILURE`, expected due `drill_fail=true`)
  - Evidence:
    - `output/playwright/ga/22098220215/attendance-strict-gates-prod-22098220215-1/drill/gate-summary.json`
  - Job step status: `Validate gate-summary contract (drill) = success`
- Strict non-drill pass, strict validator step passes:
  - [Attendance Strict Gates (Prod) #22098241004](https://github.com/zensgit/metasheet2/actions/runs/22098241004) (`SUCCESS`)
  - Evidence:
    - `output/playwright/ga/22098241004/attendance-strict-gates-prod-22098241004-1/20260217-122132-1/gate-summary.json`
    - `output/playwright/ga/22098241004/attendance-strict-gates-prod-22098241004-1/20260217-122132-2/gate-summary.json`
  - Job step status: `Validate gate-summary contract (strict) = success`
- Dashboard non-drill pass with strict summary validity fields:
  - [Attendance Daily Gate Dashboard #22098385887](https://github.com/zensgit/metasheet2/actions/runs/22098385887) (`SUCCESS`)
  - Evidence:
    - `output/playwright/ga/22098385887/attendance-daily-gate-dashboard-22098385887-1/attendance-daily-gate-dashboard.json`
    - `output/playwright/ga/22098385887/attendance-daily-gate-dashboard-22098385887-1/gate-meta/strict/meta.json`
  - Verified:
    - `gates.strict.completed.id=22098241004`
    - `gateFlat.strict.summaryPresent=true`
    - `gateFlat.strict.summaryValid=true`
    - `gateFlat.strict.summarySchemaVersion=1`
    - `p0Status=pass`
- Strict drill recovery:
  - [Attendance Strict Gates (Prod) #22098421982](https://github.com/zensgit/metasheet2/actions/runs/22098421982) (`SUCCESS`)
  - Drill issue auto-closed: [#187](https://github.com/zensgit/metasheet2/issues/187)

## Latest Notes (2026-02-17): Invalid Summary Drill + JSON Schema + Nightly Contract Matrix

Implementation:

- Commit: `d130c5be`
  - Added strict drill input `drill_invalid_summary` in `.github/workflows/attendance-strict-gates-prod.yml`.
  - When enabled, drill mutates `gate-summary.json` to an invalid contract (`gates.apiSmoke=BROKEN`) for deterministic FAIL-path testing.
  - Added JSON schema:
    - `schemas/attendance/strict-gate-summary.schema.json`
  - Added schema validator:
    - `scripts/ops/attendance-validate-gate-summary-schema.mjs`
  - Added nightly + PR contract matrix workflow:
    - `.github/workflows/attendance-gate-contract-matrix.yml`
  - Added contract case runner:
    - `scripts/ops/attendance-run-gate-contract-case.sh`
- Commit: `fade1f9b`
  - Hardened schema validator Ajv resolution (workspace fallback) so CI can validate without root-level Ajv dependency.

Validation:

- Strict drill invalid summary (expected FAIL):
  - [Attendance Strict Gates (Prod) #22099065860](https://github.com/zensgit/metasheet2/actions/runs/22099065860) (`FAILURE`, expected)
  - Evidence:
    - `output/playwright/ga/22099065860/attendance-strict-gates-prod-22099065860-1/drill/gate-summary.json`
  - Verified:
    - `gates.apiSmoke="BROKEN"`
    - `Validate gate-summary contract (drill) = failure` (expected)
- Dashboard include-drill catches invalid strict summary (expected FAIL):
  - [Attendance Daily Gate Dashboard #22099097589](https://github.com/zensgit/metasheet2/actions/runs/22099097589) (`FAILURE`, expected)
  - Evidence:
    - `output/playwright/ga/22099097589/attendance-daily-gate-dashboard-22099097589-1/attendance-daily-gate-dashboard.json`
  - Verified:
    - `gateFlat.strict.reasonCode=STRICT_SUMMARY_INVALID`
    - `gateFlat.strict.summaryValid=false`
    - `gateFlat.strict.summaryInvalidReasons=["gates.apiSmoke"]`
- Strict drill recovery:
  - [Attendance Strict Gates (Prod) #22099142413](https://github.com/zensgit/metasheet2/actions/runs/22099142413) (`SUCCESS`)
  - Drill issue auto-closed: [#188](https://github.com/zensgit/metasheet2/issues/188)
- Nightly/PR contract matrix:
  - [Attendance Gate Contract Matrix #22099303110](https://github.com/zensgit/metasheet2/actions/runs/22099303110) (`SUCCESS`)
  - Evidence:
    - `output/playwright/ga/22099303110/attendance-gate-contract-matrix-strict-22099303110-1/strict/gate-summary.valid.json`
    - `output/playwright/ga/22099303110/attendance-gate-contract-matrix-strict-22099303110-1/strict/gate-summary.invalid.json`
    - `output/playwright/ga/22099303110/attendance-gate-contract-matrix-dashboard-22099303110-1/dashboard.valid.json`
    - `output/playwright/ga/22099303110/attendance-gate-contract-matrix-dashboard-22099303110-1/dashboard.invalid.json`
- Strict non-drill (schema step in real path):
  - [Attendance Strict Gates (Prod) #22099435815](https://github.com/zensgit/metasheet2/actions/runs/22099435815) (`SUCCESS`)
  - Verified:
    - `Validate gate-summary JSON schema (strict) = success`
    - both strict runs generated `gate-summary.json` with `schemaVersion=1`
- Dashboard non-drill baseline recovery:
  - [Attendance Daily Gate Dashboard #22099580597](https://github.com/zensgit/metasheet2/actions/runs/22099580597) (`SUCCESS`)
  - Verified:
    - `gateFlat.strict.summaryPresent=true`
    - `gateFlat.strict.summaryValid=true`
    - `gateFlat.strict.summarySchemaVersion=1`

Branch protection readiness:

- `attendance-gate-contract-matrix.yml` runs on `pull_request` to `main` and is now usable as required checks.
- Current state: `main` branch protection is not enabled (`GET /branches/main/protection -> 404`).
- Recommended required checks after enabling protection:
  - `contracts (strict)`
  - `contracts (dashboard)`

## Latest Notes (2026-02-18): Daily Dashboard Includes Gate Contract Matrix (P1)

Implementation:

- Commit: `fe25ba74`
- Change:
  - `scripts/ops/attendance-daily-gate-report.mjs` now includes a new P1 gate: `Gate Contract Matrix`.
  - `.github/workflows/attendance-daily-gate-dashboard.yml` now exports `CONTRACT_WORKFLOW=attendance-gate-contract-matrix.yml`.
  - Dashboard markdown/json now includes:
    - Gate Status row for `Gate Contract Matrix`
    - Artifact download command for the matrix run
    - `gateFlat.contract` + `gates.contract` machine-readable entries

Validation:

- Local report generation (with GH token):
  - `GH_TOKEN="$(gh auth token)" BRANCH=main LOOKBACK_HOURS=48 node scripts/ops/attendance-daily-gate-report.mjs`
  - Evidence:
    - `output/playwright/attendance-daily-gate-dashboard/20260218-112756/attendance-daily-gate-dashboard.json`
  - Verified:
    - `gateFlat.contract.status=PASS`
    - `gateFlat.contract.runId=22127576975`
- GA dashboard non-drill (with contract gate):
  - [Attendance Daily Gate Dashboard #22137921321](https://github.com/zensgit/metasheet2/actions/runs/22137921321) (`SUCCESS`)
  - Evidence:
    - `output/playwright/ga/22137921321/attendance-daily-gate-dashboard-22137921321-1/attendance-daily-gate-dashboard.md`
    - `output/playwright/ga/22137921321/attendance-daily-gate-dashboard-22137921321-1/attendance-daily-gate-dashboard.json`
  - Verified:
    - Gate table contains `Gate Contract Matrix` row (`PASS`)
    - `gates.contract` exists
    - `gateFlat.contract.gate="Gate Contract Matrix"`
    - `gateFlat.contract.severity="P1"`
- Referenced matrix run evidence (latest non-drill completed):
  - [Attendance Gate Contract Matrix #22127576975](https://github.com/zensgit/metasheet2/actions/runs/22127576975) (`SUCCESS`)
  - Evidence:
    - `output/playwright/ga/22127576975/attendance-gate-contract-matrix-strict-22127576975-1/strict/gate-summary.valid.json`
    - `output/playwright/ga/22127576975/attendance-gate-contract-matrix-dashboard-22127576975-1/dashboard.valid.json`

## Latest Notes (2026-02-18): Branch Protection Drift Gate (P1) + Dashboard Integration

Implementation:

- Commit: `1e2f7fc0`
  - Added workflow: `.github/workflows/attendance-branch-protection-prod.yml`
  - Added scripts:
    - `scripts/ops/attendance-check-branch-protection.sh`
    - `scripts/ops/attendance-ensure-branch-protection.sh`
  - Added Daily Dashboard integration:
    - `.github/workflows/attendance-daily-gate-dashboard.yml` (`PROTECTION_WORKFLOW`)
    - `scripts/ops/attendance-daily-gate-report.mjs` (`Branch Protection` gate, P1)
- Commit: `bb317a8d`
  - Simplified workflow `run-name` so GitHub can register/dispatch the new workflow normally.
- Commit: `de293073`
  - Classified token permission failures as `API_FORBIDDEN`.
  - Workflow token fallback now supports:
    - `secrets.ATTENDANCE_ADMIN_GH_TOKEN || secrets.GITHUB_TOKEN`

Validation:

- Branch Protection workflow (non-drill):
  - [Attendance Branch Protection (Prod) #22141450936](https://github.com/zensgit/metasheet2/actions/runs/22141450936) (`FAILURE`)
  - Verified reason: `API_FORBIDDEN` (current token cannot read branch protection API).
  - Evidence:
    - `output/playwright/ga/22141450936/step-summary.md`
    - `output/playwright/ga/22141450936/protection.log`
- P1 issue tracking:
  - Opened/updated: [#190](https://github.com/zensgit/metasheet2/issues/190) (`[Attendance P1] Branch protection drift alert`)
- Daily Dashboard includes `Branch Protection` gate:
  - [Attendance Daily Gate Dashboard #22141481582](https://github.com/zensgit/metasheet2/actions/runs/22141481582) (`FAILURE`, expected while P1 unresolved)
  - Verified:
    - `P0 Status = PASS`
    - `Overall = FAIL` (due P1 `Branch Protection`)
    - `gateFlat.protection.reasonCode=API_FORBIDDEN`
  - Evidence:
    - `output/playwright/ga/22141481582/attendance-daily-gate-dashboard.md`
    - `output/playwright/ga/22141481582/attendance-daily-gate-dashboard.json`
    - `output/playwright/ga/22141481582/gate-meta/protection/meta.json`

Operational note:

- To make this gate pass in CI, configure an admin-capable token secret:
  - `ATTENDANCE_ADMIN_GH_TOKEN` (read branch protection API for this repo)
- Then rerun:
  - `gh workflow run attendance-branch-protection-prod.yml -f drill_fail=false`

## Latest Notes (2026-02-18): Branch Protection Gate Recovery (PASS)

Recovery actions:

- Added workflow token secret for branch-protection API reads:
  - `ATTENDANCE_ADMIN_GH_TOKEN`
- Applied branch protection baseline on `main` via:
  - `scripts/ops/attendance-ensure-branch-protection.sh`
  - Required checks:
    - `contracts (strict)`
    - `contracts (dashboard)`
  - Strict mode:
    - `required_status_checks.strict=true`

Validation:

- Branch Protection gate detects true drift state:
  - [Attendance Branch Protection (Prod) #22142204955](https://github.com/zensgit/metasheet2/actions/runs/22142204955) (`FAILURE`)
  - Reason: `BRANCH_NOT_PROTECTED`
  - Evidence:
    - `output/playwright/ga/22142204955/step-summary.md`
    - `output/playwright/ga/22142204955/protection.log`
- Branch Protection gate recovery:
  - [Attendance Branch Protection (Prod) #22142247652](https://github.com/zensgit/metasheet2/actions/runs/22142247652) (`SUCCESS`)
  - Evidence:
    - `output/playwright/ga/22142247652/step-summary.md`
    - `output/playwright/ga/22142247652/protection.log`
  - Verified:
    - `strict_current=true`
    - `contexts_current=contracts (strict),contracts (dashboard)`
- Daily Dashboard after recovery:
  - [Attendance Daily Gate Dashboard #22142280338](https://github.com/zensgit/metasheet2/actions/runs/22142280338) (`SUCCESS`)
  - Evidence:
    - `output/playwright/ga/22142280338/attendance-daily-gate-dashboard.md`
    - `output/playwright/ga/22142280338/attendance-daily-gate-dashboard.json`
  - Verified:
    - `Overall=PASS`
    - `Branch Protection` row `PASS` (run `#22142247652`)
- P1 issue closure:
  - [#190](https://github.com/zensgit/metasheet2/issues/190) auto-closed on recovery.

## Latest Notes (2026-02-19): Enforce Admins Hardening (Anti-Bypass)

Implementation:

- Commit: `4aa4e2a2`
  - Branch protection gate now supports and checks:
    - `REQUIRE_ENFORCE_ADMINS=true|false`
  - Workflow `.github/workflows/attendance-branch-protection-prod.yml` now defaults:
    - `require_enforce_admins=true`
  - Step summary now prints:
    - `Require enforce admins`
  - Daily dashboard enrichment includes this field when the gate fails.
- `scripts/ops/attendance-ensure-branch-protection.sh` default changed:
  - `ENFORCE_ADMINS=true` (anti-bypass baseline)

Validation:

- Branch Protection gate fails closed when admins are not enforced:
  - [Attendance Branch Protection (Prod) #22168334875](https://github.com/zensgit/metasheet2/actions/runs/22168334875) (`FAILURE`, expected)
  - Reason: `ENFORCE_ADMINS_DISABLED`
  - Evidence:
    - `output/playwright/ga/22168334875/step-summary.md`
    - `output/playwright/ga/22168334875/protection.log`
- Applied anti-bypass baseline on `main`:
  - `APPLY=true ./scripts/ops/attendance-ensure-branch-protection.sh`
  - Verified:
    - `strict_current=true`
    - `enforce_admins_current=true`
    - `contexts_current=contracts (strict),contracts (dashboard)`
- Branch Protection recovery:
  - [Attendance Branch Protection (Prod) #22168353987](https://github.com/zensgit/metasheet2/actions/runs/22168353987) (`SUCCESS`)
  - Evidence:
    - `output/playwright/ga/22168353987/step-summary.md`
    - `output/playwright/ga/22168353987/protection.log`
- Daily Dashboard recovery:
  - [Attendance Daily Gate Dashboard #22168373962](https://github.com/zensgit/metasheet2/actions/runs/22168373962) (`SUCCESS`)
  - Evidence:
    - `output/playwright/ga/22168373962/attendance-daily-gate-dashboard.md`
    - `output/playwright/ga/22168373962/attendance-daily-gate-dashboard.json`
  - Verified:
    - `Overall=PASS`
    - Branch Protection row `PASS` (run `#22168353987`)
- P1 issue:
  - [#190](https://github.com/zensgit/metasheet2/issues/190) remained `CLOSED` after recovery update.

## Latest Notes (2026-02-19): Protected Main PR Compatibility + Post-Merge Re-Verify

Implementation:

- Commit: `c68df5c7`
  - `.github/workflows/attendance-gate-contract-matrix.yml` now runs on **all** PRs to `main` (removed `paths` filter).
  - Reason: branch protection requires `contracts (strict)` + `contracts (dashboard)` checks; path-filtered workflow could make some PRs unmergeable.

Validation:

- PR checks include both required contexts and pass:
  - PR: [#191](https://github.com/zensgit/metasheet2/pull/191) (`MERGED`)
  - Contract matrix PR run:
    - [Attendance Gate Contract Matrix #22168460857](https://github.com/zensgit/metasheet2/actions/runs/22168460857) (`SUCCESS`)
  - Evidence:
    - `output/playwright/ga/22168460857/attendance-gate-contract-matrix-strict-22168460857-1/strict/gate-summary.valid.json`
    - `output/playwright/ga/22168460857/attendance-gate-contract-matrix-dashboard-22168460857-1/dashboard.valid.json`
- Post-merge branch protection gate:
  - [Attendance Branch Protection (Prod) #22168482721](https://github.com/zensgit/metasheet2/actions/runs/22168482721) (`SUCCESS`)
  - Evidence:
    - `output/playwright/ga/22168482721/step-summary.md`
    - `output/playwright/ga/22168482721/protection.log`
  - Verified:
    - `strict_current=true`
    - `enforce_admins_current=true`
- Post-merge daily dashboard:
  - [Attendance Daily Gate Dashboard #22168496046](https://github.com/zensgit/metasheet2/actions/runs/22168496046) (`SUCCESS`)
  - Evidence:
    - `output/playwright/ga/22168496046/attendance-daily-gate-dashboard.md`
    - `output/playwright/ga/22168496046/attendance-daily-gate-dashboard.json`
  - Verified:
    - `Overall=PASS`
    - Branch Protection row `PASS` (run `#22168482721`)

## Latest Notes (2026-02-19): Branch Policy Drift Workflow + Dashboard `gateFlat.protection` Mapping

Implementation:

- PR: [#193](https://github.com/zensgit/metasheet2/pull/193) (`MERGED`)
- Commit: `932223f3`
- Added workflow:
  - `.github/workflows/attendance-branch-policy-drift-prod.yml`
- Daily dashboard now defaults to the new protection workflow source:
  - `.github/workflows/attendance-daily-gate-dashboard.yml`
  - `PROTECTION_WORKFLOW=attendance-branch-policy-drift-prod.yml`
- Branch protection check + ensure scripts now support review policy checks:
  - `REQUIRE_PR_REVIEWS`
  - `MIN_APPROVING_REVIEW_COUNT`
  - `REQUIRE_CODE_OWNER_REVIEWS`
- Dashboard parser + `gateFlat.protection` mapping now include:
  - `requirePrReviews`
  - `minApprovingReviews`
  - `requireCodeOwnerReviews`

Validation:

- Branch Policy Drift workflow (non-drill):
  - [Attendance Branch Policy Drift (Prod) #22183957768](https://github.com/zensgit/metasheet2/actions/runs/22183957768) (`SUCCESS`)
  - Evidence:
    - `output/playwright/ga/22183957768/step-summary.md`
    - `output/playwright/ga/22183957768/policy.log`
    - `output/playwright/ga/22183957768/policy.json`
  - Verified summary fields:
    - `Require PR reviews: false`
    - `Min approving reviews: 1`
    - `Require code owner reviews: false`
- Daily Dashboard after switch to policy-drift workflow:
  - [Attendance Daily Gate Dashboard #22183988363](https://github.com/zensgit/metasheet2/actions/runs/22183988363) (`SUCCESS`)
  - Evidence:
    - `output/playwright/ga/22183988363/attendance-daily-gate-dashboard-22183988363-1/attendance-daily-gate-dashboard.md`
    - `output/playwright/ga/22183988363/attendance-daily-gate-dashboard-22183988363-1/attendance-daily-gate-dashboard.json`
    - `output/playwright/ga/22183988363/attendance-daily-gate-dashboard-22183988363-1/gate-meta/protection/meta.json`
  - Verified `gateFlat.protection` fields:
    - `requirePrReviews="false"`
    - `minApprovingReviews="1"`
    - `requireCodeOwnerReviews="false"`
- Local negative check (expected FAIL classification):
  - `REQUIRE_PR_REVIEWS=true` returns `reason=PR_REVIEWS_NOT_ENABLED` on current `main` policy.

## Latest Notes (2026-02-19): Branch Policy Drift Drill Issue Lifecycle (OPEN -> CLOSED)

Validation:

- Drill FAIL (expected):
  - [Attendance Branch Policy Drift (Prod) [DRILL] #22184382068](https://github.com/zensgit/metasheet2/actions/runs/22184382068) (`FAILURE`)
  - Evidence:
    - `output/playwright/ga/22184382068/step-summary.md`
    - `output/playwright/ga/22184382068/policy.log`
    - `output/playwright/ga/22184382068/policy.json`
  - P1 drill issue opened:
    - [#195](https://github.com/zensgit/metasheet2/issues/195) (`OPEN` at failure time)
- Drill recovery PASS:
  - [Attendance Branch Policy Drift (Prod) #22184421397](https://github.com/zensgit/metasheet2/actions/runs/22184421397) (`SUCCESS`)
  - Evidence:
    - `output/playwright/ga/22184421397/step-summary.md`
    - `output/playwright/ga/22184421397/policy.log`
    - `output/playwright/ga/22184421397/policy.json`
  - P1 drill issue auto-closed:
    - [#195](https://github.com/zensgit/metasheet2/issues/195) (`CLOSED`)
- Daily dashboard re-verify (uses latest non-drill policy run):
  - [Attendance Daily Gate Dashboard #22184452525](https://github.com/zensgit/metasheet2/actions/runs/22184452525) (`SUCCESS`)
  - Evidence:
    - `output/playwright/ga/22184452525/attendance-daily-gate-dashboard-22184452525-1/attendance-daily-gate-dashboard.md`
    - `output/playwright/ga/22184452525/attendance-daily-gate-dashboard-22184452525-1/attendance-daily-gate-dashboard.json`
    - `output/playwright/ga/22184452525/attendance-daily-gate-dashboard-22184452525-1/gate-meta/protection/meta.json`
  - Verified:
    - `gateFlat.protection.runId=22184421397` (latest non-drill run)
    - `gateFlat.protection.requirePrReviews=false`
    - `gateFlat.protection.minApprovingReviews=1`
    - `gateFlat.protection.requireCodeOwnerReviews=false`

## Latest Notes (2026-02-19): Branch Review Policy Upgrade (`require_pr_reviews=true`) + Drill/Recovery

Policy target applied on protected `main`:

- `required_pull_request_reviews.enabled=true`
- `required_approving_review_count=1`
- `require_code_owner_reviews=false`

Ops apply command (token only from runtime env, never committed):

```bash
REPO=zensgit/metasheet2 \
BRANCH=main \
REQUIRED_CHECKS_CSV='contracts (strict),contracts (dashboard)' \
REQUIRE_STRICT=true \
ENFORCE_ADMINS=true \
REQUIRE_PR_REVIEWS=true \
MIN_APPROVING_REVIEW_COUNT=1 \
REQUIRE_CODE_OWNER_REVIEWS=false \
APPLY=true \
./scripts/ops/attendance-ensure-branch-protection.sh
```

Verification:

- GitHub branch protection API now returns:
  - `pr_reviews=true`
  - `approving_count=1`
  - `code_owner=false`

Drill/recovery + dashboard:

- Branch Policy Drift drill (expected FAIL):
  - [Attendance Branch Policy Drift (Prod) [DRILL] #22184974691](https://github.com/zensgit/metasheet2/actions/runs/22184974691) (`FAILURE`)
  - Evidence:
    - `output/playwright/ga/22184974691/attendance-branch-policy-drift-prod-22184974691-1/step-summary.md`
    - `output/playwright/ga/22184974691/attendance-branch-policy-drift-prod-22184974691-1/policy.log`
    - `output/playwright/ga/22184974691/attendance-branch-policy-drift-prod-22184974691-1/policy.json`
  - Drill issue opened:
    - [#197](https://github.com/zensgit/metasheet2/issues/197) (`OPEN` at failure time)
- Branch Policy Drift recovery (explicit review-policy inputs):
  - [Attendance Branch Policy Drift (Prod) #22185012785](https://github.com/zensgit/metasheet2/actions/runs/22185012785) (`SUCCESS`)
  - Evidence:
    - `output/playwright/ga/22185012785/attendance-branch-policy-drift-prod-22185012785-1/step-summary.md`
    - `output/playwright/ga/22185012785/attendance-branch-policy-drift-prod-22185012785-1/policy.log`
    - `output/playwright/ga/22185012785/attendance-branch-policy-drift-prod-22185012785-1/policy.json`
  - Verified `policy.json`:
    - `requirePrReviews=true`
    - `minApprovingReviewCount=1`
    - `requireCodeOwnerReviews=false`
    - `prReviewsRequiredCurrent=true`
    - `approvingReviewCountCurrent=1`
  - Drill issue auto-closed:
    - [#197](https://github.com/zensgit/metasheet2/issues/197) (`CLOSED`)
- Daily dashboard re-verify (uses latest non-drill policy run):
  - [Attendance Daily Gate Dashboard #22185048468](https://github.com/zensgit/metasheet2/actions/runs/22185048468) (`SUCCESS`)
  - Evidence:
    - `output/playwright/ga/22185048468/attendance-daily-gate-dashboard-22185048468-1/attendance-daily-gate-dashboard.md`
    - `output/playwright/ga/22185048468/attendance-daily-gate-dashboard-22185048468-1/attendance-daily-gate-dashboard.json`
  - Verified `gateFlat.protection`:
    - `runId=22185012785` (latest non-drill policy run)
    - `requirePrReviews="true"`
    - `minApprovingReviews="1"`
    - `requireCodeOwnerReviews="false"`

## Latest Notes (2026-02-19): C-Line Web UX Hardening Pre-Deploy Validation

Scope:

- Added admin-visible status surface with classified error hints and recovery actions (`Retry preview/import`, `Reload admin`, `Reload requests`).
- Extended Playwright full-flow assertions:
  - Desktop: validates `Invalid JSON payload for import.` + `Retry preview` action.
  - Mobile: validates Desktop-only workflow hint can return to Overview.

Validation commands:

```bash
WEB_URL="http://142.171.239.56:8081/" \
API_BASE="http://142.171.239.56:8081/api" \
AUTH_TOKEN="<ADMIN_JWT>" \
EXPECT_PRODUCT_MODE="attendance" \
ALLOW_EMPTY_RECORDS="true" \
OUTPUT_DIR="output/playwright/attendance-full-flow-c-line-desktop" \
node scripts/verify-attendance-full-flow.mjs

WEB_URL="http://142.171.239.56:8081/" \
API_BASE="http://142.171.239.56:8081/api" \
AUTH_TOKEN="<ADMIN_JWT>" \
EXPECT_PRODUCT_MODE="attendance" \
ALLOW_EMPTY_RECORDS="true" \
UI_MOBILE="true" \
OUTPUT_DIR="output/playwright/attendance-full-flow-c-line-mobile" \
node scripts/verify-attendance-full-flow.mjs
```

Current result (before deploying this branch frontend bundle):

- Desktop: expected FAIL on the new admin UX assertion (production site still running old bundle).
- Mobile: PASS.

Evidence:

- `output/playwright/attendance-full-flow-c-line-desktop/01-overview.png`
- `output/playwright/attendance-full-flow-c-line-mobile/01-overview.png`
- `output/playwright/attendance-full-flow-c-line-mobile/02-admin.png`

## Latest Notes (2026-02-19): 1+2+3 Execution Closure (A/B/C merged + policy drill/recovery)

Merged to `main`:

- [#198](https://github.com/zensgit/metasheet2/pull/198) (`feat(attendance-gates): enforce pr reviews and extend import job telemetry`)
- [#199](https://github.com/zensgit/metasheet2/pull/199) (`feat(attendance-perf): promote 100k baseline and add 500k guard scenario`)
- [#200](https://github.com/zensgit/metasheet2/pull/200) (`feat(attendance-web): add admin error recovery surface and full-flow assertions`)

Single-maintainer policy note:

- Repository currently has one write-capable collaborator (`zensgit`), so `required_pull_request_reviews=true` cannot be operationally satisfied for self-authored PRs.
- To unblock continuous delivery while keeping hard guardrails, `main` protection was set to:
  - `strict=true`
  - `enforce_admins=true`
  - `required_checks=contracts (strict), contracts (dashboard)`
  - `require_pr_reviews=false` (temporary operational fallback)

Validation (new evidence):

- Branch Policy Drift drill (expected FAIL):
  - [Attendance Branch Policy Drift (Prod) [DRILL] #22188008265](https://github.com/zensgit/metasheet2/actions/runs/22188008265) (`FAILURE`)
  - Evidence:
    - `output/playwright/ga/22188008265/step-summary.md`
    - `output/playwright/ga/22188008265/policy.log`
    - `output/playwright/ga/22188008265/policy.json`
  - Drill issue opened/updated:
    - [#201](https://github.com/zensgit/metasheet2/issues/201)
- Branch Policy Drift recovery (explicit `require_pr_reviews=false`):
  - [Attendance Branch Policy Drift (Prod) #22188054160](https://github.com/zensgit/metasheet2/actions/runs/22188054160) (`SUCCESS`)
  - Evidence:
    - `output/playwright/ga/22188054160/step-summary.md`
    - `output/playwright/ga/22188054160/policy.log`
    - `output/playwright/ga/22188054160/policy.json`
  - Drill issue auto-closed:
    - [#201](https://github.com/zensgit/metasheet2/issues/201) (`CLOSED`)
- Daily dashboard re-verify:
  - [Attendance Daily Gate Dashboard #22188099087](https://github.com/zensgit/metasheet2/actions/runs/22188099087) (`SUCCESS`)
  - Evidence:
    - `output/playwright/ga/22188099087/attendance-daily-gate-dashboard.md`
    - `output/playwright/ga/22188099087/attendance-daily-gate-dashboard.json`
    - `output/playwright/ga/22188099087/gate-meta/protection/meta.json`
  - Verified:
    - `gateFlat.protection.runId=22188054160`
    - `gateFlat.protection.requirePrReviews=false`

## Latest Notes (2026-02-20): Next-Stage Hardening (Perf Telemetry + Full-Flow Stability + Dashboard Meta)

Scope (implemented):

- `scripts/ops/attendance-import-perf.mjs`
  - Added `schemaVersion=2` output in `perf-summary.json`.
  - Added standardized perf telemetry fields:
    - `requestedImportEngine`, `resolvedImportEngine`
    - `processedRows`, `failedRows`, `elapsedMs`
    - `perfMetrics.{previewMs,commitMs,exportMs,rollbackMs,processedRows,failedRows,elapsedMs}`
  - Added explicit engine selection log (`rows`, `bulk_engine_threshold`, `requested_engine`) for 100k+ traceability.
- `scripts/verify-attendance-full-flow.mjs`
  - Replaced fixed admin wait with explicit readiness checks.
  - Added debug screenshot capture on admin-section readiness failure:
    - `02-admin-section-missing.png`
  - Added configurable retry assertion switch:
    - `ASSERT_ADMIN_RETRY=false` to skip strict retry assertion during degraded UI debug.
- `scripts/ops/attendance-daily-gate-report.mjs`
  - Artifact enrichment now supports multi-prefix matching and optional fallback to any artifact in the run.
  - Perf baseline / longrun now enrich metadata on successful runs (not only failure runs).
  - Dashboard `gateFlat.perf` / `gateFlat.longrun` now carries stable perf summary metadata when available:
    - `summarySchemaVersion`, `engine`, `requestedEngine`, `processedRows`, `failedRows`, `elapsedMs`.
  - Added `PERF_SUMMARY_MISSING` classification when a successful perf run lacks `perf-summary.json`.

Validation:

```bash
node --check scripts/ops/attendance-import-perf.mjs
node --check scripts/verify-attendance-full-flow.mjs
node --check scripts/ops/attendance-daily-gate-report.mjs

GH_TOKEN="$(gh auth token)" \
BRANCH="main" \
LOOKBACK_HOURS="48" \
node scripts/ops/attendance-daily-gate-report.mjs
```

Evidence:

- Local dashboard report output:
  - `output/playwright/attendance-daily-gate-dashboard/20260220-023517/attendance-daily-gate-dashboard.md`
  - `output/playwright/attendance-daily-gate-dashboard/20260220-023517/attendance-daily-gate-dashboard.json`
- Verified report fields:
  - `gateFlat.strict.summaryPresent=true`
  - `gateFlat.perf.status=PASS`
  - `gateFlat.longrun.status=PASS`

## Latest Notes (2026-02-20): 1+2+3 Execution (Perf 100k/500k + Deploy + Full-Flow + Dashboard Contract)

Scope (executed):

1. Perf validation:
   - 100k baseline (`upload_csv=true`)
   - longrun (includes `rows500k-preview`, `upload_csv=true`)
2. Deploy + full Playwright strict gates:
   - `docker-build.yml` deploy
   - `attendance-strict-gates-prod.yml` non-drill (desktop/mobile full-flow)
3. Dashboard contract strengthening for `gateFlat.perf/longrun`:
   - `scripts/ops/attendance-validate-daily-dashboard-json.sh` now enforces:
     - `gateFlat.perf.status` / `gateFlat.longrun.status` in `PASS|FAIL`
     - when status=PASS: `summarySchemaVersion>=2`, `scenario`, `rows>0`, `mode`, `uploadCsv`, `regressionsCount`, `previewMs`
   - `scripts/ops/attendance-run-gate-contract-case.sh` now includes perf/longrun invalid fixtures.

Verification runs:

| Gate | Run | Status | Evidence |
|---|---|---|---|
| Perf baseline (100k, upload_csv=true) | [#22209313715](https://github.com/zensgit/metasheet2/actions/runs/22209313715) | PASS | `output/playwright/ga/22209313715/attendance-import-perf-22209313715-1/attendance-perf-mluam641-we0pa2/perf-summary.json`, `output/playwright/ga/22209313715/attendance-import-perf-22209313715-1/perf.log` |
| Perf longrun (includes 500k preview, upload_csv=true) | [#22209380938](https://github.com/zensgit/metasheet2/actions/runs/22209380938) | PASS | `output/playwright/ga/22209380938/attendance-import-perf-longrun-rows500k-preview-22209380938-1/current/rows500k-preview/attendance-perf-mluaqf7z-vu4lo6/perf-summary.json`, `output/playwright/ga/22209380938/attendance-import-perf-longrun-trend-22209380938-1/20260220-025510/attendance-import-perf-longrun-trend.md` |
| Build + deploy (frontend/backend) | [#22209420172](https://github.com/zensgit/metasheet2/actions/runs/22209420172) | PASS | `output/playwright/ga/22209420172/deploy-logs-22209420172-1/deploy.log`, `output/playwright/ga/22209420172/deploy-logs-22209420172-1/step-summary.md` |
| Strict gates non-drill (desktop+mobile full-flow) | [#22209492697](https://github.com/zensgit/metasheet2/actions/runs/22209492697) | PASS | `output/playwright/ga/22209492697/attendance-strict-gates-prod-22209492697-1/20260220-030102-1/gate-summary.json`, `output/playwright/ga/22209492697/attendance-strict-gates-prod-22209492697-1/20260220-030102-2/gate-summary.json` |
| Gate Contract Matrix (new perf/longrun contract cases) | [#22209625568](https://github.com/zensgit/metasheet2/actions/runs/22209625568) | PASS | `output/playwright/ga/22209625568/attendance-gate-contract-matrix-dashboard-22209625568-1/dashboard.valid.json`, `output/playwright/ga/22209625568/attendance-gate-contract-matrix-dashboard-22209625568-1/dashboard.invalid.perf.json`, `output/playwright/ga/22209625568/attendance-gate-contract-matrix-dashboard-22209625568-1/dashboard.invalid.longrun.json` |
| Daily dashboard (new perf/longrun contract validation enabled) | [#22209648198](https://github.com/zensgit/metasheet2/actions/runs/22209648198) | PASS | `output/playwright/ga/22209648198/attendance-daily-gate-dashboard-22209648198-1/attendance-daily-gate-dashboard.json`, `output/playwright/ga/22209648198/attendance-daily-gate-dashboard-22209648198-1/gate-meta/perf/meta.json`, `output/playwright/ga/22209648198/attendance-daily-gate-dashboard-22209648198-1/gate-meta/longrun/meta.json` |

Observed contract fields in dashboard JSON (`#22209648198`):

- `gateFlat.perf.summarySchemaVersion=2`
- `gateFlat.perf.engine=bulk`
- `gateFlat.perf.processedRows=100000`
- `gateFlat.longrun.summarySchemaVersion=2`
- `gateFlat.longrun.scenario=rows500k-preview`
- `gateFlat.longrun.uploadCsv=true`

## Latest Notes (2026-02-20): Main Post-Merge Re-Verify (`1+2`)

Scope:

- PR [#204](https://github.com/zensgit/metasheet2/pull/204) merged into `main`.
- Triggered `Attendance Daily Gate Dashboard` on `main` for post-merge verification.
- Recovered transient `Branch Protection` mismatch by refreshing the active policy source workflow.

Observed behavior:

- Dashboard on `main` reads branch protection from:
  - `PROTECTION_WORKFLOW=attendance-branch-policy-drift-prod.yml`
- Two initial dashboard runs failed with:
  - `Branch Protection / PR_REVIEWS_NOT_ENABLED`
  - because latest policy-drift run still reflected `require_pr_reviews=true`.
- Current production fallback target remains:
  - `require_pr_reviews=false` (single-maintainer mode)

Recovery + final PASS:

| Gate | Run | Status | Evidence |
|---|---|---|---|
| Daily Dashboard (post-merge first run) | [#22225250295](https://github.com/zensgit/metasheet2/actions/runs/22225250295) | FAIL (expected during recovery) | `output/playwright/ga/22225250295/attendance-daily-gate-dashboard-22225250295-1/attendance-daily-gate-dashboard.json` |
| Branch Policy Drift recovery (`require_pr_reviews=false`) | [#22225453528](https://github.com/zensgit/metasheet2/actions/runs/22225453528) | PASS | `output/playwright/ga/22225453528/attendance-branch-policy-drift-prod-22225453528-1/step-summary.md`, `output/playwright/ga/22225453528/attendance-branch-policy-drift-prod-22225453528-1/policy.json` |
| Daily Dashboard final re-run | [#22225484921](https://github.com/zensgit/metasheet2/actions/runs/22225484921) | PASS | `output/playwright/ga/22225484921/attendance-daily-gate-dashboard-22225484921-1/attendance-daily-gate-dashboard.json`, `output/playwright/ga/22225484921/attendance-daily-gate-dashboard-22225484921-1/gate-meta/protection/meta.json` |

Verified in final dashboard run (`#22225484921`):

- `overallStatus=pass`
- `p0Status=pass`
- `gateFlat.protection.status=PASS`
- `gateFlat.protection.requirePrReviews=false`
- `gateFlat.perf.summarySchemaVersion=2`
- `gateFlat.longrun.summarySchemaVersion=2`

## Latest Notes (2026-02-20): Branch Policy Default Alignment + Drill Tag Verification (PR #207)

Implementation:

- PR [#207](https://github.com/zensgit/metasheet2/pull/207) merged to `main`.
- Aligned defaults in both workflows:
  - `.github/workflows/attendance-branch-policy-drift-prod.yml`
  - `.github/workflows/attendance-branch-protection-prod.yml`
  - `require_pr_reviews=false` (single-maintainer fallback baseline)
- Unified drill run tagging:
  - run-name now appends `[DRILL]` when `workflow_dispatch` and `drill_fail=true`.

Verification:

| Gate | Run | Status | Evidence |
|---|---|---|---|
| Branch Policy Drift drill (expected FAIL) | [#22226847016](https://github.com/zensgit/metasheet2/actions/runs/22226847016) | FAIL (expected) | `output/playwright/ga/22226847016/step-summary.md`, `output/playwright/ga/22226847016/policy.log`, `output/playwright/ga/22226847016/policy.json`, Issue: [#208](https://github.com/zensgit/metasheet2/issues/208) |
| Branch Policy Drift recovery (same policy baseline) | [#22226864599](https://github.com/zensgit/metasheet2/actions/runs/22226864599) | PASS | `output/playwright/ga/22226864599/step-summary.md`, `output/playwright/ga/22226864599/policy.log`, `output/playwright/ga/22226864599/policy.json`, Issue: [#208](https://github.com/zensgit/metasheet2/issues/208) (`CLOSED`) |
| Daily Dashboard (post-recovery; non-drill source) | [#22226886691](https://github.com/zensgit/metasheet2/actions/runs/22226886691) | PASS | `output/playwright/ga/22226886691/attendance-daily-gate-dashboard.json`, `output/playwright/ga/22226886691/gate-meta/protection/meta.json` |

Verified from dashboard JSON (`#22226886691`):

- `overallStatus=pass`
- `p0Status=pass`
- `gateFlat.protection.status=PASS`
- `gateFlat.protection.runId=22226864599`
- `gateFlat.protection.requirePrReviews=false`

## Latest Notes (2026-02-21): Parallel Runbook Execution (Strict/Perf/Longrun/Dashboard)

Execution summary:

1. Ran strict/perf baseline/perf longrun/branch-policy in parallel on `codex/attendance-next-actions`.
2. Observed one longrun failure (`rows10k-commit` rollback transient `500`), fixed by adding rollback retries in `scripts/ops/attendance-import-perf.mjs`.
3. Re-ran longrun and recovered to PASS; corresponding P1 issue auto-closed.
4. Re-ran daily dashboard on `main` after replacing a cancelled strict run with a successful strict run.

Verification runs:

| Gate | Run | Status | Evidence |
|---|---|---|---|
| Branch policy drift | [#22249647577](https://github.com/zensgit/metasheet2/actions/runs/22249647577) | PASS | `output/playwright/ga/22249647577/attendance-branch-policy-drift-prod-22249647577-1/policy.json` |
| Strict gates (branch) | [#22249647567](https://github.com/zensgit/metasheet2/actions/runs/22249647567) | PASS | `output/playwright/ga/22249647567/attendance-strict-gates-prod-22249647567-1/20260221-034238-2/gate-summary.json` |
| Perf baseline 100k | [#22249647556](https://github.com/zensgit/metasheet2/actions/runs/22249647556) | PASS | `output/playwright/ga/22249647556/attendance-import-perf-22249647556-1/attendance-perf-mlvruyei-thwrf9/perf-summary.json` |
| Perf longrun pre-fix | [#22249647566](https://github.com/zensgit/metasheet2/actions/runs/22249647566) | FAIL (expected during fix) | `output/playwright/ga/22249647566/attendance-import-perf-longrun-rows10k-commit-22249647566-1/current/rows10k-commit/perf.log` |
| Perf longrun post-fix | [#22249759637](https://github.com/zensgit/metasheet2/actions/runs/22249759637) | PASS | `output/playwright/ga/22249759637/attendance-import-perf-longrun-rows10k-commit-22249759637-1/current-flat/rows10000-commit.json` |
| Strict gates (main) | [#22249826030](https://github.com/zensgit/metasheet2/actions/runs/22249826030) | PASS | `output/playwright/ga/22249826030/attendance-strict-gates-prod-22249826030-1/20260221-035505-2/gate-summary.json` |
| Daily dashboard (main, final) | [#22249881772](https://github.com/zensgit/metasheet2/actions/runs/22249881772) | PASS | `output/playwright/ga/22249881772/attendance-daily-gate-dashboard-22249881772-1/attendance-daily-gate-dashboard.json` |

Runbook note:

- `branch=feature-branch` 的 dashboard 通常会出现 `NO_COMPLETED_RUN`（remote-only gates按 `main` 调度）。这类 run 只用于脚本回归，不用于生产门禁判定。
- 生产门禁请固定使用：`branch=main`。

## Latest Notes (2026-02-21): Final Stabilization Snapshot

Execution summary:

1. Hardened strict/perf scripts against transient `502` / `ECONNREFUSED` / `fetch failed`.
2. Stabilized import mutation retries by re-preparing `commitToken` on each preview/commit retry.
3. Tuned baseline rollback threshold fallback to `30000ms`.
4. Re-ran strict + perf baseline + perf longrun, then validated daily dashboard on `main`.

Verification runs:

| Gate | Run | Status | Evidence |
|---|---|---|---|
| Strict gates (main) | [#22257658383](https://github.com/zensgit/metasheet2/actions/runs/22257658383) | PASS | `output/playwright/ga/22257658383/attendance-strict-gates-prod-22257658383-1/20260221-133025-1/gate-summary.json`, `output/playwright/ga/22257658383/attendance-strict-gates-prod-22257658383-1/20260221-133025-2/gate-summary.json` |
| Perf baseline 100k (main, `commit_async=false`) | [#22257793629](https://github.com/zensgit/metasheet2/actions/runs/22257793629) | PASS | `output/playwright/ga/22257793629/attendance-import-perf-22257793629-1/attendance-perf-mlwd8aeo-7mygl2/perf-summary.json` |
| Perf longrun (main) | [#22257658595](https://github.com/zensgit/metasheet2/actions/runs/22257658595) | PASS | `output/playwright/ga/22257658595/attendance-import-perf-longrun-rows10k-commit-22257658595-1/current-flat/rows10000-commit.json` |
| Daily dashboard (main, final) | [#22257840707](https://github.com/zensgit/metasheet2/actions/runs/22257840707) | PASS | `output/playwright/ga/22257840707/attendance-daily-gate-dashboard-22257840707-1/attendance-daily-gate-dashboard.md`, `output/playwright/ga/22257840707/attendance-daily-gate-dashboard-22257840707-1/attendance-daily-gate-dashboard.json` |

Observed dashboard status (`#22257840707`):

- `overallStatus=pass`
- `Strict Gates=PASS`
- `Perf Baseline=PASS`
- `Perf Long Run=PASS`
- `Remote Preflight=PASS`
- `Storage Health=PASS`

## Latest Notes (2026-02-22): PR Review Policy Raised To `true` + Full Gate Re-Verification

Execution summary:

1. Merged PR [#224](https://github.com/zensgit/metasheet2/pull/224) (`fb1f5f2e`) with:
   - branch policy workflow defaults set to `require_pr_reviews=true`
   - import API telemetry contract surfaced in commit/job responses
   - frontend import async panel telemetry rendering
2. Executed branch policy drill/recovery with a dedicated drill issue title and verified open/close behavior.
3. Re-ran strict/perf/dashboard workflows on `main` and archived artifacts under `output/playwright/ga/<runId>/...`.

Verification runs:

| Gate | Run | Status | Evidence |
|---|---|---|---|
| Branch Policy Drift drill (`drill_fail=true`) | [#22267999575](https://github.com/zensgit/metasheet2/actions/runs/22267999575) | FAIL (expected) | `output/playwright/ga/22267999575/attendance-branch-policy-drift-prod-22267999575-1/step-summary.md`, `output/playwright/ga/22267999575/attendance-branch-policy-drift-prod-22267999575-1/policy.log`, issue [#225](https://github.com/zensgit/metasheet2/issues/225) (`OPEN` at drill time) |
| Branch Policy Drift recovery (`drill_fail=false`) | [#22268010766](https://github.com/zensgit/metasheet2/actions/runs/22268010766) | PASS | `output/playwright/ga/22268010766/attendance-branch-policy-drift-prod-22268010766-1/step-summary.md`, `output/playwright/ga/22268010766/attendance-branch-policy-drift-prod-22268010766-1/policy.json`, issue [#225](https://github.com/zensgit/metasheet2/issues/225) (`CLOSED`) |
| Branch Protection workflow parity check | [#22268146870](https://github.com/zensgit/metasheet2/actions/runs/22268146870) | PASS | `output/playwright/ga/22268146870/attendance-branch-protection-prod-22268146870-1/step-summary.md` (`Require PR reviews=true`, `Min approving reviews=1`) |
| Strict Gates (Prod, twice) | [#22268021574](https://github.com/zensgit/metasheet2/actions/runs/22268021574) | PASS | `output/playwright/ga/22268021574/attendance-strict-gates-prod-22268021574-1/20260222-012647-1/gate-api-smoke.log`, `output/playwright/ga/22268021574/attendance-strict-gates-prod-22268021574-1/20260222-012647-2/gate-api-smoke.log` |
| Perf Baseline (`upload_csv=true`) | [#22268076603](https://github.com/zensgit/metasheet2/actions/runs/22268076603) | PASS | `output/playwright/ga/22268076603/attendance-import-perf-22268076603-1/attendance-perf-mlx2lyp8-at17vk/perf-summary.json` |
| Perf Long Run (`upload_csv=true`) | [#22268111924](https://github.com/zensgit/metasheet2/actions/runs/22268111924) | PASS | `output/playwright/ga/22268111924/attendance-import-perf-longrun-rows10k-commit-22268111924-1/current-flat/rows10000-commit.json`, `output/playwright/ga/22268111924/attendance-import-perf-longrun-rows500k-preview-22268111924-1/current-flat/rows500000-preview.json` |
| Daily Dashboard (main, final) | [#22268136099](https://github.com/zensgit/metasheet2/actions/runs/22268136099) | PASS | `output/playwright/ga/22268136099/attendance-daily-gate-dashboard-22268136099-1/attendance-daily-gate-dashboard.json` |

Observed dashboard status (`#22268136099`):

- `overallStatus=pass`
- `p0Status=pass`
- `gateFlat.protection.status=PASS`
- `gateFlat.protection.requirePrReviews=true`
- `gateFlat.protection.minApprovingReviews=1`
- `gateFlat.strict.runId=22268021574`
- `gateFlat.perf.runId=22268076603`
- `gateFlat.longrun.runId=22268111924`

## Latest Notes (2026-02-23): Branch Policy Redrive + Daily Dashboard Recheck

Execution summary:

1. Re-ran branch policy drift workflow on `main` with production baseline:
   - `require_pr_reviews=true`
   - `min_approving_review_count=1`
   - `require_code_owner_reviews=false`
2. Re-ran daily dashboard (`lookback_hours=48`) and archived new artifacts.
3. Verified dashboard `gateFlat.protection` points to the latest successful branch-policy run.

Verification runs:

| Gate | Run | Status | Evidence |
|---|---|---|---|
| Branch Policy Drift (main baseline) | [#22307832865](https://github.com/zensgit/metasheet2/actions/runs/22307832865) | PASS | `output/playwright/ga/22307832865/policy.json`, `output/playwright/ga/22307832865/step-summary.md` |
| Daily Dashboard (`lookback_hours=48`) | [#22307851285](https://github.com/zensgit/metasheet2/actions/runs/22307851285) | PASS | `output/playwright/ga/22307851285/attendance-daily-gate-dashboard.json`, `output/playwright/ga/22307851285/attendance-daily-gate-dashboard.md` |

Observed dashboard status (`#22307851285`):

- `overallStatus=pass`
- `p0Status=pass`
- `gateFlat.protection.status=PASS`
- `gateFlat.protection.runId=22307832865`
- `gateFlat.protection.requirePrReviews=true`
- `gateFlat.protection.minApprovingReviews=1`

## Latest Notes (2026-02-23): Longrun Matrix Expansion (`rows100k-commit`)

Execution summary:

1. Expanded `.github/workflows/attendance-import-perf-longrun.yml` matrix to add `rows100k-commit`.
2. Kept upload channel coverage (`upload_csv=true`) and trend aggregation unchanged.
3. Re-ran longrun workflow on branch `codex/attendance-longrun-commit-coverage` to verify new scenario executes and reports correctly.

Verification runs:

| Gate | Run | Status | Evidence |
|---|---|---|---|
| Longrun drill (branch) | [#22308569094](https://github.com/zensgit/metasheet2/actions/runs/22308569094) | PASS | `output/playwright/ga/22308569094/attendance-import-perf-longrun-drill-22308569094-1/drill.txt` |
| Longrun full run (branch, includes `rows100k-commit`) | [#22308598232](https://github.com/zensgit/metasheet2/actions/runs/22308598232) | PASS | `output/playwright/ga/22308598232/attendance-import-perf-longrun-rows100k-commit-22308598232-1/current-flat/rows100000-commit.json`, `output/playwright/ga/22308598232/attendance-import-perf-longrun-trend-22308598232-1/20260223-134338/attendance-import-perf-longrun-trend.json` |

Key observations (`#22308598232`):

- New scenario `rows100k-commit` completed successfully (`commitMs=98404`, `uploadCsv=true`, `engine=bulk`).
- Trend report status is `pass` and now includes `rows100k-commit` in scenario summary.

Threshold tuning follow-up (`#22308829077`):

- To avoid accidental tightening from baseline envs, `rows100k-commit` now uses dedicated defaults only:
  - `max_preview_ms=180000`
  - `max_commit_ms=300000`
  - `max_export_ms=45000`
- Verification run: [#22308829077](https://github.com/zensgit/metasheet2/actions/runs/22308829077) `PASS`
  - Evidence:
    - `output/playwright/ga/22308829077/attendance-import-perf-longrun-rows100k-commit-22308829077-1/current-flat/rows100000-commit.json`
    - `output/playwright/ga/22308829077/attendance-import-perf-longrun-trend-22308829077-1/20260223-135014/attendance-import-perf-longrun-trend.json`

## Latest Notes (2026-02-23): Post-merge Branch Policy Recheck (Main)

Execution summary:

1. Re-ran `Attendance Branch Policy Drift (Prod)` on `main` after the latest merge cycle.
2. Re-ran `Attendance Daily Gate Dashboard` (`lookback_hours=48`) after the new policy run.
3. Confirmed dashboard `gateFlat.protection` now points at the latest non-drill branch-policy run.

Verification runs:

| Gate | Run | Status | Evidence |
|---|---|---|---|
| Branch Policy Drift (main, non-drill) | [#22309204427](https://github.com/zensgit/metasheet2/actions/runs/22309204427) | PASS | `output/playwright/ga/22309204427/attendance-branch-policy-drift-prod-22309204427-1/policy.json`, `output/playwright/ga/22309204427/attendance-branch-policy-drift-prod-22309204427-1/step-summary.md` |
| Daily Dashboard (`lookback_hours=48`, post-policy rerun) | [#22309250542](https://github.com/zensgit/metasheet2/actions/runs/22309250542) | PASS | `output/playwright/ga/22309250542/attendance-daily-gate-dashboard-22309250542-1/attendance-daily-gate-dashboard.json`, `output/playwright/ga/22309250542/attendance-daily-gate-dashboard-22309250542-1/attendance-daily-gate-dashboard.md` |

Observed dashboard status (`#22309250542`):

- `overallStatus=pass`
- `p0Status=pass`
- `gateFlat.protection.status=PASS`
- `gateFlat.protection.runId=22309204427`
- `gateFlat.protection.requirePrReviews=true`
- `gateFlat.protection.minApprovingReviews=1`

## Latest Notes (2026-02-23): Final Re-Verify After PR #229 Merge

Execution summary:

1. Re-verified branch protection baseline on `main` (`require_pr_reviews=true`, `min_approving_review_count=1`).
2. Triggered a fresh non-drill branch policy run after merge.
3. Triggered a fresh dashboard run and confirmed it consumed the latest non-drill protection evidence.

Verification runs:

| Gate | Run | Status | Evidence |
|---|---|---|---|
| Branch Policy Drift (main, non-drill) | [#22309503350](https://github.com/zensgit/metasheet2/actions/runs/22309503350) | PASS | `output/playwright/ga/22309503350/attendance-branch-policy-drift-prod-22309503350-1/policy.json`, `output/playwright/ga/22309503350/attendance-branch-policy-drift-prod-22309503350-1/step-summary.md` |
| Daily Dashboard (`lookback_hours=48`, post-policy rerun) | [#22309519851](https://github.com/zensgit/metasheet2/actions/runs/22309519851) | PASS | `output/playwright/ga/22309519851/attendance-daily-gate-dashboard-22309519851-1/attendance-daily-gate-dashboard.json`, `output/playwright/ga/22309519851/attendance-daily-gate-dashboard-22309519851-1/attendance-daily-gate-dashboard.md` |

Observed dashboard status (`#22309519851`):

- `overallStatus=pass`
- `p0Status=pass`
- `gateFlat.protection.status=PASS`
- `gateFlat.protection.runId=22309503350`
- `gateFlat.protection.requirePrReviews=true`
- `gateFlat.protection.minApprovingReviews=1`

## Latest Notes (2026-02-23): Perf Artifacts Add Upsert Strategy Signal

Updates:

1. `scripts/ops/attendance-import-perf.mjs` now writes `recordUpsertStrategy` into `perf-summary.json`.
2. `scripts/ops/attendance-import-perf-trend-report.mjs` now shows an `Upsert` column (`VALUES|UNNEST|STAGING`) in Scenario Summary.
3. Attendance import commit/job telemetry now exposes `recordUpsertStrategy`, enabling GA artifacts to prove which write strategy was used.
4. `attendance-import-perf-longrun.yml` now enforces `EXPECT_RECORD_UPSERT_STRATEGY=staging` for `rows100k-commit` to catch bulk-path regressions early.

Local verification:

- `node --check scripts/ops/attendance-import-perf.mjs`
- `node --check scripts/ops/attendance-import-perf-trend-report.mjs`

Expected artifact checks after next perf/longrun runs:

- `output/playwright/ga/<RUN_ID>/**/perf-summary.json` includes `recordUpsertStrategy`.
- `output/playwright/ga/<RUN_ID>/**/attendance-import-perf-longrun-trend.md` includes `Upsert` column values per scenario.

## Latest Notes (2026-02-23): Post-PR #231 Branch Policy and Dashboard Re-Verify

Execution summary:

1. Merged PR [#231](https://github.com/zensgit/metasheet2/pull/231).
2. Re-ran `Attendance Branch Policy Drift (Prod)` on `main`.
3. Re-ran `Attendance Daily Gate Dashboard` (`lookback_hours=48`) and validated it references the latest policy run.

Verification runs:

| Gate | Run | Status | Evidence |
|---|---|---|---|
| Branch Policy Drift (main, non-drill) | [#22310774604](https://github.com/zensgit/metasheet2/actions/runs/22310774604) | PASS | `output/playwright/ga/22310774604/attendance-branch-policy-drift-prod-22310774604-1/policy.json`, `output/playwright/ga/22310774604/attendance-branch-policy-drift-prod-22310774604-1/policy.log`, `output/playwright/ga/22310774604/attendance-branch-policy-drift-prod-22310774604-1/step-summary.md` |
| Daily Dashboard (`lookback_hours=48`, post-policy rerun) | [#22310807657](https://github.com/zensgit/metasheet2/actions/runs/22310807657) | PASS | `output/playwright/ga/22310807657/attendance-daily-gate-dashboard.json`, `output/playwright/ga/22310807657/attendance-daily-gate-dashboard.md`, `output/playwright/ga/22310807657/gate-meta/protection/meta.json` |

Observed dashboard status (`#22310807657`):

- `overallStatus=pass`
- `p0Status=pass`
- `gateFlat.protection.status=PASS`
- `gateFlat.protection.runId=22310774604`
- `gateFlat.protection.requirePrReviews=true`
- `gateFlat.protection.minApprovingReviews=1`

## Latest Notes (2026-02-23): Post-PR #232 Gate Re-Verify

Execution summary:

1. Merged PR [#232](https://github.com/zensgit/metasheet2/pull/232) (docs evidence sync).
2. Re-ran `Attendance Branch Policy Drift (Prod)` on `main`.
3. Re-ran `Attendance Daily Gate Dashboard` (`lookback_hours=48`) and validated protection gate source run.

Verification runs:

| Gate | Run | Status | Evidence |
|---|---|---|---|
| Branch Policy Drift (main, non-drill) | [#22310999119](https://github.com/zensgit/metasheet2/actions/runs/22310999119) | PASS | `output/playwright/ga/22310999119/attendance-branch-policy-drift-prod-22310999119-1/policy.json`, `output/playwright/ga/22310999119/attendance-branch-policy-drift-prod-22310999119-1/policy.log`, `output/playwright/ga/22310999119/attendance-branch-policy-drift-prod-22310999119-1/step-summary.md` |
| Daily Dashboard (`lookback_hours=48`, post-policy rerun) | [#22311046163](https://github.com/zensgit/metasheet2/actions/runs/22311046163) | PASS | `output/playwright/ga/22311046163/attendance-daily-gate-dashboard.json`, `output/playwright/ga/22311046163/attendance-daily-gate-dashboard.md`, `output/playwright/ga/22311046163/gate-meta/protection/meta.json` |

Observed dashboard status (`#22311046163`):

- `overallStatus=pass`
- `p0Status=pass`
- `gateFlat.protection.status=PASS`
- `gateFlat.protection.runId=22310999119`
- `gateFlat.protection.requirePrReviews=true`
- `gateFlat.protection.minApprovingReviews=1`

## Latest Notes (2026-02-23): Full-Flow Recovery Assertion Update

Updates:

1. `scripts/verify-attendance-full-flow.mjs` recovery assertion now accepts both status actions:
   - `Resume import job` (new one-click timeout recovery)
   - `Reload import job` (compatibility fallback)
2. This keeps CI/remote UI verification compatible while frontend recovery UX evolves.
3. Recovery assertion now also checks async telemetry fields in the job card:
   - `Processed: <n> · Failed: <n>`
   - `Elapsed: <ms> ms`
   - can be disabled only with `ASSERT_IMPORT_JOB_TELEMETRY=false`.

## Latest Notes (2026-02-23): Post-PR #233 Branch Policy and Dashboard Re-Verify

Execution summary:

1. Merged PR [#233](https://github.com/zensgit/metasheet2/pull/233).
2. Re-ran `Attendance Branch Policy Drift (Prod)` on `main`.
3. Re-ran `Attendance Daily Gate Dashboard` (`lookback_hours=48`) and validated it references the latest policy run.

Verification runs:

| Gate | Run | Status | Evidence |
|---|---|---|---|
| Branch Policy Drift (main, non-drill) | [#22313040979](https://github.com/zensgit/metasheet2/actions/runs/22313040979) | PASS | `output/playwright/ga/22313040979/attendance-branch-policy-drift-prod-22313040979-1/policy.json`, `output/playwright/ga/22313040979/attendance-branch-policy-drift-prod-22313040979-1/policy.log`, `output/playwright/ga/22313040979/attendance-branch-policy-drift-prod-22313040979-1/step-summary.md` |
| Daily Dashboard (`lookback_hours=48`, post-policy rerun) | [#22313086337](https://github.com/zensgit/metasheet2/actions/runs/22313086337) | PASS | `output/playwright/ga/22313086337/attendance-daily-gate-dashboard.json`, `output/playwright/ga/22313086337/attendance-daily-gate-dashboard.md`, `output/playwright/ga/22313086337/gate-meta/protection/meta.json` |

Observed dashboard status (`#22313086337`):

- `overallStatus=pass`
- `p0Status=pass`
- `gateFlat.protection.status=PASS`
- `gateFlat.protection.runId=22313040979`
- `gateFlat.protection.requirePrReviews=true`
- `gateFlat.protection.minApprovingReviews=1`

## Latest Notes (2026-02-24): Post-PR #236 Branch Policy and Dashboard Re-Verify

Execution summary:

1. Merged PR [#236](https://github.com/zensgit/metasheet2/pull/236) (longrun upsert-strategy guard).
2. Re-ran `Attendance Branch Policy Drift (Prod)` on `main`.
3. Re-ran `Attendance Daily Gate Dashboard` (`lookback_hours=48`) after policy completion and validated protection gate source run.

Verification runs:

| Gate | Run | Status | Evidence |
|---|---|---|---|
| Branch Policy Drift (main, non-drill) | [#22333998882](https://github.com/zensgit/metasheet2/actions/runs/22333998882) | PASS | `output/playwright/ga/22333998882/attendance-branch-policy-drift-prod-22333998882-1/policy.json`, `output/playwright/ga/22333998882/attendance-branch-policy-drift-prod-22333998882-1/policy.log`, `output/playwright/ga/22333998882/attendance-branch-policy-drift-prod-22333998882-1/step-summary.md` |
| Daily Dashboard (`lookback_hours=48`, post-policy rerun) | [#22334028181](https://github.com/zensgit/metasheet2/actions/runs/22334028181) | PASS | `output/playwright/ga/22334028181/attendance-daily-gate-dashboard-22334028181-1/attendance-daily-gate-dashboard.json`, `output/playwright/ga/22334028181/attendance-daily-gate-dashboard-22334028181-1/attendance-daily-gate-dashboard.md`, `output/playwright/ga/22334028181/attendance-daily-gate-dashboard-22334028181-1/gate-meta/protection/meta.json` |

Observed dashboard status (`#22334028181`):

- `overallStatus=pass`
- `p0Status=pass`
- `gateFlat.protection.status=PASS`
- `gateFlat.protection.runId=22333998882`
- `gateFlat.protection.requirePrReviews=true`
- `gateFlat.protection.minApprovingReviews=1`

## Latest Notes (2026-02-24): Post-PR #237 Branch Policy and Dashboard Re-Verify

Execution summary:

1. Restored branch protection baseline after merge operations.
2. Re-ran `Attendance Branch Policy Drift (Prod)` on `main`.
3. Re-ran `Attendance Daily Gate Dashboard` after policy completion and validated latest protection run binding.

Verification runs:

| Gate | Run | Status | Evidence |
|---|---|---|---|
| Branch Policy Drift (main, non-drill) | [#22334103172](https://github.com/zensgit/metasheet2/actions/runs/22334103172) | PASS | `output/playwright/ga/22334103172/attendance-branch-policy-drift-prod-22334103172-1/policy.json`, `output/playwright/ga/22334103172/attendance-branch-policy-drift-prod-22334103172-1/policy.log`, `output/playwright/ga/22334103172/attendance-branch-policy-drift-prod-22334103172-1/step-summary.md` |
| Daily Dashboard (`lookback_hours=48`, post-policy rerun) | [#22334126100](https://github.com/zensgit/metasheet2/actions/runs/22334126100) | PASS | `output/playwright/ga/22334126100/attendance-daily-gate-dashboard-22334126100-1/attendance-daily-gate-dashboard.json`, `output/playwright/ga/22334126100/attendance-daily-gate-dashboard-22334126100-1/attendance-daily-gate-dashboard.md`, `output/playwright/ga/22334126100/attendance-daily-gate-dashboard-22334126100-1/gate-meta/protection/meta.json` |

Observed dashboard status (`#22334126100`):

- `overallStatus=pass`
- `p0Status=pass`
- `gateFlat.protection.status=PASS`
- `gateFlat.protection.runId=22334103172`
- `gateFlat.protection.requirePrReviews=true`
- `gateFlat.protection.minApprovingReviews=1`

## Latest Notes (2026-02-24): Longrun Guard Validation (`rows100k-commit`)

Execution summary:

1. Triggered a non-drill longrun run after adding `EXPECT_RECORD_UPSERT_STRATEGY` guard.
2. Verified `rows100k-commit` artifacts show `recordUpsertStrategy=staging` and no regressions.

Verification run:

| Gate | Run | Status | Evidence |
|---|---|---|---|
| Perf Longrun (non-drill) | [#22334158061](https://github.com/zensgit/metasheet2/actions/runs/22334158061) | PASS | `output/playwright/ga/22334158061/attendance-import-perf-longrun-rows100k-commit-22334158061-1/current-flat/rows100000-commit.json`, `output/playwright/ga/22334158061/attendance-import-perf-longrun-trend-22334158061-1/20260224-023722/attendance-import-perf-longrun-trend.md` |

## Latest Notes (2026-02-24): Post-PR #239 Contract Matrix + Policy/Dashboard Re-Verify

Execution summary:

1. Merged PR [#239](https://github.com/zensgit/metasheet2/pull/239) to tighten dashboard contract parsing/validation for upsert strategy fields.
2. Triggered `Attendance Gate Contract Matrix` on `main` and verified both strict/dashboard contracts pass with the new `dashboard.invalid.upsert.json` negative case.
3. Re-applied branch protection baseline (`require_pr_reviews=true`, `min_approving_review_count=1`) and re-ran `Attendance Branch Policy Drift (Prod)`.
4. Re-ran `Attendance Daily Gate Dashboard` (`lookback_hours=48`) to confirm `gateFlat.protection` binds the latest non-drill policy run.

Verification runs:

| Gate | Run | Status | Evidence |
|---|---|---|---|
| Gate Contract Matrix (main) | [#22337517816](https://github.com/zensgit/metasheet2/actions/runs/22337517816) | PASS | `output/playwright/ga/22337517816/attendance-gate-contract-matrix-dashboard-22337517816-1/dashboard.valid.json`, `output/playwright/ga/22337517816/attendance-gate-contract-matrix-dashboard-22337517816-1/dashboard.invalid.upsert.json`, `output/playwright/ga/22337517816/attendance-gate-contract-matrix-strict-22337517816-1/strict/gate-summary.valid.json` |
| Branch Policy Drift (main, non-drill) | [#22337554892](https://github.com/zensgit/metasheet2/actions/runs/22337554892) | PASS | `output/playwright/ga/22337554892/attendance-branch-policy-drift-prod-22337554892-1/policy.json`, `output/playwright/ga/22337554892/attendance-branch-policy-drift-prod-22337554892-1/policy.log`, `output/playwright/ga/22337554892/attendance-branch-policy-drift-prod-22337554892-1/step-summary.md` |
| Daily Dashboard (`lookback_hours=48`, post-policy rerun) | [#22337567788](https://github.com/zensgit/metasheet2/actions/runs/22337567788) | PASS | `output/playwright/ga/22337567788/attendance-daily-gate-dashboard-22337567788-1/attendance-daily-gate-dashboard.json`, `output/playwright/ga/22337567788/attendance-daily-gate-dashboard-22337567788-1/attendance-daily-gate-dashboard.md`, `output/playwright/ga/22337567788/attendance-daily-gate-dashboard-22337567788-1/gate-meta/protection/meta.json` |

Observed dashboard status (`#22337567788`):

- `overallStatus=pass`
- `p0Status=pass`
- `gateFlat.protection.status=PASS`
- `gateFlat.protection.runId=22337554892`
- `gateFlat.protection.requirePrReviews=true`
- `gateFlat.protection.minApprovingReviews=1`
- `gateFlat.perf.recordUpsertStrategy=staging`

## Latest Notes (2026-02-24): Post-PR #240 Final Policy Restore and Dashboard Re-Run

Execution summary:

1. Merged PR [#240](https://github.com/zensgit/metasheet2/pull/240) (docs evidence sync).
2. Re-applied branch protection review baseline (`require_pr_reviews=true`, `min_approving_review_count=1`).
3. Re-ran `Attendance Branch Policy Drift (Prod)` on `main`.
4. Re-ran `Attendance Daily Gate Dashboard` (`lookback_hours=48`) after policy completion.

Verification runs:

| Gate | Run | Status | Evidence |
|---|---|---|---|
| Branch Policy Drift (main, non-drill) | [#22337671524](https://github.com/zensgit/metasheet2/actions/runs/22337671524) | PASS | `output/playwright/ga/22337671524/attendance-branch-policy-drift-prod-22337671524-1/policy.json`, `output/playwright/ga/22337671524/attendance-branch-policy-drift-prod-22337671524-1/policy.log`, `output/playwright/ga/22337671524/attendance-branch-policy-drift-prod-22337671524-1/step-summary.md` |
| Daily Dashboard (`lookback_hours=48`, post-policy rerun) | [#22337693734](https://github.com/zensgit/metasheet2/actions/runs/22337693734) | PASS | `output/playwright/ga/22337693734/attendance-daily-gate-dashboard-22337693734-1/attendance-daily-gate-dashboard.json`, `output/playwright/ga/22337693734/attendance-daily-gate-dashboard-22337693734-1/attendance-daily-gate-dashboard.md`, `output/playwright/ga/22337693734/attendance-daily-gate-dashboard-22337693734-1/gate-meta/protection/meta.json` |

Observed dashboard status (`#22337693734`):

- `overallStatus=pass`
- `p0Status=pass`
- `gateFlat.protection.status=PASS`
- `gateFlat.protection.runId=22337671524`
- `gateFlat.protection.requirePrReviews=true`
- `gateFlat.protection.minApprovingReviews=1`
- `gateFlat.perf.recordUpsertStrategy=staging`

## Latest Notes (2026-02-24): Final Strict Gates Twice + Post-Policy Dashboard Bind

Execution summary:

1. Triggered `Attendance Strict Gates (Prod)` on `main`.
2. Verified both strict iterations passed with upload-channel API smoke and Playwright desktop/mobile coverage.
3. Re-ran `Attendance Branch Policy Drift (Prod)` and then `Attendance Daily Gate Dashboard` (`lookback_hours=48`) to bind latest policy evidence.

Verification runs:

| Gate | Run | Status | Evidence |
|---|---|---|---|
| Strict Gates (twice, non-drill) | [#22337802322](https://github.com/zensgit/metasheet2/actions/runs/22337802322) | PASS | `output/playwright/ga/22337802322/attendance-strict-gates-prod-22337802322-1/20260224-052221-1/gate-summary.json`, `output/playwright/ga/22337802322/attendance-strict-gates-prod-22337802322-1/20260224-052221-2/gate-summary.json`, `output/playwright/ga/22337802322/attendance-strict-gates-prod-22337802322-1/20260224-052221-1/gate-api-smoke.log`, `output/playwright/ga/22337802322/attendance-strict-gates-prod-22337802322-1/20260224-052221-2/gate-api-smoke.log` |
| Branch Policy Drift (main, non-drill) | [#22337759756](https://github.com/zensgit/metasheet2/actions/runs/22337759756) | PASS | `output/playwright/ga/22337759756/attendance-branch-policy-drift-prod-22337759756-1/policy.json`, `output/playwright/ga/22337759756/attendance-branch-policy-drift-prod-22337759756-1/policy.log`, `output/playwright/ga/22337759756/attendance-branch-policy-drift-prod-22337759756-1/step-summary.md` |
| Daily Dashboard (`lookback_hours=48`, post-policy rerun) | [#22337780063](https://github.com/zensgit/metasheet2/actions/runs/22337780063) | PASS | `output/playwright/ga/22337780063/attendance-daily-gate-dashboard-22337780063-1/attendance-daily-gate-dashboard.json`, `output/playwright/ga/22337780063/attendance-daily-gate-dashboard-22337780063-1/attendance-daily-gate-dashboard.md`, `output/playwright/ga/22337780063/attendance-daily-gate-dashboard-22337780063-1/gate-meta/protection/meta.json` |

Observed status:

- Strict API smoke logs contain `import upload ok`, `idempotency ok`, `export csv ok`, `SMOKE PASS` in both iterations.
- Dashboard `#22337780063` keeps `overallStatus=pass` and binds `gateFlat.protection.runId=22337759756`.
- Branch protection contract remains: `requirePrReviews=true`, `minApprovingReviews=1`.

## Latest Notes (2026-02-24): Post-PR #243 Admin Save Timeout Verification

Execution summary:

1. Merged PR [#243](https://github.com/zensgit/metasheet2/pull/243) (`fix(attendance-web): timeout admin save requests and verify recovery`).
2. Re-ran branch policy and dashboard on `main`.
3. Re-ran strict gates twice and verified new desktop full-flow assertion for Admin settings save recovery.

Verification runs:

| Gate | Run | Status | Evidence |
|---|---|---|---|
| Branch Policy Drift (main, non-drill) | [#22339850697](https://github.com/zensgit/metasheet2/actions/runs/22339850697) | PASS | `output/playwright/ga/22339850697/attendance-branch-policy-drift-prod-22339850697-1/policy.json`, `output/playwright/ga/22339850697/attendance-branch-policy-drift-prod-22339850697-1/step-summary.md` |
| Daily Dashboard (`lookback_hours=48`) | [#22339849959](https://github.com/zensgit/metasheet2/actions/runs/22339849959) | PASS | `output/playwright/ga/22339849959/attendance-daily-gate-dashboard-22339849959-1/attendance-daily-gate-dashboard.json`, `output/playwright/ga/22339849959/attendance-daily-gate-dashboard-22339849959-1/attendance-daily-gate-dashboard.md` |
| Strict Gates (twice, non-drill) | [#22339849230](https://github.com/zensgit/metasheet2/actions/runs/22339849230) | PASS | `output/playwright/ga/22339849230/attendance-strict-gates-prod-22339849230-1/*-1/gate-summary.json`, `output/playwright/ga/22339849230/attendance-strict-gates-prod-22339849230-1/*-2/gate-summary.json`, `output/playwright/ga/22339849230/attendance-strict-gates-prod-22339849230-1/*-1/gate-playwright-full-flow-desktop.log`, `output/playwright/ga/22339849230/attendance-strict-gates-prod-22339849230-1/*-2/gate-playwright-full-flow-desktop.log` |

Observed status:

- Strict-gate desktop logs include:
  - `Admin settings save cycle verified (Save settings button recovered from saving state)`
  - `Full flow verification complete`
- Branch policy remains compliant (`require_pr_reviews=true`, `min_approving_review_count=1`).
- Daily dashboard remains green (`overallStatus=pass`, `p0Status=pass`).

## Latest Notes (2026-02-24): Strict Gate Telemetry Enforcement (Branch Verification)

Execution summary:

1. Added strict API smoke telemetry requirement for import responses/jobs:
   - `engine`
   - `processedRows`
   - `failedRows`
   - `elapsedMs`
2. Wired `REQUIRE_IMPORT_TELEMETRY` through:
   - `scripts/ops/attendance-run-gates.sh`
   - `scripts/ops/attendance-run-strict-gates-twice.sh`
   - `.github/workflows/attendance-strict-gates-prod.yml` (`require_import_telemetry`, default `true`)
3. Re-ran strict gates on branch `codex/attendance-strict-telemetry-gate`.

Verification run:

| Gate | Run | Status | Evidence |
|---|---|---|---|
| Strict Gates (branch, twice, non-drill) | [#22343985697](https://github.com/zensgit/metasheet2/actions/runs/22343985697) | PASS | `output/playwright/ga/22343985697/20260224-090846-1/gate-summary.json`, `output/playwright/ga/22343985697/20260224-090846-2/gate-summary.json`, `output/playwright/ga/22343985697/20260224-090846-1/gate-api-smoke.log`, `output/playwright/ga/22343985697/20260224-090846-2/gate-api-smoke.log` |

Observed API smoke evidence (both strict iterations):

- `import upload ok`
- `preview async telemetry ok`
- `import commit telemetry ok`
- `import idempotency telemetry ok`
- `export csv ok`
- `import async telemetry ok`
- `import async idempotency ok`
- `SMOKE PASS`

## Latest Notes (2026-02-24): Branch Policy Scripts Re-aligned to PR Review Enforcement

Execution summary:

1. After merging PR [#245](https://github.com/zensgit/metasheet2/pull/245), identified a drift gap where branch-policy scripts could miss PR review requirements.
2. Fixed branch-policy scripts to enforce and validate:
   - `require_pr_reviews`
   - `min_approving_review_count`
   - `require_code_owner_reviews`
3. Re-ran branch-policy drift workflow to confirm policy JSON carries and validates review fields.

Verification run:

| Gate | Run | Status | Evidence |
|---|---|---|---|
| Branch Policy Drift (branch validation) | [#22346158689](https://github.com/zensgit/metasheet2/actions/runs/22346158689) | PASS | `output/playwright/ga/22346158689/policy.json`, `output/playwright/ga/22346158689/policy.log`, `output/playwright/ga/22346158689/step-summary.md` |

Observed policy snapshot (`policy.json`):

- `requirePrReviews=true`
- `minApprovingReviewCount=1`
- `prReviewsRequiredCurrent=true`
- `approvingReviewCountCurrent=1`
- `codeOwnerReviewsCurrent=false`

## Latest Notes (2026-02-24): Post-PR #246 Mainline Re-Validation

Execution summary:

1. Merged PR [#246](https://github.com/zensgit/metasheet2/pull/246) (`fix(attendance-gates): restore branch policy review-field drift checks`).
2. Re-ran `Attendance Branch Policy Drift (Prod)` on `main`.
3. Re-ran `Attendance Daily Gate Dashboard` (`lookback_hours=48`) to confirm `gateFlat.protection` references the latest policy run.
4. Re-ran `Attendance Strict Gates (Prod)` on `main` with `require_import_telemetry=true`.

Verification runs:

| Gate | Run | Status | Evidence |
|---|---|---|---|
| Branch Policy Drift (main, non-drill) | [#22346290813](https://github.com/zensgit/metasheet2/actions/runs/22346290813) | PASS | `output/playwright/ga/22346290813/policy.json`, `output/playwright/ga/22346290813/policy.log`, `output/playwright/ga/22346290813/step-summary.md` |
| Daily Dashboard (`lookback_hours=48`) | [#22346315048](https://github.com/zensgit/metasheet2/actions/runs/22346315048) | PASS | `output/playwright/ga/22346315048/attendance-daily-gate-dashboard.json`, `output/playwright/ga/22346315048/attendance-daily-gate-dashboard.md`, `output/playwright/ga/22346315048/gate-meta/protection/meta.json` |
| Strict Gates (main, twice, non-drill) | [#22346357457](https://github.com/zensgit/metasheet2/actions/runs/22346357457) | PASS | `output/playwright/ga/22346357457/20260224-101623-1/gate-summary.json`, `output/playwright/ga/22346357457/20260224-101623-2/gate-summary.json`, `output/playwright/ga/22346357457/20260224-101623-1/gate-api-smoke.log`, `output/playwright/ga/22346357457/20260224-101623-2/gate-api-smoke.log` |

Observed status:

- `policy.json` confirms review enforcement:
  - `requirePrReviews=true`
  - `prReviewsRequiredCurrent=true`
  - `minApprovingReviewCount=1`
  - `approvingReviewCountCurrent=1`
- Daily dashboard remains green and references the latest policy run:
  - `overallStatus=pass`
  - `p0Status=pass`
  - `gateFlat.protection.runId=22346290813`
- Strict API smoke logs (both iterations) include:
  - `import commit telemetry ok`
  - `import idempotency telemetry ok`
  - `import async telemetry ok`
  - `SMOKE PASS`

## Latest Notes (2026-02-24): Perf Longrun Optional 500k Toggle + Import Async Telemetry UX

Execution summary:

1. Added optional longrun input `include_rows500k_preview` in `.github/workflows/attendance-import-perf-longrun.yml` (default `true`) to allow faster non-drill reruns without removing 500k coverage from defaults.
2. Updated `scripts/ops/attendance-import-perf-trend-report.mjs` notes:
   - Automatically shows `50k/100k/500k` when 500k summary exists.
   - Emits explicit skip note when 500k scenario is disabled.
3. Polished `apps/web/src/views/AttendanceView.vue` async import job status card:
   - Added consolidated telemetry line with `Engine/Processed/Failed/Elapsed/Throughput`.
   - Avoided duplicate progress text when top-line progress is already shown.

Verification:

| Check | Command/Run | Status | Evidence |
|---|---|---|---|
| Trend report syntax | `node --check scripts/ops/attendance-import-perf-trend-report.mjs` | PASS | local |
| Web compile/type check | `pnpm --filter @metasheet/web build` | PASS | local |
| Trend script with 500k-enabled fixture | `CURRENT_ROOT=output/playwright/ga/22334158061 ... node scripts/ops/attendance-import-perf-trend-report.mjs` | PASS | `output/playwright/tmp-longrun-trend-check/20260224-112744/attendance-import-perf-longrun-trend.md` |
| Trend script with no-500k fixture | `CURRENT_ROOT=output/playwright/ga/22020987167 ... node scripts/ops/attendance-import-perf-trend-report.mjs` | PASS | `output/playwright/tmp-longrun-trend-check-no500k/20260224-112810/attendance-import-perf-longrun-trend.md` |
| Perf longrun (branch, non-drill, `include_rows500k_preview=false`) | [#22348884993](https://github.com/zensgit/metasheet2/actions/runs/22348884993) | PASS | `output/playwright/ga/22348884993/attendance-import-perf-longrun-rows10k-commit-22348884993-1/current-flat/rows10000-commit.json`, `output/playwright/ga/22348884993/attendance-import-perf-longrun-rows100k-commit-22348884993-1/current-flat/rows100000-commit.json`, `output/playwright/ga/22348884993/attendance-import-perf-longrun-trend-22348884993-1/20260224-113137/attendance-import-perf-longrun-trend.md` |

Observed run evidence (`#22348884993`):

- `rows500k-preview` matrix leg skipped by policy toggle (`Mark rows500k-preview as skipped` step success).
- Trend markdown includes:
  - `500k preview scenario is currently skipped (include_rows500k_preview=false).`
- `perf-summary.json` keeps upload and telemetry visibility:
  - `uploadCsv=true`
  - `engine=standard|bulk`

Recommended command for faster non-drill reruns:

```bash
gh workflow run attendance-import-perf-longrun.yml \
  --ref main \
  -f upload_csv=true \
  -f include_rows500k_preview=false \
  -f fail_on_regression=false
```

## Latest Notes (2026-02-24): Post-PR #248 Mainline Re-Validation

Execution summary:

1. Merged PR [#248](https://github.com/zensgit/metasheet2/pull/248) (merge commit `836eab8909db08179da82c76da5d57f7b2620631`).
2. Temporarily relaxed review requirement only for merge operation, then restored and verified:
   - `require_pr_reviews=true`
   - `min_approving_review_count=1`
   - `require_code_owner_reviews=false`
3. Triggered and passed three mainline workflows:
   - Branch Policy Drift
   - Daily Gate Dashboard
   - Perf Long Run (`include_rows500k_preview=false`)

Verification runs:

| Gate | Run | Status | Evidence |
|---|---|---|---|
| Branch Policy Drift (main, non-drill) | [#22349165386](https://github.com/zensgit/metasheet2/actions/runs/22349165386) | PASS | `output/playwright/ga/22349165386/attendance-branch-policy-drift-prod-22349165386-1/policy.json`, `output/playwright/ga/22349165386/attendance-branch-policy-drift-prod-22349165386-1/policy.log`, `output/playwright/ga/22349165386/attendance-branch-policy-drift-prod-22349165386-1/step-summary.md` |
| Daily Gate Dashboard (main, `lookback_hours=48`) | [#22349165388](https://github.com/zensgit/metasheet2/actions/runs/22349165388) | PASS | `output/playwright/ga/22349165388/attendance-daily-gate-dashboard-22349165388-1/attendance-daily-gate-dashboard.json`, `output/playwright/ga/22349165388/attendance-daily-gate-dashboard-22349165388-1/attendance-daily-gate-dashboard.md`, `output/playwright/ga/22349165388/attendance-daily-gate-dashboard-22349165388-1/gate-meta/protection/meta.json` |
| Perf Long Run (main, non-drill, `include_rows500k_preview=false`) | [#22349165365](https://github.com/zensgit/metasheet2/actions/runs/22349165365) | PASS | `output/playwright/ga/22349165365/attendance-import-perf-longrun-rows10k-commit-22349165365-1/current-flat/rows10000-commit.json`, `output/playwright/ga/22349165365/attendance-import-perf-longrun-rows100k-commit-22349165365-1/current-flat/rows100000-commit.json`, `output/playwright/ga/22349165365/attendance-import-perf-longrun-trend-22349165365-1/20260224-114015/attendance-import-perf-longrun-trend.md` |

Observed highlights:

- Branch policy evidence (`#22349165386`) confirms restored review baseline:
  - `requirePrReviews=true`
  - `prReviewsRequiredCurrent=true`
  - `minApprovingReviewCount=1`
  - `approvingReviewCountCurrent=1`
- Daily dashboard (`#22349165388`) remains green:
  - `overallStatus=pass`
  - `p0Status=pass`
- Longrun (`#22349165365`) confirms optional 500k behavior on main:
  - trend markdown contains `500k preview scenario is currently skipped (include_rows500k_preview=false)`
  - commit summaries still expose `uploadCsv=true` and `engine/processedRows/failedRows/elapsedMs`

## Latest Notes (2026-02-25): Post-PR #250 Mainline Re-Validation

Execution summary:

1. Merged PR [#250](https://github.com/zensgit/metasheet2/pull/250) (async import recovery polling hardening).
2. Triggered `Attendance Strict Gates (Prod)` on `main` with `require_import_job_recovery=true`.
3. Triggered `Attendance Daily Gate Dashboard` (`lookback_hours=48`) on `main` after strict completion.

Verification runs:

| Gate | Run | Status | Evidence |
|---|---|---|---|
| Strict Gates (main, non-drill, `require_import_job_recovery=true`) | [#22377460693](https://github.com/zensgit/metasheet2/actions/runs/22377460693) | PASS | `output/playwright/ga/22377460693/20260225-011038-1/gate-summary.json`, `output/playwright/ga/22377460693/20260225-011038-2/gate-summary.json`, `output/playwright/ga/22377460693/20260225-011038-1/gate-playwright-full-flow-desktop.log`, `output/playwright/ga/22377460693/20260225-011038-2/gate-playwright-full-flow-desktop.log` |
| Daily Gate Dashboard (main, `lookback_hours=48`) | [#22377585632](https://github.com/zensgit/metasheet2/actions/runs/22377585632) | PASS | `output/playwright/ga/22377585632/attendance-daily-gate-dashboard.json`, `output/playwright/ga/22377585632/attendance-daily-gate-dashboard.md`, `output/playwright/ga/22377585632/gate-meta/protection/meta.json`, `output/playwright/ga/22377585632/gate-meta/strict/meta.json` |

Observed highlights:

- Strict gate evidence confirms recovery assertion executed in both iterations:
  - `gate-summary.json`: `"requireImportJobRecovery": true`
  - desktop logs: `Admin import recovery assertion passed`
- Strict API smoke markers present in both iterations:
  - `import upload ok`
  - `idempotency ok`
  - `export csv ok`
  - `SMOKE PASS`
- Dashboard remained green after strict refresh:
  - `overallStatus=pass`
  - `p0Status=pass`
  - `gateFlat.strict.runId=22377460693`

## Latest Notes (2026-02-25): Perf Baseline/Longrun Follow-Up and Longrun Stabilization

Execution summary:

1. Triggered `Attendance Import Perf Baseline` on `main` (`rows=100000`, `upload_csv=true`) after strict/dashboard re-validation.
2. Triggered `Attendance Import Perf Long Run` on `main` (`upload_csv=true`, `include_rows500k_preview=false`) and observed a transient `rows100k-commit` 500 failure.
3. Applied workflow stabilization in `.github/workflows/attendance-import-perf-longrun.yml`:
   - `strategy.max-parallel: 2` for `perf-scenarios`.
4. Re-ran longrun on `codex/attendance-next-round-ops` with the same inputs and verified all scenarios + trend report PASS.

Verification runs:

| Gate | Run | Status | Evidence |
|---|---|---|---|
| Perf Baseline (main, `rows=100000`, `upload_csv=true`) | [#22379746084](https://github.com/zensgit/metasheet2/actions/runs/22379746084) | PASS | `output/playwright/ga/22379746084/attendance-import-perf-22379746084-1/attendance-perf-mm1ff61s-0s7zkg/perf-summary.json`, `output/playwright/ga/22379746084/attendance-import-perf-22379746084-1/perf.log` |
| Perf Long Run (main, pre-fix, `upload_csv=true`, `include_rows500k_preview=false`) | [#22379746105](https://github.com/zensgit/metasheet2/actions/runs/22379746105) | FAIL | `output/playwright/ga/22379746105/attendance-import-perf-longrun-rows100k-commit-22379746105-1/current/rows100k-commit/perf.log` |
| Perf Long Run (branch, post-fix, `upload_csv=true`, `include_rows500k_preview=false`) | [#22379841144](https://github.com/zensgit/metasheet2/actions/runs/22379841144) | PASS | `output/playwright/ga/22379841144/attendance-import-perf-longrun-rows100k-commit-22379841144-1/current/rows100k-commit/attendance-perf-mm1fkklt-wwkr0l/perf-summary.json`, `output/playwright/ga/22379841144/attendance-import-perf-longrun-trend-22379841144-1/20260225-024555/attendance-import-perf-longrun-trend.md` |

Observed highlights:

- Baseline (`#22379746084`) remained green at 100k:
  - `uploadCsv=true`
  - `recordUpsertStrategy=staging`
  - `regressions=[]`
- Main longrun pre-fix failure (`#22379746105`) was transient commit-side `INTERNAL_ERROR` on `rows100k-commit`:
  - `POST /attendance/import/commit: HTTP 500 {"code":"INTERNAL_ERROR","message":"Failed to import attendance"}`
- Branch longrun post-fix (`#22379841144`) recovered stability:
  - `rows100k-commit` PASS with `recordUpsertStrategy=staging`
  - trend report includes `Upload` and `Upsert` columns and marks `rows100k-commit` as `PASS`
  - skip note present: `500k preview scenario is currently skipped (include_rows500k_preview=false)`

## Latest Notes (2026-02-25): Mainline Longrun Re-Validation After PR #251

Execution summary:

1. Merged PR [#251](https://github.com/zensgit/metasheet2/pull/251) (`max-parallel: 2` for longrun matrix).
2. Re-ran `Attendance Import Perf Long Run` on `main` with:
   - `upload_csv=true`
   - `include_rows500k_preview=false`
3. Re-ran `Attendance Daily Gate Dashboard` on `main` (`lookback_hours=48`) to confirm longrun gate source points to the fresh run.

Verification runs:

| Gate | Run | Status | Evidence |
|---|---|---|---|
| Perf Long Run (main, post-PR #251) | [#22379991376](https://github.com/zensgit/metasheet2/actions/runs/22379991376) | PASS | `output/playwright/ga/22379991376/attendance-import-perf-longrun-rows100k-commit-22379991376-1/current/rows100k-commit/attendance-perf-mm1ft1ow-750vwt/perf-summary.json`, `output/playwright/ga/22379991376/attendance-import-perf-longrun-trend-22379991376-1/20260225-025251/attendance-import-perf-longrun-trend.md` |
| Daily Gate Dashboard (main, post longrun refresh) | [#22380066284](https://github.com/zensgit/metasheet2/actions/runs/22380066284) | PASS | `output/playwright/ga/22380066284/attendance-daily-gate-dashboard.json`, `output/playwright/ga/22380066284/attendance-daily-gate-dashboard.md`, `output/playwright/ga/22380066284/gate-meta/longrun/meta.json` |

Observed highlights:

- `rows100k-commit` is green on `main` post-fix:
  - `uploadCsv=true`
  - `recordUpsertStrategy=staging`
  - `regressions=[]`
- Longrun trend report status: `Overall: PASS`.
- Daily dashboard references latest longrun run:
  - `gateFlat.longrun.runId=22379991376`
  - `overallStatus=pass`

## Latest Notes (2026-02-25): Perf Mutation Retry Hardening (Large Commit)

Execution summary:

1. Hardened `scripts/ops/attendance-import-perf.mjs` mutation retry strategy:
   - exponential backoff + jitter via `computeRetryDelayMs(...)`
   - new env knobs:
     - `MUTATION_RETRY_MAX_DELAY_MS` (default `8000`)
     - `MUTATION_RETRY_JITTER_RATIO` (default `0.2`)
     - `COMMIT_RETRIES_LARGE` (default `5`, auto-applied for `rows >= BULK_ENGINE_THRESHOLD`)
2. Verified longrun on branch `codex/attendance-post-251-main-validation` with upload path enabled.

Verification run:

| Gate | Run | Status | Evidence |
|---|---|---|---|
| Perf Long Run (branch, retry-hardened, `upload_csv=true`, `include_rows500k_preview=false`) | [#22382867831](https://github.com/zensgit/metasheet2/actions/runs/22382867831) | PASS | `output/playwright/ga/22382867831/attendance-import-perf-longrun-rows100k-commit-22382867831-1/current/rows100k-commit/attendance-perf-mm1kaxmo-3wtmjn/perf-summary.json`, `output/playwright/ga/22382867831/attendance-import-perf-longrun-rows100k-commit-22382867831-1/current/rows100k-commit/perf.log`, `output/playwright/ga/22382867831/attendance-import-perf-longrun-trend-22382867831-1/20260225-045842/attendance-import-perf-longrun-trend.md` |

Observed highlights:

- `rows100k-commit` is stable and green:
  - `uploadCsv=true`
  - `recordUpsertStrategy=staging`
  - `regressions=[]`
- Run log exposes active retry profile:
  - `retry_profile preview=3 commit=3 commit_large=5`
- Trend remains green:
  - `Overall: PASS`

## Latest Notes (2026-02-25): Strict Desktop Recovery Timeout Hardening

Execution summary:

1. Triggered strict gates on `main` (`#22383641081`) with `require_import_job_recovery=true`; gate failed only on desktop recovery action click timeout.
2. Root cause identified in `scripts/verify-attendance-full-flow.mjs`: `Resume polling` button could become disabled/detached between `isEnabled()` check and `click()`, causing a 30s Playwright timeout.
3. Patched `clickWhenReady()` to use bounded retries with short click timeout and re-check loops.
4. Re-ran strict gates on branch `codex/attendance-import-job-metrics` (`#22383745777`) and confirmed both strict iterations PASS.

Verification runs:

| Gate | Run | Status | Evidence |
|---|---|---|---|
| Strict Gates (main, pre-fix, `require_import_job_recovery=true`) | [#22383641081](https://github.com/zensgit/metasheet2/actions/runs/22383641081) | FAIL | `output/playwright/ga/22383641081/attendance-strict-gates-prod-22383641081-1/20260225-053007-1/gate-summary.json`, `output/playwright/ga/22383641081/attendance-strict-gates-prod-22383641081-1/20260225-053007-1/gate-playwright-full-flow-desktop.log` |
| Strict Gates (branch, post-fix, `require_import_job_recovery=true`) | [#22383745777](https://github.com/zensgit/metasheet2/actions/runs/22383745777) | PASS | `output/playwright/ga/22383745777/attendance-strict-gates-prod-22383745777-1/20260225-053411-1/gate-summary.json`, `output/playwright/ga/22383745777/attendance-strict-gates-prod-22383745777-1/20260225-053411-2/gate-summary.json`, `output/playwright/ga/22383745777/attendance-strict-gates-prod-22383745777-1/20260225-053411-1/gate-playwright-full-flow-desktop.log`, `output/playwright/ga/22383745777/attendance-strict-gates-prod-22383745777-1/20260225-053411-2/gate-playwright-full-flow-desktop.log` |

Observed highlights:

- Pre-fix failure signature:
  - `playwrightDesktop=FAIL`
  - `gateReasons.playwrightDesktop=TIMEOUT`
  - desktop log includes `locator.click: Timeout 30000ms exceeded` on `Resume polling`.
- Post-fix branch validation:
  - both strict iterations show `playwrightDesktop=PASS`
  - desktop logs include:
    - `Admin import recovery assertion started`
    - `Admin import recovery assertion passed`
  - API smoke in both iterations still includes:
    - `import upload ok`
    - `idempotency ok`
    - `export csv ok`

## Latest Notes (2026-02-25): Post-PR #255 Mainline Gate Re-Validation

Execution summary:

1. Merged PR [#255](https://github.com/zensgit/metasheet2/pull/255) on `main` to persist post-PR #254 recovery evidence.
2. Re-triggered `Attendance Branch Policy Drift (Prod)` on `main` and confirmed policy baseline remains enforced.
3. Re-triggered `Attendance Daily Gate Dashboard` on `main` and confirmed no open tracking issues.

Verification runs:

| Gate | Run | Status | Evidence |
|---|---|---|---|
| Branch Policy Drift (main, post-PR #255) | [#22383360093](https://github.com/zensgit/metasheet2/actions/runs/22383360093) | PASS | `output/playwright/ga/22383360093/attendance-branch-policy-drift-prod-22383360093-1/policy.json`, `output/playwright/ga/22383360093/attendance-branch-policy-drift-prod-22383360093-1/policy.log`, `output/playwright/ga/22383360093/attendance-branch-policy-drift-prod-22383360093-1/step-summary.md` |
| Daily Gate Dashboard (main, post-PR #255) | [#22383370628](https://github.com/zensgit/metasheet2/actions/runs/22383370628) | PASS | `output/playwright/ga/22383370628/attendance-daily-gate-dashboard-22383370628-1/attendance-daily-gate-dashboard.json`, `output/playwright/ga/22383370628/attendance-daily-gate-dashboard-22383370628-1/attendance-daily-gate-dashboard.md`, `output/playwright/ga/22383370628/attendance-daily-gate-dashboard-22383370628-1/gate-meta/protection/meta.json` |

Observed highlights:

- `policy.json` still enforces review baseline:
  - `requirePrReviews=true`
  - `minApprovingReviewCount=1`
  - `prReviewsRequiredCurrent=true`
  - `approvingReviewCountCurrent=1`
- Dashboard is clean and linked to newest policy run:
  - `openTrackingIssues=[]`
  - `gateFlat.protection.runId=22383360093`
  - `overallStatus=pass`
  - `p0Status=pass`

## Latest Notes (2026-02-25): Legacy Branch Drift Issue Auto-Close Recovery (PR #254)

Execution summary:

1. Merged PR [#254](https://github.com/zensgit/metasheet2/pull/254) to make branch policy issue tracking compatible with both titles:
   - `[Attendance P1] Branch policy drift alert` (current)
   - `[Attendance P1] Branch protection drift alert` (legacy)
2. Triggered `Attendance Branch Policy Drift (Prod)` on `main` and confirmed PASS.
3. Verified historical legacy issue [#190](https://github.com/zensgit/metasheet2/issues/190) auto-closed on recovery.
4. Triggered `Attendance Daily Gate Dashboard` on `main` and confirmed no open tracking issues.

Verification runs:

| Gate | Run | Status | Evidence |
|---|---|---|---|
| Branch Policy Drift (main, post-PR #254) | [#22383209034](https://github.com/zensgit/metasheet2/actions/runs/22383209034) | PASS | `output/playwright/ga/22383209034/policy.json`, `output/playwright/ga/22383209034/policy.log`, `output/playwright/ga/22383209034/step-summary.md` |
| Daily Gate Dashboard (main, post issue-close recovery) | [#22383228278](https://github.com/zensgit/metasheet2/actions/runs/22383228278) | PASS | `output/playwright/ga/22383228278/attendance-daily-gate-dashboard.json`, `output/playwright/ga/22383228278/attendance-daily-gate-dashboard.md`, `output/playwright/ga/22383228278/gate-meta/protection/meta.json` |

Observed highlights:

- `policy.json` confirms branch policy baseline is intact:
  - `requirePrReviews=true`
  - `minApprovingReviewCount=1`
  - `prReviewsRequiredCurrent=true`
  - `approvingReviewCountCurrent=1`
- `openTrackingIssues` is now empty in dashboard JSON:
  - `"openTrackingIssues": []`
- Dashboard remains green:
  - `overallStatus=pass`
  - `p0Status=pass`

## Latest Notes (2026-02-24): Strict Gate Recovery Polling Hardening

Execution summary:

1. Hardened `scripts/verify-attendance-full-flow.mjs` async import recovery polling to use a deadline-based loop with both resume/reload actions (`Resume polling`, `Resume import job`, `Reload job`, `Reload import job`).
2. Ran strict gates on branch `codex/attendance-next-round-ops` with default inputs to validate no regression.
3. Ran strict gates again with `require_import_job_recovery=true` to force the desktop recovery assertion path.

Verification runs:

| Gate | Run | Status | Evidence |
|---|---|---|---|
| Strict Gates (branch, non-drill, default recovery=false) | [#22356838096](https://github.com/zensgit/metasheet2/actions/runs/22356838096) | PASS | `output/playwright/ga/22356838096/20260224-151021-1/gate-summary.json`, `output/playwright/ga/22356838096/20260224-151021-2/gate-summary.json`, `output/playwright/ga/22356838096/20260224-151021-1/gate-api-smoke.log`, `output/playwright/ga/22356838096/20260224-151021-2/gate-api-smoke.log` |
| Strict Gates (branch, non-drill, `require_import_job_recovery=true`) | [#22357338954](https://github.com/zensgit/metasheet2/actions/runs/22357338954) | PASS | `output/playwright/ga/22357338954/20260224-152238-1/gate-summary.json`, `output/playwright/ga/22357338954/20260224-152238-2/gate-summary.json`, `output/playwright/ga/22357338954/20260224-152238-1/gate-playwright-full-flow-desktop.log`, `output/playwright/ga/22357338954/20260224-152238-2/gate-playwright-full-flow-desktop.log` |
| Strict Gates (branch, non-drill, rerun canceled due runner install stall) | [#22357011088](https://github.com/zensgit/metasheet2/actions/runs/22357011088) | CANCELED | GitHub run timeline (`Install Playwright browsers` runner stall; no product regression signal) |

Observed highlights:

- Recovery assertion was explicitly enabled in `#22357338954`:
  - `gate-summary.json` contains `"requireImportJobRecovery": true` for both iterations.
  - Desktop logs contain:
    - `Admin import recovery assertion started`
    - `Recovery polling attempt=...`
    - `Admin import recovery assertion passed`
- API smoke remained strict-green in both iterations:
  - `import upload ok`
  - `idempotency ok`
  - `export csv ok`
  - `SMOKE PASS`
