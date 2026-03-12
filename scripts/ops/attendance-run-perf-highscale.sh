#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

WORKFLOW="${WORKFLOW:-attendance-import-perf-highscale.yml}"
BRANCH="${BRANCH:-main}"
API_BASE="${API_BASE:-http://142.171.239.56:8081/api}"
ROWS="${ROWS:-100000}"
MODE="${MODE:-commit}"
PREVIEW_MODE="${PREVIEW_MODE:-auto}"
COMMIT_ASYNC="${COMMIT_ASYNC:-true}"
UPLOAD_CSV="${UPLOAD_CSV:-true}"
EXPORT_CSV="${EXPORT_CSV:-true}"
PAYLOAD_SOURCE="${PAYLOAD_SOURCE:-auto}"
CSV_ROWS_LIMIT_HINT="${CSV_ROWS_LIMIT_HINT:-100000}"
MAX_PREVIEW_MS="${MAX_PREVIEW_MS:-}"
MAX_COMMIT_MS="${MAX_COMMIT_MS:-}"
MAX_EXPORT_MS="${MAX_EXPORT_MS:-}"
IMPORT_JOB_POLL_TIMEOUT_MS="${IMPORT_JOB_POLL_TIMEOUT_MS:-3600000}"
IMPORT_JOB_POLL_TIMEOUT_LARGE_MS="${IMPORT_JOB_POLL_TIMEOUT_LARGE_MS:-5400000}"
DRILL="${DRILL:-false}"
DRILL_FAIL="${DRILL_FAIL:-false}"
ISSUE_TITLE="${ISSUE_TITLE:-}"
TIMEOUT_SECONDS="${TIMEOUT_SECONDS:-14400}"
DOWNLOAD_ROOT="${DOWNLOAD_ROOT:-output/playwright/attendance-perf-highscale/$(date +%Y%m%d-%H%M%S)}"
DISPATCHER="${DISPATCHER:-$ROOT_DIR/scripts/ops/attendance-run-workflow-dispatch.sh}"

function info() {
  echo "[attendance-run-perf-highscale] $*" >&2
}

function die() {
  echo "[attendance-run-perf-highscale] ERROR: $*" >&2
  exit 1
}

command -v gh >/dev/null 2>&1 || die "gh is required"
command -v jq >/dev/null 2>&1 || die "jq is required"
[[ -x "$DISPATCHER" ]] || die "dispatcher not executable: ${DISPATCHER}"

[[ "$ROWS" =~ ^[0-9]+$ ]] || die "ROWS must be integer"
[[ "$TIMEOUT_SECONDS" =~ ^[0-9]+$ ]] || die "TIMEOUT_SECONDS must be integer"

mkdir -p "$DOWNLOAD_ROOT"

declare -a inputs=(
  "api_base=${API_BASE}"
  "rows=${ROWS}"
  "mode=${MODE}"
  "preview_mode=${PREVIEW_MODE}"
  "commit_async=${COMMIT_ASYNC}"
  "upload_csv=${UPLOAD_CSV}"
  "export_csv=${EXPORT_CSV}"
  "payload_source=${PAYLOAD_SOURCE}"
  "csv_rows_limit_hint=${CSV_ROWS_LIMIT_HINT}"
  "import_job_poll_timeout_ms=${IMPORT_JOB_POLL_TIMEOUT_MS}"
  "import_job_poll_timeout_large_ms=${IMPORT_JOB_POLL_TIMEOUT_LARGE_MS}"
  "drill=${DRILL}"
  "drill_fail=${DRILL_FAIL}"
)
[[ -n "$MAX_PREVIEW_MS" ]] && inputs+=("max_preview_ms=${MAX_PREVIEW_MS}")
[[ -n "$MAX_COMMIT_MS" ]] && inputs+=("max_commit_ms=${MAX_COMMIT_MS}")
[[ -n "$MAX_EXPORT_MS" ]] && inputs+=("max_export_ms=${MAX_EXPORT_MS}")
[[ -n "$ISSUE_TITLE" ]] && inputs+=("issue_title=${ISSUE_TITLE}")

info "dispatch workflow=${WORKFLOW} branch=${BRANCH} rows=${ROWS} mode=${MODE} drill=${DRILL} drill_fail=${DRILL_FAIL}"
dispatch_output="$(
  WORKFLOW="$WORKFLOW" \
  BRANCH="$BRANCH" \
  DOWNLOAD_DIR="${DOWNLOAD_ROOT}/ga" \
  TIMEOUT_SECONDS="$TIMEOUT_SECONDS" \
  "$DISPATCHER" \
  "${inputs[@]}"
)"
printf '%s\n' "$dispatch_output"

run_id="$(printf '%s\n' "$dispatch_output" | awk -F= '/^RUN_ID=/{print $2}' | tail -n1)"
[[ -n "$run_id" ]] || die "failed to parse RUN_ID from dispatcher output"

artifact_root="${DOWNLOAD_ROOT}/ga/${run_id}"
[[ -d "$artifact_root" ]] || die "artifact root missing: ${artifact_root}"

summary_path="$(find "$artifact_root" -type f -name 'perf-summary.json' | sort | tail -n1 || true)"
[[ -n "$summary_path" ]] || die "perf-summary.json not found under ${artifact_root}"

actual_rows="$(jq -r '.rows // empty' "$summary_path")"
actual_mode="$(jq -r '.mode // empty' "$summary_path")"
actual_upload_csv="$(jq -r '.uploadCsv // empty' "$summary_path")"
actual_commit_async="$(jq -r '.commitAsync // empty' "$summary_path")"
actual_payload_source="$(jq -r '.payloadSource // empty' "$summary_path")"
actual_regressions="$(jq -r '(.regressions // []) | length' "$summary_path")"

[[ "$actual_rows" =~ ^[0-9]+$ ]] || die "summary rows missing/invalid: ${actual_rows}"
if (( actual_rows < ROWS )); then
  die "summary rows ${actual_rows} < expected ${ROWS}"
fi
[[ "$actual_mode" == "$MODE" ]] || die "summary mode mismatch: expected=${MODE} actual=${actual_mode}"
[[ "$actual_upload_csv" == "$UPLOAD_CSV" ]] || die "summary uploadCsv mismatch: expected=${UPLOAD_CSV} actual=${actual_upload_csv}"
[[ "$actual_commit_async" == "$COMMIT_ASYNC" ]] || die "summary commitAsync mismatch: expected=${COMMIT_ASYNC} actual=${actual_commit_async}"

if [[ -n "$actual_payload_source" ]]; then
  normalized_actual="$(printf '%s' "$actual_payload_source" | tr '[:upper:]' '[:lower:]')"
  normalized_expected="$(printf '%s' "$PAYLOAD_SOURCE" | tr '[:upper:]' '[:lower:]')"
  case "$normalized_expected" in
    auto|csv|rows)
      if [[ "$normalized_expected" != "auto" && "$normalized_actual" != "$normalized_expected" ]]; then
        die "summary payloadSource mismatch: expected=${normalized_expected} actual=${normalized_actual}"
      fi
      ;;
  esac
fi

summary_md="${DOWNLOAD_ROOT}/summary.md"
summary_json="${DOWNLOAD_ROOT}/summary.json"

cat >"$summary_md" <<EOF
# Attendance Perf High Scale Run

- Workflow: \`${WORKFLOW}\`
- Branch: \`${BRANCH}\`
- Run ID: \`${run_id}\`
- Artifact root: \`${artifact_root}\`
- Summary file: \`${summary_path}\`

## Contract

- rows >= \`${ROWS}\` (actual: \`${actual_rows}\`)
- mode = \`${MODE}\` (actual: \`${actual_mode}\`)
- uploadCsv = \`${UPLOAD_CSV}\` (actual: \`${actual_upload_csv}\`)
- commitAsync = \`${COMMIT_ASYNC}\` (actual: \`${actual_commit_async}\`)
- payloadSource (actual): \`${actual_payload_source:-<missing>}\`
- regressions count: \`${actual_regressions}\`
EOF

jq -n \
  --arg workflow "$WORKFLOW" \
  --arg branch "$BRANCH" \
  --arg runId "$run_id" \
  --arg artifactRoot "$artifact_root" \
  --arg summaryPath "$summary_path" \
  --argjson rowsExpected "$ROWS" \
  --argjson rowsActual "$actual_rows" \
  --arg modeExpected "$MODE" \
  --arg modeActual "$actual_mode" \
  --arg uploadExpected "$UPLOAD_CSV" \
  --arg uploadActual "$actual_upload_csv" \
  --arg commitAsyncExpected "$COMMIT_ASYNC" \
  --arg commitAsyncActual "$actual_commit_async" \
  --arg payloadSourceRequested "$PAYLOAD_SOURCE" \
  --arg payloadSourceActual "$actual_payload_source" \
  --argjson regressionsCount "$actual_regressions" \
  '{
    workflow: $workflow,
    branch: $branch,
    runId: $runId,
    artifactRoot: $artifactRoot,
    summaryPath: $summaryPath,
    contract: {
      rowsExpected: $rowsExpected,
      rowsActual: $rowsActual,
      modeExpected: $modeExpected,
      modeActual: $modeActual,
      uploadExpected: $uploadExpected,
      uploadActual: $uploadActual,
      commitAsyncExpected: $commitAsyncExpected,
      commitAsyncActual: $commitAsyncActual,
      payloadSourceRequested: $payloadSourceRequested,
      payloadSourceActual: ($payloadSourceActual | select(. != "") // null),
      regressionsCount: $regressionsCount
    }
  }' >"$summary_json"

info "PASS: high-scale run verified"
info "summary_md=${summary_md}"
info "summary_json=${summary_json}"

echo "RUN_ID=${run_id}"
echo "ARTIFACT_ROOT=${artifact_root}"
echo "SUMMARY_MD=${summary_md}"
echo "SUMMARY_JSON=${summary_json}"
