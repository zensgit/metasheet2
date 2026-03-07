#!/usr/bin/env bash
set -u

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

BRANCH="${BRANCH:-main}"
OUTPUT_ROOT="${OUTPUT_ROOT:-output/playwright/attendance-post-merge-verify/$(date +%Y%m%d-%H%M%S)}"
DOWNLOAD_ARTIFACTS="${DOWNLOAD_ARTIFACTS:-true}"

SKIP_BRANCH_POLICY="${SKIP_BRANCH_POLICY:-false}"
SKIP_STRICT="${SKIP_STRICT:-false}"
SKIP_PERF_BASELINE="${SKIP_PERF_BASELINE:-false}"
SKIP_DASHBOARD="${SKIP_DASHBOARD:-false}"

REQUIRED_CHECKS_CSV="${REQUIRED_CHECKS_CSV:-contracts (strict),contracts (dashboard)}"
REQUIRE_STRICT="${REQUIRE_STRICT:-true}"
REQUIRE_ENFORCE_ADMINS="${REQUIRE_ENFORCE_ADMINS:-true}"
REQUIRE_PR_REVIEWS="${REQUIRE_PR_REVIEWS:-true}"
MIN_APPROVING_REVIEW_COUNT="${MIN_APPROVING_REVIEW_COUNT:-1}"
REQUIRE_CODE_OWNER_REVIEWS="${REQUIRE_CODE_OWNER_REVIEWS:-false}"

API_BASE="${API_BASE:-http://142.171.239.56:8081/api}"
EXPECT_PRODUCT_MODE="${EXPECT_PRODUCT_MODE:-attendance}"
REQUIRE_ATTENDANCE_ADMIN_API="${REQUIRE_ATTENDANCE_ADMIN_API:-true}"
REQUIRE_IDEMPOTENCY="${REQUIRE_IDEMPOTENCY:-true}"
REQUIRE_IMPORT_EXPORT="${REQUIRE_IMPORT_EXPORT:-true}"
REQUIRE_IMPORT_UPLOAD="${REQUIRE_IMPORT_UPLOAD:-true}"
REQUIRE_IMPORT_ASYNC="${REQUIRE_IMPORT_ASYNC:-true}"
REQUIRE_IMPORT_TELEMETRY="${REQUIRE_IMPORT_TELEMETRY:-true}"
REQUIRE_PREVIEW_ASYNC="${REQUIRE_PREVIEW_ASYNC:-true}"
REQUIRE_BATCH_RESOLVE="${REQUIRE_BATCH_RESOLVE:-false}"
REQUIRE_IMPORT_JOB_RECOVERY="${REQUIRE_IMPORT_JOB_RECOVERY:-false}"
REQUIRE_ADMIN_SETTINGS_SAVE="${REQUIRE_ADMIN_SETTINGS_SAVE:-true}"

LOOKBACK_HOURS="${LOOKBACK_HOURS:-48}"

PERF_BASELINE_API_BASE="${PERF_BASELINE_API_BASE:-${API_BASE}}"
PERF_BASELINE_ROWS="${PERF_BASELINE_ROWS:-10000}"
PERF_BASELINE_MODE="${PERF_BASELINE_MODE:-commit}"
PERF_BASELINE_COMMIT_ASYNC="${PERF_BASELINE_COMMIT_ASYNC:-false}"
PERF_BASELINE_EXPORT_CSV="${PERF_BASELINE_EXPORT_CSV:-true}"
PERF_BASELINE_UPLOAD_CSV="${PERF_BASELINE_UPLOAD_CSV:-true}"
PERF_BASELINE_MAX_PREVIEW_MS="${PERF_BASELINE_MAX_PREVIEW_MS:-}"
PERF_BASELINE_MAX_COMMIT_MS="${PERF_BASELINE_MAX_COMMIT_MS:-}"
PERF_BASELINE_MAX_EXPORT_MS="${PERF_BASELINE_MAX_EXPORT_MS:-}"
PERF_BASELINE_MAX_ROLLBACK_MS="${PERF_BASELINE_MAX_ROLLBACK_MS:-}"

mkdir -p "$OUTPUT_ROOT"
RESULTS_TSV="${OUTPUT_ROOT}/results.tsv"
SUMMARY_MD="${OUTPUT_ROOT}/summary.md"
SUMMARY_JSON="${OUTPUT_ROOT}/summary.json"

echo -e "gate\tworkflow\trun_id\tstatus\tconclusion\turl\tartifacts" >"$RESULTS_TSV"

function info() {
  echo "[attendance-post-merge-verify] $*" >&2
}

function die() {
  echo "[attendance-post-merge-verify] ERROR: $*" >&2
  exit 1
}

function require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "required command not found: $1"
}

require_cmd gh
require_cmd jq
require_cmd python3

RUN_ID=''
RUN_URL=''
RUN_CONCLUSION=''
RUN_ARTIFACTS=''

function append_result() {
  local gate="$1"
  local workflow="$2"
  local run_id="$3"
  local status="$4"
  local conclusion="$5"
  local url="$6"
  local artifacts="$7"
  echo -e "${gate}\t${workflow}\t${run_id}\t${status}\t${conclusion}\t${url}\t${artifacts}" >>"$RESULTS_TSV"
}

function trigger_and_wait() {
  local workflow="$1"
  shift
  local -a args=("$@")
  local before_id=''
  local run_id=''
  local run_json=''
  local attempt

  before_id="$(gh run list --workflow "$workflow" --branch "$BRANCH" --limit 1 --json databaseId --jq '.[0].databaseId // 0' 2>/dev/null || echo '0')"
  if [[ -z "$before_id" ]]; then
    before_id='0'
  fi

  info "dispatch workflow: ${workflow} (branch=${BRANCH})"
  gh workflow run "$workflow" --ref "$BRANCH" "${args[@]}" >/dev/null

  for attempt in $(seq 1 60); do
    run_json="$(gh run list --workflow "$workflow" --branch "$BRANCH" --limit 20 --json databaseId,event,conclusion,status,url,createdAt 2>/dev/null || echo '[]')"
    run_id="$(printf '%s' "$run_json" | jq -r --arg before "${before_id}" '
      map(select(.event == "workflow_dispatch"))
      | map(select((.databaseId | tonumber) > ($before | tonumber)))
      | sort_by(.databaseId)
      | last
      | .databaseId // empty
    ')"
    if [[ -n "$run_id" ]]; then
      break
    fi
    sleep 2
  done

  [[ -n "$run_id" ]] || return 2

  info "watch run: ${run_id}"
  gh run watch "$run_id" --exit-status
  local watch_rc=$?

  run_json="$(gh run view "$run_id" --json databaseId,url,conclusion,status 2>/dev/null || echo '{}')"
  RUN_ID="$(printf '%s' "$run_json" | jq -r '.databaseId // empty')"
  RUN_URL="$(printf '%s' "$run_json" | jq -r '.url // empty')"
  RUN_CONCLUSION="$(printf '%s' "$run_json" | jq -r '.conclusion // empty')"
  RUN_ARTIFACTS=''

  if [[ "$DOWNLOAD_ARTIFACTS" == "true" && -n "$RUN_ID" ]]; then
    local artifacts_dir="${OUTPUT_ROOT}/ga/${RUN_ID}"
    mkdir -p "$artifacts_dir"
    if gh run download "$RUN_ID" -D "$artifacts_dir" >"${artifacts_dir}/download.log" 2>&1; then
      RUN_ARTIFACTS="$artifacts_dir"
    else
      RUN_ARTIFACTS="${artifacts_dir} (download failed; see download.log)"
    fi
  fi

  return "$watch_rc"
}

failures=0

function run_gate() {
  local gate="$1"
  local workflow="$2"
  local skip="$3"
  shift 3
  local -a args=("$@")

  if [[ "$skip" == "true" ]]; then
    info "skip gate: ${gate}"
    append_result "$gate" "$workflow" "" "SKIP" "" "" ""
    return 0
  fi

  local status='PASS'
  local rc=0
  if ! trigger_and_wait "$workflow" "${args[@]}"; then
    rc=$?
    status='FAIL'
    failures=$((failures + 1))
  fi

  append_result "$gate" "$workflow" "$RUN_ID" "$status" "$RUN_CONCLUSION" "$RUN_URL" "$RUN_ARTIFACTS"
  info "gate result: ${gate} status=${status} run_id=${RUN_ID} conclusion=${RUN_CONCLUSION} rc=${rc}"
}

run_gate \
  "branch-policy" \
  "attendance-branch-policy-drift-prod.yml" \
  "$SKIP_BRANCH_POLICY" \
  -f "branch=${BRANCH}" \
  -f "required_checks_csv=${REQUIRED_CHECKS_CSV}" \
  -f "require_strict=${REQUIRE_STRICT}" \
  -f "require_enforce_admins=${REQUIRE_ENFORCE_ADMINS}" \
  -f "require_pr_reviews=${REQUIRE_PR_REVIEWS}" \
  -f "min_approving_review_count=${MIN_APPROVING_REVIEW_COUNT}" \
  -f "require_code_owner_reviews=${REQUIRE_CODE_OWNER_REVIEWS}" \
  -f "drill_fail=false"

run_gate \
  "strict-gates" \
  "attendance-strict-gates-prod.yml" \
  "$SKIP_STRICT" \
  -f "drill=false" \
  -f "api_base=${API_BASE}" \
  -f "expect_product_mode=${EXPECT_PRODUCT_MODE}" \
  -f "require_attendance_admin_api=${REQUIRE_ATTENDANCE_ADMIN_API}" \
  -f "require_idempotency=${REQUIRE_IDEMPOTENCY}" \
  -f "require_import_export=${REQUIRE_IMPORT_EXPORT}" \
  -f "require_import_upload=${REQUIRE_IMPORT_UPLOAD}" \
  -f "require_import_async=${REQUIRE_IMPORT_ASYNC}" \
  -f "require_import_telemetry=${REQUIRE_IMPORT_TELEMETRY}" \
  -f "require_preview_async=${REQUIRE_PREVIEW_ASYNC}" \
  -f "require_batch_resolve=${REQUIRE_BATCH_RESOLVE}" \
  -f "require_import_job_recovery=${REQUIRE_IMPORT_JOB_RECOVERY}" \
  -f "require_admin_settings_save=${REQUIRE_ADMIN_SETTINGS_SAVE}"

run_gate \
  "perf-baseline" \
  "attendance-import-perf-baseline.yml" \
  "$SKIP_PERF_BASELINE" \
  -f "drill=false" \
  -f "api_base=${PERF_BASELINE_API_BASE}" \
  -f "rows=${PERF_BASELINE_ROWS}" \
  -f "mode=${PERF_BASELINE_MODE}" \
  -f "commit_async=${PERF_BASELINE_COMMIT_ASYNC}" \
  -f "export_csv=${PERF_BASELINE_EXPORT_CSV}" \
  -f "upload_csv=${PERF_BASELINE_UPLOAD_CSV}" \
  -f "max_preview_ms=${PERF_BASELINE_MAX_PREVIEW_MS}" \
  -f "max_commit_ms=${PERF_BASELINE_MAX_COMMIT_MS}" \
  -f "max_export_ms=${PERF_BASELINE_MAX_EXPORT_MS}" \
  -f "max_rollback_ms=${PERF_BASELINE_MAX_ROLLBACK_MS}"

run_gate \
  "daily-dashboard" \
  "attendance-daily-gate-dashboard.yml" \
  "$SKIP_DASHBOARD" \
  -f "branch=${BRANCH}" \
  -f "lookback_hours=${LOOKBACK_HOURS}" \
  -f "include_drill_runs=false"

{
  echo "# Attendance Post-Merge Verification Summary"
  echo
  echo "- Branch: \`${BRANCH}\`"
  echo "- Output root: \`${OUTPUT_ROOT}\`"
  echo "- Failures: \`${failures}\`"
  echo
  echo "| Gate | Workflow | Run ID | Status | Conclusion | URL | Artifacts |"
  echo "|---|---|---|---|---|---|---|"
  awk -F'\t' 'NR>1 {printf "| %s | %s | %s | %s | %s | %s | `%s` |\n", $1, $2, $3, $4, $5, $6, $7}' "$RESULTS_TSV"
} >"$SUMMARY_MD"

python3 - "$RESULTS_TSV" "$SUMMARY_JSON" "$BRANCH" "$OUTPUT_ROOT" "$failures" <<'PY'
import json
import sys
from pathlib import Path

results_tsv = Path(sys.argv[1])
summary_json = Path(sys.argv[2])
branch = sys.argv[3]
output_root = sys.argv[4]
failures = int(sys.argv[5])

rows = []
with results_tsv.open() as f:
    next(f, None)
    for line in f:
        gate, workflow, run_id, status, conclusion, url, artifacts = line.rstrip('\n').split('\t')
        rows.append({
            "gate": gate,
            "workflow": workflow,
            "runId": int(run_id) if run_id.isdigit() else None,
            "status": status,
            "conclusion": conclusion or None,
            "url": url or None,
            "artifacts": artifacts or None,
        })

payload = {
    "branch": branch,
    "outputRoot": output_root,
    "failures": failures,
    "status": "pass" if failures == 0 else "fail",
    "gates": rows,
}
summary_json.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n")
PY

cat "$SUMMARY_MD"

if [[ "$failures" -gt 0 ]]; then
  exit 1
fi

exit 0
