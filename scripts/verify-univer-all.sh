#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

OUTPUT_DIR="${OUTPUT_DIR:-artifacts/univer-poc}"
REPORT_JSON="${REPORT_JSON:-${OUTPUT_DIR}/verify-univer-all.json}"

if [[ "${RUN_WINDOWING:-false}" == "true" ]]; then
  echo "verify-univer-all.sh: RUN_WINDOWING is no longer supported; running Univer UI smoke only." >&2
fi

if [[ "${RUN_EDITABLE_DEMO:-true}" == "false" ]]; then
  echo "verify-univer-all.sh: RUN_EDITABLE_DEMO is no longer supported; running Univer UI smoke only." >&2
fi

echo "verify-univer-all.sh: delegating to scripts/verify-univer-ui-smoke.mjs" >&2

OUTPUT_DIR="$OUTPUT_DIR" REPORT_JSON="$REPORT_JSON" node scripts/verify-univer-ui-smoke.mjs
