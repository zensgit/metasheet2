#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RUN_KIND="${1:-}"
LOG_ROOT="${LOG_ROOT:-${HOME}/Library/Logs/metasheet2/dingtalk-oauth}"
RUN_LOG_DIR="${LOG_ROOT}/runs"
INDEX_FILE="${LOG_ROOT}/index.jsonl"
TIMESTAMP_UTC="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
STAMP_SAFE="$(date -u '+%Y%m%dT%H%M%SZ')"

function die() {
  echo "[dingtalk-oauth-schedule-run] ERROR: $*" >&2
  exit 1
}

function ensure_dir() {
  mkdir -p "$1"
}

function run_stability() {
  bash "${ROOT_DIR}/scripts/ops/dingtalk-oauth-stability-check.sh"
}

function run_drill() {
  JSON_OUTPUT=true bash "${ROOT_DIR}/scripts/ops/dingtalk-onprem-alert-drill.sh"
}

function run_summary() {
  bash "${ROOT_DIR}/scripts/ops/dingtalk-oauth-schedule-summary.sh"
}

[[ -n "${RUN_KIND}" ]] || die "Usage: $0 <stability|drill|summary>"
[[ "${RUN_KIND}" == "stability" || "${RUN_KIND}" == "drill" || "${RUN_KIND}" == "summary" ]] || die "Unknown run kind: ${RUN_KIND}"

ensure_dir "${RUN_LOG_DIR}"

LOG_FILE="${RUN_LOG_DIR}/${RUN_KIND}-${STAMP_SAFE}.log"
TMP_STDOUT="${LOG_FILE}.tmp"

set +e
if [[ "${RUN_KIND}" == "stability" ]]; then
  run_stability >"${TMP_STDOUT}" 2>&1
elif [[ "${RUN_KIND}" == "drill" ]]; then
  run_drill >"${TMP_STDOUT}" 2>&1
else
  run_summary >"${TMP_STDOUT}" 2>&1
fi
EXIT_CODE=$?
set -e

mv "${TMP_STDOUT}" "${LOG_FILE}"

JSON_PAYLOAD="$(python3 - "${RUN_KIND}" "${EXIT_CODE}" "${TIMESTAMP_UTC}" "${LOG_FILE}" <<'PY'
import json
import pathlib
import sys

run_kind = sys.argv[1]
exit_code = int(sys.argv[2])
timestamp = sys.argv[3]
log_file = pathlib.Path(sys.argv[4])
text = log_file.read_text(encoding='utf-8', errors='replace')

record = {
    'kind': run_kind,
    'checkedAt': timestamp,
    'exitCode': exit_code,
    'logFile': str(log_file),
}

if run_kind == 'stability':
    for line in text.splitlines():
        if line.startswith('[oauth-stability] health.status='):
            record['healthLine'] = line
        elif line.startswith('[oauth-stability] webhook.configured='):
            record['webhookLine'] = line
        elif line.startswith('[oauth-stability] alertmanager.activeAlerts='):
            record['alertLine'] = line
        elif line.startswith('[oauth-stability] bridge.notifyEvents='):
            record['bridgeLine'] = line
        elif line.startswith('[oauth-stability] metrics.operations='):
            record['metricsLine'] = line
        elif line.startswith('[oauth-stability] healthy='):
            record['healthy'] = line.split('=', 1)[1].strip()
elif run_kind == 'drill':
    last_json = None
    for line in text.splitlines()[::-1]:
        stripped = line.strip()
        if stripped.startswith('{') and stripped.endswith('}'):
            try:
                last_json = json.loads(stripped)
                break
            except Exception:
                continue
    if last_json:
        record['alertName'] = last_json.get('alertName')
        record['drillId'] = last_json.get('drillId')
        record['firingObserved'] = last_json.get('firingObserved')
        record['resolvedObserved'] = last_json.get('resolvedObserved')
elif run_kind == 'summary':
    last_json = None
    for line in text.splitlines()[::-1]:
        stripped = line.strip()
        if stripped.startswith('{') and stripped.endswith('}'):
            try:
                last_json = json.loads(stripped)
                break
            except Exception:
                continue
    if last_json:
        record['summaryJsonFile'] = last_json.get('summaryJsonFile')
        record['summaryMarkdownFile'] = last_json.get('summaryMarkdownFile')
        record['latestStabilityCheckedAt'] = last_json.get('latestStabilityCheckedAt')
        record['latestDrillCheckedAt'] = last_json.get('latestDrillCheckedAt')
        record['latestDrillId'] = last_json.get('latestDrillId')
        record['healthy'] = last_json.get('healthy')
        record['firingObserved'] = last_json.get('firingObserved')
        record['resolvedObserved'] = last_json.get('resolvedObserved')

print(json.dumps(record, ensure_ascii=False))
PY
)"

printf '%s\n' "${JSON_PAYLOAD}" >> "${INDEX_FILE}"
printf '[dingtalk-oauth-schedule-run] wrote %s\n' "${LOG_FILE}"
printf '%s\n' "${JSON_PAYLOAD}"

exit "${EXIT_CODE}"
