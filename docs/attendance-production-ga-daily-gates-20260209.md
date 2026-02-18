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
  - `import async idempotency ok`

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

Artifacts:

- Uploaded for 14 days:
  - `output/playwright/attendance-import-perf/**`
  - Includes `perf.log` (stdout/stderr capture) for debugging failures.

P1 tracking issue (no paging): `[Attendance P1] Perf baseline alert` (opened/reopened on failure; commented+closed on recovery).

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
