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
- Drill runs are tagged with `run-name` suffix `[DRILL]`, and the daily gate dashboard ignores `[DRILL]` runs when selecting the latest completed `Host Metrics` gate run.
- On non-drill failures, this workflow opens/reopens: `[Attendance P1] Host metrics alert` (no paging).
- Safe drill to validate the FAIL-path issue behavior with a safe override title:

```bash
gh workflow run attendance-remote-metrics-prod.yml \
  -f drill_fail=true \
  -f issue_title='[Attendance Metrics Drill] Host metrics issue test'
```
- You can override the target:
  - `METRICS_URL="http://127.0.0.1:8900/metrics/prom" scripts/ops/attendance-check-metrics.sh`

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

- Drill runs are tagged with `run-name` suffix `[DRILL]`, and the daily gate dashboard ignores `[DRILL]` runs when selecting the latest completed `Storage Health` gate run.
- On non-drill failures, this workflow opens/reopens: `[Attendance P1] Storage health alert` (no paging).
- Safe drill to validate the FAIL-path issue behavior with a safe override title:

```bash
gh workflow run attendance-remote-storage-prod.yml \
  -f drill_fail=true \
  -f issue_title='[Attendance Storage Drill] Storage issue test'
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
- Remote preflight is also included as a `P0` gate (config drift detection).
- Open/update GitHub issue `[Attendance Gate] Daily dashboard alert` only when **P0** status is `FAIL` (Remote preflight / strict gate failure).
- P1/P2 findings still make the workflow `FAIL` (for visibility), but do not page via the `[Attendance Gate]` escalation issue.

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
