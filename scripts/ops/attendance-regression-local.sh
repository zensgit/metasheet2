#!/usr/bin/env bash
set -u

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

timestamp="$(date +%Y%m%d-%H%M%S)"
OUTPUT_ROOT="${OUTPUT_ROOT:-output/playwright/attendance-local-regression/${timestamp}}"
RUN_PLAYWRIGHT="${RUN_PLAYWRIGHT:-false}"
PLAYWRIGHT_MOBILE="${PLAYWRIGHT_MOBILE:-true}"
UI_LOCALE="${UI_LOCALE:-}"

mkdir -p "$OUTPUT_ROOT"
RESULTS_TSV="${OUTPUT_ROOT}/results.tsv"
SUMMARY_MD="${OUTPUT_ROOT}/summary.md"
SUMMARY_JSON="${OUTPUT_ROOT}/summary.json"

echo -e "check\tstatus\trc\tlog" >"$RESULTS_TSV"

function info() {
  echo "[attendance-regression-local] $*" >&2
}

function slugify() {
  local raw="$1"
  raw="$(printf '%s' "$raw" | tr '[:upper:]' '[:lower:]')"
  raw="$(printf '%s' "$raw" | sed -E 's/[^a-z0-9]+/-/g; s/^-+|-+$//g')"
  printf '%s' "${raw:-check}"
}

function run_check() {
  local name="$1"
  local cmd="$2"
  local slug
  local log
  local rc=0
  slug="$(slugify "$name")"
  log="${OUTPUT_ROOT}/${slug}.log"

  info "run: ${name}"
  if bash -c "cd \"$ROOT_DIR\" && $cmd" >"$log" 2>&1; then
    echo -e "${name}\tPASS\t0\t${log}" >>"$RESULTS_TSV"
  else
    rc=$?
    echo -e "${name}\tFAIL\t${rc}\t${log}" >>"$RESULTS_TSV"
  fi
}

backend_vitest_config="vitest.integration.config.ts"
if [[ -f "packages/core-backend/vitest.integration.config.mts" ]]; then
  backend_vitest_config="vitest.integration.config.mts"
fi

run_check \
  "backend-attendance-integration" \
  "cd packages/core-backend && pnpm exec vitest --config ${backend_vitest_config} run tests/integration/attendance-plugin.test.ts"

run_check \
  "web-unit-tests" \
  "pnpm --filter @metasheet/web exec vitest run --watch=false"

run_check \
  "gate-contract-strict" \
  "bash scripts/ops/attendance-run-gate-contract-case.sh strict \"$OUTPUT_ROOT/contract\""

run_check \
  "gate-contract-dashboard" \
  "bash scripts/ops/attendance-run-gate-contract-case.sh dashboard \"$OUTPUT_ROOT/contract\""

if [[ "$RUN_PLAYWRIGHT" == "true" ]]; then
  if [[ -n "${WEB_URL:-}" && -n "${AUTH_TOKEN:-}" ]]; then
    run_check \
      "playwright-full-flow-desktop" \
      "WEB_URL=\"$WEB_URL\" AUTH_TOKEN=\"$AUTH_TOKEN\" UI_LOCALE=\"$UI_LOCALE\" OUTPUT_DIR=\"$OUTPUT_ROOT/playwright-desktop\" node scripts/verify-attendance-full-flow.mjs"
    if [[ "$PLAYWRIGHT_MOBILE" == "true" ]]; then
      run_check \
        "playwright-full-flow-mobile" \
        "WEB_URL=\"$WEB_URL\" AUTH_TOKEN=\"$AUTH_TOKEN\" UI_LOCALE=\"$UI_LOCALE\" UI_MOBILE=true OUTPUT_DIR=\"$OUTPUT_ROOT/playwright-mobile\" node scripts/verify-attendance-full-flow.mjs"
    fi
  else
    info "skip playwright: RUN_PLAYWRIGHT=true but WEB_URL/AUTH_TOKEN missing"
    echo -e "playwright-full-flow\tSKIP\t0\tWEB_URL/AUTH_TOKEN missing" >>"$RESULTS_TSV"
  fi
fi

pass_count="$(awk -F'\t' 'NR>1 && $2=="PASS" {c++} END {print c+0}' "$RESULTS_TSV")"
fail_count="$(awk -F'\t' 'NR>1 && $2=="FAIL" {c++} END {print c+0}' "$RESULTS_TSV")"
skip_count="$(awk -F'\t' 'NR>1 && $2=="SKIP" {c++} END {print c+0}' "$RESULTS_TSV")"
total_count="$(awk -F'\t' 'NR>1 {c++} END {print c+0}' "$RESULTS_TSV")"

{
  echo "# Attendance Local Regression Summary"
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
        rows.append({
            "check": parts[0],
            "status": parts[1],
            "rc": int(parts[2]),
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

info "PASS: all required checks passed"
exit 0
