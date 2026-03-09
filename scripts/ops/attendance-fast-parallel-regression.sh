#!/usr/bin/env bash
set -u

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

timestamp="$(date +%Y%m%d-%H%M%S)"
OUTPUT_ROOT="${OUTPUT_ROOT:-output/playwright/attendance-fast-parallel-regression/${timestamp}}"
RUN_CONTRACT_CASES="${RUN_CONTRACT_CASES:-true}"

mkdir -p "$OUTPUT_ROOT"
RESULTS_TSV="${OUTPUT_ROOT}/results.tsv"
SUMMARY_MD="${OUTPUT_ROOT}/summary.md"
SUMMARY_JSON="${OUTPUT_ROOT}/summary.json"

echo -e "check\tstatus\trc\tlog" >"$RESULTS_TSV"

function info() {
  echo "[attendance-fast-parallel-regression] $*" >&2
}

function slugify() {
  local raw="$1"
  raw="$(printf '%s' "$raw" | tr '[:upper:]' '[:lower:]')"
  raw="$(printf '%s' "$raw" | sed -E 's/[^a-z0-9]+/-/g; s/^-+|-+$//g')"
  printf '%s' "${raw:-check}"
}

declare -a CHECK_NAMES=()
declare -a CHECK_CMDS=()
declare -a CHECK_PIDS=()
declare -a CHECK_RESULT_FILES=()

function add_check() {
  CHECK_NAMES+=("$1")
  CHECK_CMDS+=("$2")
}

function run_check_async() {
  local index="$1"
  local name="${CHECK_NAMES[$index]}"
  local cmd="${CHECK_CMDS[$index]}"
  local slug log result_file
  slug="$(slugify "$name")"
  log="${OUTPUT_ROOT}/${slug}.log"
  result_file="${OUTPUT_ROOT}/result-${index}.tsv"
  CHECK_RESULT_FILES[$index]="$result_file"

  (
    local rc=0
    if bash -c "cd \"$ROOT_DIR\" && $cmd" >"$log" 2>&1; then
      echo -e "${name}\tPASS\t0\t${log}" >"$result_file"
    else
      rc=$?
      echo -e "${name}\tFAIL\t${rc}\t${log}" >"$result_file"
    fi
  ) &
  CHECK_PIDS[$index]=$!
}

add_check \
  "ops-auth-scripts-tests" \
  "node --test scripts/ops/attendance-auth-scripts.test.mjs"

add_check \
  "ops-dispatcher-tests" \
  "node --test scripts/ops/attendance-run-workflow-dispatch.test.mjs"

add_check \
  "ops-telemetry-utils-tests" \
  "node --test scripts/ops/attendance-import-telemetry-utils.test.mjs"

add_check \
  "ops-daily-gate-report-tests" \
  "node --test scripts/ops/attendance-daily-gate-report.test.mjs"

if [[ "$RUN_CONTRACT_CASES" == "true" ]]; then
  add_check \
    "contract-strict" \
    "bash scripts/ops/attendance-run-gate-contract-case.sh strict \"$OUTPUT_ROOT/contracts\""

  add_check \
    "contract-dashboard" \
    "bash scripts/ops/attendance-run-gate-contract-case.sh dashboard \"$OUTPUT_ROOT/contracts\""
fi

total_checks="${#CHECK_NAMES[@]}"
info "starting ${total_checks} checks in parallel"

for index in "${!CHECK_NAMES[@]}"; do
  run_check_async "$index"
done

for index in "${!CHECK_PIDS[@]}"; do
  pid="${CHECK_PIDS[$index]}"
  if [[ -n "$pid" ]]; then
    wait "$pid" || true
  fi
done

for index in "${!CHECK_RESULT_FILES[@]}"; do
  result_file="${CHECK_RESULT_FILES[$index]}"
  if [[ -f "$result_file" ]]; then
    cat "$result_file" >>"$RESULTS_TSV"
  else
    name="${CHECK_NAMES[$index]}"
    echo -e "${name}\tFAIL\t99\tmissing-result-file:${result_file}" >>"$RESULTS_TSV"
  fi
done

pass_count="$(awk -F'\t' 'NR>1 && $2=="PASS" {c++} END {print c+0}' "$RESULTS_TSV")"
fail_count="$(awk -F'\t' 'NR>1 && $2=="FAIL" {c++} END {print c+0}' "$RESULTS_TSV")"
skip_count="$(awk -F'\t' 'NR>1 && $2=="SKIP" {c++} END {print c+0}' "$RESULTS_TSV")"
total_count="$(awk -F'\t' 'NR>1 {c++} END {print c+0}' "$RESULTS_TSV")"

{
  echo "# Attendance Fast Parallel Regression Summary"
  echo
  echo "- Timestamp: ${timestamp}"
  echo "- Output root: \`${OUTPUT_ROOT}\`"
  echo "- Totals: ${total_count} checks, ${pass_count} pass, ${fail_count} fail, ${skip_count} skip"
  echo
  echo "| Check | Status | RC | Log |"
  echo "|---|---|---|---|"
  awk -F'\t' 'NR>1 {printf "| %s | %s | %s | `%s` |\n", $1, $2, $3, $4}' "$RESULTS_TSV"
} >"$SUMMARY_MD"

python3 - "$RESULTS_TSV" "$SUMMARY_JSON" "$timestamp" "$OUTPUT_ROOT" <<'PY'
import json
import sys
from pathlib import Path

results_tsv = Path(sys.argv[1])
summary_json = Path(sys.argv[2])
timestamp = sys.argv[3]
output_root = sys.argv[4]

rows = []
with results_tsv.open() as f:
    next(f, None)
    for line in f:
        parts = line.rstrip("\n").split("\t")
        if len(parts) < 4:
            continue
        rc = parts[2]
        try:
            rc_value = int(rc)
        except ValueError:
            rc_value = 99
        rows.append({
            "check": parts[0],
            "status": parts[1],
            "rc": rc_value,
            "log": parts[3],
        })

payload = {
    "timestamp": timestamp,
    "outputRoot": output_root,
    "totals": {
        "total": len(rows),
        "pass": sum(1 for r in rows if r["status"] == "PASS"),
        "fail": sum(1 for r in rows if r["status"] == "FAIL"),
        "skip": sum(1 for r in rows if r["status"] == "SKIP"),
    },
    "checks": rows,
}
summary_json.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n")
PY

cat "$SUMMARY_MD"

if [[ "$fail_count" -gt 0 ]]; then
  info "FAILED: ${fail_count} checks failed"
  exit 1
fi

info "PASS: all checks passed"
exit 0
