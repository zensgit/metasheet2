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
PERF_BASELINE_PAYLOAD_SOURCE="${PERF_BASELINE_PAYLOAD_SOURCE:-auto}"
PERF_BASELINE_CSV_ROWS_LIMIT_HINT="${PERF_BASELINE_CSV_ROWS_LIMIT_HINT:-20000}"
PERF_BASELINE_MAX_PREVIEW_MS="${PERF_BASELINE_MAX_PREVIEW_MS:-}"
PERF_BASELINE_MAX_COMMIT_MS="${PERF_BASELINE_MAX_COMMIT_MS:-}"
PERF_BASELINE_MAX_EXPORT_MS="${PERF_BASELINE_MAX_EXPORT_MS:-}"
PERF_BASELINE_MAX_ROLLBACK_MS="${PERF_BASELINE_MAX_ROLLBACK_MS:-}"

# Local contract assertions for perf artifacts downloaded from GA run.
PERF_EXPECT_UPLOAD_CSV="${PERF_EXPECT_UPLOAD_CSV:-${PERF_BASELINE_UPLOAD_CSV}}"
PERF_EXPECT_COMMIT_ASYNC="${PERF_EXPECT_COMMIT_ASYNC:-${PERF_BASELINE_COMMIT_ASYNC}}"
PERF_EXPECT_ROWS_MIN="${PERF_EXPECT_ROWS_MIN:-${PERF_BASELINE_ROWS}}"
PERF_EXPECT_MODE="${PERF_EXPECT_MODE:-${PERF_BASELINE_MODE}}"
PERF_EXPECT_UPLOAD_CSV_REQUESTED="${PERF_EXPECT_UPLOAD_CSV_REQUESTED:-${PERF_BASELINE_UPLOAD_CSV}}"
PERF_EXPECT_PAYLOAD_SOURCE="${PERF_EXPECT_PAYLOAD_SOURCE:-}"

if [[ -z "$PERF_EXPECT_PAYLOAD_SOURCE" ]]; then
  perf_rows_num="$(printf '%s' "${PERF_BASELINE_ROWS:-}" | tr -cd '0-9')"
  perf_hint_num="$(printf '%s' "${PERF_BASELINE_CSV_ROWS_LIMIT_HINT:-}" | tr -cd '0-9')"
  [[ -n "$perf_rows_num" ]] || perf_rows_num="0"
  [[ -n "$perf_hint_num" ]] || perf_hint_num="20000"
  perf_payload_mode="$(printf '%s' "${PERF_BASELINE_PAYLOAD_SOURCE:-auto}" | tr '[:upper:]' '[:lower:]')"
  case "$perf_payload_mode" in
    rows|csv)
      PERF_EXPECT_PAYLOAD_SOURCE="$perf_payload_mode"
      ;;
    *)
      if (( perf_rows_num > perf_hint_num )); then
        PERF_EXPECT_PAYLOAD_SOURCE="rows"
      else
        PERF_EXPECT_PAYLOAD_SOURCE="csv"
      fi
      ;;
  esac
fi

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
GATE_LAST_STATUS=''
GATE_LAST_RUN_ID=''
GATE_LAST_RUN_URL=''
GATE_LAST_CONCLUSION=''
GATE_LAST_ARTIFACTS=''

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

function to_bool() {
  local value
  value="$(printf '%s' "${1:-}" | tr '[:upper:]' '[:lower:]')"
  case "$value" in
    1|true|yes|on) echo "true" ;;
    0|false|no|off) echo "false" ;;
    *)
      echo ""
      ;;
  esac
}

function run_perf_baseline_contract_gate() {
  local run_id="$1"
  local run_url="$2"
  local artifacts_dir="$3"
  local log_file="${OUTPUT_ROOT}/gate-perf-baseline-contract.log"

  local expected_upload
  expected_upload="$(to_bool "$PERF_EXPECT_UPLOAD_CSV")"
  local expected_commit_async
  expected_commit_async="$(to_bool "$PERF_EXPECT_COMMIT_ASYNC")"
  local expected_upload_requested
  expected_upload_requested="$(to_bool "$PERF_EXPECT_UPLOAD_CSV_REQUESTED")"
  local expected_mode="${PERF_EXPECT_MODE}"
  local expected_payload_source
  expected_payload_source="$(printf '%s' "${PERF_EXPECT_PAYLOAD_SOURCE:-}" | tr '[:upper:]' '[:lower:]')"
  local expected_rows_min
  expected_rows_min="$(printf '%s' "${PERF_EXPECT_ROWS_MIN:-0}" | tr -cd '0-9')"
  if [[ -z "$expected_rows_min" ]]; then
    expected_rows_min="0"
  fi

  {
    echo "[attendance-post-merge-verify] validating perf artifact contract"
    echo "run_id=${run_id}"
    echo "artifacts_dir=${artifacts_dir}"
    echo "expected_upload_csv=${expected_upload:-<skip>}"
    echo "expected_upload_csv_requested=${expected_upload_requested:-<skip>}"
    echo "expected_payload_source=${expected_payload_source:-<skip>}"
    echo "expected_commit_async=${expected_commit_async:-<skip>}"
    echo "expected_rows_min=${expected_rows_min}"
    echo "expected_mode=${expected_mode:-<skip>}"
  } >"$log_file"

  if [[ -z "$artifacts_dir" || ! -d "$artifacts_dir" ]]; then
    failures=$((failures + 1))
    echo "ERROR: artifacts dir missing" >>"$log_file"
    append_result "perf-baseline-contract" "local-assert" "$run_id" "FAIL" "artifacts_missing" "$run_url" "$artifacts_dir"
    return 1
  fi

  local summary_path=''
  summary_path="$(find "$artifacts_dir" -type f -name 'perf-summary.json' | head -n 1 || true)"
  if [[ -z "$summary_path" || ! -f "$summary_path" ]]; then
    failures=$((failures + 1))
    echo "ERROR: perf-summary.json not found" >>"$log_file"
    append_result "perf-baseline-contract" "local-assert" "$run_id" "FAIL" "summary_missing" "$run_url" "$artifacts_dir"
    return 1
  fi

  local actual_upload actual_upload_requested actual_payload_source actual_commit_async actual_rows actual_mode
  actual_upload="$(jq -r '.uploadCsv' "$summary_path" 2>/dev/null || echo '')"
  actual_upload_requested="$(jq -r '.uploadCsvRequested // empty' "$summary_path" 2>/dev/null || echo '')"
  actual_payload_source="$(jq -r '.payloadSource // empty' "$summary_path" 2>/dev/null || echo '')"
  actual_commit_async="$(jq -r '.commitAsync' "$summary_path" 2>/dev/null || echo '')"
  actual_rows="$(jq -r '.rows' "$summary_path" 2>/dev/null || echo '')"
  actual_mode="$(jq -r '.mode // empty' "$summary_path" 2>/dev/null || echo '')"

  {
    echo "summary_path=${summary_path}"
    echo "actual_upload_csv=${actual_upload}"
    echo "actual_upload_csv_requested=${actual_upload_requested}"
    echo "actual_payload_source=${actual_payload_source}"
    echo "actual_commit_async=${actual_commit_async}"
    echo "actual_rows=${actual_rows}"
    echo "actual_mode=${actual_mode}"
  } >>"$log_file"

  local errors=()
  if [[ -n "$expected_upload" ]]; then
    local actual_upload_bool
    actual_upload_bool="$(to_bool "$actual_upload")"
    if [[ "$actual_upload_bool" != "$expected_upload" ]]; then
      errors+=("uploadCsv mismatch (expected=${expected_upload} actual=${actual_upload})")
    fi
  fi

  if [[ -n "$expected_commit_async" ]]; then
    local actual_commit_async_bool
    actual_commit_async_bool="$(to_bool "$actual_commit_async")"
    if [[ "$actual_commit_async_bool" != "$expected_commit_async" ]]; then
      errors+=("commitAsync mismatch (expected=${expected_commit_async} actual=${actual_commit_async})")
    fi
  fi

  if [[ -n "$expected_upload_requested" ]]; then
    local actual_upload_requested_bool
    actual_upload_requested_bool="$(to_bool "$actual_upload_requested")"
    if [[ "$actual_upload_requested_bool" != "$expected_upload_requested" ]]; then
      errors+=("uploadCsvRequested mismatch (expected=${expected_upload_requested} actual=${actual_upload_requested})")
    fi
  fi

  if [[ -n "$expected_payload_source" ]]; then
    local actual_payload_source_normalized
    actual_payload_source_normalized="$(printf '%s' "${actual_payload_source:-}" | tr '[:upper:]' '[:lower:]')"
    if [[ "$actual_payload_source_normalized" != "$expected_payload_source" ]]; then
      errors+=("payloadSource mismatch (expected=${expected_payload_source} actual=${actual_payload_source})")
    fi
  fi

  if [[ "$actual_rows" =~ ^[0-9]+$ ]]; then
    if (( actual_rows < expected_rows_min )); then
      errors+=("rows below minimum (expected>=${expected_rows_min} actual=${actual_rows})")
    fi
  else
    errors+=("rows missing/invalid (actual=${actual_rows})")
  fi

  if [[ -n "$expected_mode" && "$actual_mode" != "$expected_mode" ]]; then
    errors+=("mode mismatch (expected=${expected_mode} actual=${actual_mode})")
  fi

  if (( ${#errors[@]} > 0 )); then
    failures=$((failures + 1))
    {
      echo "ERROR: perf contract validation failed"
      for item in "${errors[@]}"; do
        echo "- ${item}"
      done
    } >>"$log_file"
    append_result "perf-baseline-contract" "local-assert" "$run_id" "FAIL" "contract_mismatch" "$run_url" "$summary_path"
    return 1
  fi

  echo "OK: perf contract validation passed" >>"$log_file"
  append_result "perf-baseline-contract" "local-assert" "$run_id" "PASS" "success" "$run_url" "$summary_path"
  info "perf-baseline-contract ok: uploadCsv=${actual_upload} uploadCsvRequested=${actual_upload_requested} payloadSource=${actual_payload_source} commitAsync=${actual_commit_async} rows=${actual_rows} mode=${actual_mode}"
  return 0
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

  GATE_LAST_STATUS="$status"
  GATE_LAST_RUN_ID="$RUN_ID"
  GATE_LAST_RUN_URL="$RUN_URL"
  GATE_LAST_CONCLUSION="$RUN_CONCLUSION"
  GATE_LAST_ARTIFACTS="$RUN_ARTIFACTS"
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
  -f "payload_source=${PERF_BASELINE_PAYLOAD_SOURCE}" \
  -f "csv_rows_limit_hint=${PERF_BASELINE_CSV_ROWS_LIMIT_HINT}" \
  -f "max_preview_ms=${PERF_BASELINE_MAX_PREVIEW_MS}" \
  -f "max_commit_ms=${PERF_BASELINE_MAX_COMMIT_MS}" \
  -f "max_export_ms=${PERF_BASELINE_MAX_EXPORT_MS}" \
  -f "max_rollback_ms=${PERF_BASELINE_MAX_ROLLBACK_MS}"

if [[ "$SKIP_PERF_BASELINE" == "true" ]]; then
  append_result "perf-baseline-contract" "local-assert" "" "SKIP" "" "" ""
elif [[ "$GATE_LAST_STATUS" == "PASS" ]]; then
  run_perf_baseline_contract_gate "$GATE_LAST_RUN_ID" "$GATE_LAST_RUN_URL" "$GATE_LAST_ARTIFACTS" || true
else
  append_result "perf-baseline-contract" "local-assert" "$GATE_LAST_RUN_ID" "SKIP" "upstream_gate_failed" "$GATE_LAST_RUN_URL" "$GATE_LAST_ARTIFACTS"
fi

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
