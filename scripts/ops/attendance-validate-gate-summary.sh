#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="${1:-output/playwright/attendance-prod-acceptance}"
EXPECT_MIN_SUMMARIES="${2:-1}"

function die() {
  echo "[attendance-validate-gate-summary] ERROR: $*" >&2
  exit 1
}

function info() {
  echo "[attendance-validate-gate-summary] $*" >&2
}

if [[ ! "$EXPECT_MIN_SUMMARIES" =~ ^[0-9]+$ ]]; then
  die "EXPECT_MIN_SUMMARIES must be a non-negative integer (got: $EXPECT_MIN_SUMMARIES)"
fi

if ! command -v jq >/dev/null 2>&1; then
  die "jq is required"
fi

if [[ ! -d "$ROOT_DIR" ]]; then
  die "root directory not found: $ROOT_DIR"
fi

mapfile -t summaries < <(find "$ROOT_DIR" -type f -name 'gate-summary.json' | sort)
count="${#summaries[@]}"

if (( count < EXPECT_MIN_SUMMARIES )); then
  die "gate-summary.json count=$count < expected minimum=$EXPECT_MIN_SUMMARIES (root=$ROOT_DIR)"
fi

for summary in "${summaries[@]}"; do
  if ! jq -e '
      (.schemaVersion | type == "number" and (floor == .) and . >= 1) and
      (.generatedAt | type == "string" and length > 0) and
      (.apiBase | type == "string") and
      (.webUrl | type == "string") and
      (.expectProductMode | type == "string" and length > 0) and
      (.exitCode | type == "number") and
      (.gates | type == "object") and
      (.gateReasons | type == "object") and
      (
        [.gates.preflight, .gates.apiSmoke, .gates.provisioning, .gates.playwrightProd, .gates.playwrightDesktop, .gates.playwrightMobile]
        | all(. == "PASS" or . == "FAIL" or . == "SKIP")
      ) and
      (
        [.gateReasons.apiSmoke, .gateReasons.provisioning, .gateReasons.playwrightProd, .gateReasons.playwrightDesktop, .gateReasons.playwrightMobile]
        | all(. == null or (type == "string" and test("^[A-Z0-9_]+$")))
      )
    ' "$summary" >/dev/null; then
    die "invalid gate-summary contract: $summary"
  fi
done

info "OK: validated $count gate-summary.json file(s) under $ROOT_DIR"
