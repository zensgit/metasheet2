#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

ONPREM_GATE_REPORT_JSON="${ONPREM_GATE_REPORT_JSON:-}"
ONPREM_GATE_STAMP="${ONPREM_GATE_STAMP:-}"
RUN_MODE="${RUN_MODE:-local}"

if [[ -z "$ONPREM_GATE_REPORT_JSON" && -n "$ONPREM_GATE_STAMP" ]]; then
  ONPREM_GATE_REPORT_JSON="${ROOT_DIR}/output/releases/multitable-onprem/gates/${ONPREM_GATE_STAMP}/report.json"
fi

if [[ -z "$ONPREM_GATE_REPORT_JSON" ]]; then
  echo "[multitable-pilot-handoff-release-bound] ERROR: set ONPREM_GATE_STAMP or ONPREM_GATE_REPORT_JSON" >&2
  if [[ "${RUN_MODE}" == "staging" ]]; then
    echo "[multitable-pilot-handoff-release-bound] Example: ONPREM_GATE_STAMP=20260323-083713 READINESS_ROOT=/abs/run pnpm prepare:multitable-pilot:handoff:staging:release-bound" >&2
  else
    echo "[multitable-pilot-handoff-release-bound] Example: ONPREM_GATE_STAMP=20260323-083713 READINESS_ROOT=/abs/run pnpm prepare:multitable-pilot:handoff:release-bound" >&2
  fi
  exit 1
fi

if [[ ! -f "$ONPREM_GATE_REPORT_JSON" ]]; then
  echo "[multitable-pilot-handoff-release-bound] ERROR: on-prem gate report not found: ${ONPREM_GATE_REPORT_JSON}" >&2
  exit 1
fi

echo "[multitable-pilot-handoff-release-bound] Using on-prem gate report ${ONPREM_GATE_REPORT_JSON}" >&2
echo "[multitable-pilot-handoff-release-bound] run_mode=${RUN_MODE}" >&2

REQUIRE_ONPREM_GATE=true \
REQUIRE_EXPLICIT_ONPREM_GATE=true \
PILOT_RUN_MODE="${RUN_MODE}" \
ONPREM_GATE_REPORT_JSON="${ONPREM_GATE_REPORT_JSON}" \
node scripts/ops/multitable-pilot-handoff.mjs
